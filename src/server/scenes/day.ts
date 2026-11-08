// ABOUTME: 按天整理场景：读取当天转录 → 拾贝切场景 → 串珠逐场景抽取 → 落库；以及页面读取的场景日视图。

import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptSegment } from '../../contracts/app';
import { AppError } from '../../contracts/errors';
import { BadInput } from '../../contracts/input';
import type { Scene, SceneDay, SceneDayStatus, SceneExtraction, SceneSource, SceneTemplate } from '../../contracts/scenes';
import { errorMessage } from '../http';
import { enqueue, isRunning, queueSnapshot } from '../queue';
import { nowIso, num, readSetting, row, rows, run, str, strOr } from '../sql';
import { segmentDay, type DraftScene } from './beach';
import { extractScene } from './beads';
import type { SceneHost } from './llm';
import { activeTemplates } from './templates';
import { buildTimeline, type TimelineRecording, type Utterance } from './timeline';

export interface DayRange {
  day: string;
  start: string;
  end: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTERRUPTED = '上次整理因服务重启中断，可以重新整理';

/** 服务端本地时区的自然日；工作台与用户在同一台机器上。 */
export function localDayRange(day: string): DayRange {
  if (!DAY_PATTERN.test(day)) throw new BadInput('日期格式应为 YYYY-MM-DD');
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { day, start: start.toISOString(), end: end.toISOString() };
}

export function localDayOf(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function sceneTaskLabel(day: string): string {
  return `scenes:${day}`;
}

interface DayMaterial {
  recordings: TimelineRecording[];
  versions: Record<string, number>;
  untranscribed: number;
}

function parseSegments(raw: unknown): TranscriptSegment[] {
  try {
    const value: unknown = JSON.parse(strOr(raw, '[]'));
    return Array.isArray(value) ? (value as TranscriptSegment[]).filter((item) => item && typeof item.text === 'string') : [];
  } catch {
    return [];
  }
}

function loadDay(db: DatabaseSync, range: DayRange): DayMaterial {
  const items = rows(
    db,
    `SELECT r.id, r.title, r.filename, r.recorded_at, r.duration_sec, r.transcript_text,
            (SELECT t.id FROM transcripts t WHERE t.recording_id = r.id ORDER BY t.id DESC LIMIT 1) AS transcript_id,
            (SELECT t.segments_json FROM transcripts t WHERE t.recording_id = r.id ORDER BY t.id DESC LIMIT 1) AS segments_json
       FROM recordings r
      WHERE r.recorded_at >= ? AND r.recorded_at < ?
      ORDER BY r.recorded_at, r.id`,
    [range.start, range.end],
  );
  const recordings: TimelineRecording[] = [];
  const versions: Record<string, number> = {};
  let untranscribed = 0;
  for (const item of items) {
    const text = str(item.transcript_text)?.trim() ?? '';
    if (!text) {
      untranscribed += 1;
      continue;
    }
    const id = Number(item.id);
    versions[String(id)] = num(item.transcript_id) ?? 0;
    recordings.push({
      id,
      title: str(item.title) ?? strOr(item.filename, `录音 ${id}`),
      recordedAt: strOr(item.recorded_at, ''),
      durationSec: num(item.duration_sec),
      segments: parseSegments(item.segments_json),
      text,
    });
  }
  return { recordings, versions, untranscribed };
}

function saveDayStatus(db: DatabaseSync, day: string, patch: { status: SceneDayStatus; message: string | null; errorCode?: string | null; versions?: Record<string, number>; engine?: string }): void {
  run(
    db,
    `INSERT INTO scene_days (day, status, message, error_code, source_versions_json, engine, updated_at)
     VALUES (?, ?, ?, ?, COALESCE(?, '{}'), ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       status = excluded.status, message = excluded.message, error_code = excluded.error_code,
       source_versions_json = COALESCE(?, scene_days.source_versions_json),
       engine = COALESCE(excluded.engine, scene_days.engine), updated_at = excluded.updated_at`,
    [
      day, patch.status, patch.message, patch.errorCode ?? null,
      patch.versions ? JSON.stringify(patch.versions) : null, patch.engine ?? null, nowIso(),
      patch.versions ? JSON.stringify(patch.versions) : null,
    ],
  );
}

function utteranceRefs(utterances: Utterance[]): Array<[number, number, number, number]> {
  return utterances.map((utterance) => [utterance.recordingId, utterance.segmentIndex, utterance.startMs, utterance.endMs]);
}

function replaceScenes(db: DatabaseSync, day: string, drafts: DraftScene[], templates: SceneTemplate[]): number[] {
  const versions = new Map(templates.map((template) => [template.slug, template.version]));
  const ids: number[] = [];
  db.exec('BEGIN');
  try {
    run(db, 'DELETE FROM extractions WHERE scene_id IN (SELECT id FROM scenes WHERE day = ?)', [day]);
    run(db, 'DELETE FROM scenes WHERE day = ?', [day]);
    drafts.forEach((draft, seq) => {
      const first = draft.utterances[0];
      const lastEnd = Math.max(...draft.utterances.map((utterance) => utterance.endAt));
      ids.push(run(
        db,
        `INSERT INTO scenes (day, seq, start_at, end_at, utterances_json, scene_type, template_slug, template_version, confidence, title, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          day, seq, new Date(first.at).toISOString(), new Date(lastEnd).toISOString(),
          JSON.stringify(utteranceRefs(draft.utterances)), draft.sceneType, draft.templateSlug,
          versions.get(draft.templateSlug) ?? 1, draft.confidence, draft.title, draft.summary,
        ],
      ).lastId);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return ids;
}

/** 整理一天：失败时保留上一次的场景结果，只把当天状态标为失败。 */
export async function rebuildSceneDay(db: DatabaseSync, host: SceneHost, range: DayRange): Promise<{ scenes: number; extracted: number; failed: number }> {
  const { day } = range;
  saveDayStatus(db, day, { status: 'running', message: '拾贝正在切分场景' });
  try {
    const material = loadDay(db, range);
    const templates = activeTemplates(db);
    const utterances = buildTimeline(material.recordings);
    const drafts = utterances.length > 0 ? await segmentDay(host, utterances, templates) : [];
    const ids = replaceScenes(db, day, drafts, templates);

    let extracted = 0;
    let failed = 0;
    const bySlug = new Map(templates.map((template) => [template.slug, template]));
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      const template = bySlug.get(draft.templateSlug);
      if (!template?.extract) continue;
      saveDayStatus(db, day, { status: 'running', message: `串珠正在整理第 ${index + 1}/${drafts.length} 个场景` });
      try {
        const result = await extractScene(host, template, draft.utterances);
        run(db, `INSERT INTO extractions (scene_id, template_slug, template_version, fields_json, status, model) VALUES (?, ?, ?, ?, 'done', ?)`, [
          ids[index], template.slug, template.version, JSON.stringify(result.fields), result.model,
        ]);
        extracted += 1;
      } catch (error) {
        // 账号或模型不可用时后续场景同样会失败，停止并如实报告。
        if (error instanceof AppError && error.code === 'LLM_UNAVAILABLE') throw error;
        run(db, `INSERT INTO extractions (scene_id, template_slug, template_version, status, error) VALUES (?, ?, ?, 'failed', ?)`, [
          ids[index], template.slug, template.version, errorMessage(error),
        ]);
        failed += 1;
      }
    }
    const message = drafts.length === 0
      ? '这一天还没有可整理的转录'
      : `${drafts.length} 个场景，${extracted} 个已整理${failed ? `，${failed} 个整理失败` : ''}`;
    saveDayStatus(db, day, { status: 'done', message, versions: material.versions, engine: 'builtin-llm' });
    return { scenes: drafts.length, extracted, failed };
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    console.error(`[scenes] ${day} failed: ${code} ${errorMessage(error)}`);
    saveDayStatus(db, day, { status: 'failed', message: errorMessage(error), errorCode: code });
    throw error;
  }
}

/** 排队整理某一天；同一天已在排队（尚未开始）时不重复排。 */
export function scheduleSceneDay(db: DatabaseSync, host: SceneHost, range: DayRange): { queued: boolean } {
  const label = sceneTaskLabel(range.day);
  if (queueSnapshot().filter((item) => item === label).length > (isRunning(label) ? 1 : 0)) return { queued: false };
  saveDayStatus(db, range.day, { status: 'queued', message: '已排队，等待整理' });
  enqueue(label, () => rebuildSceneDay(db, host, range));
  return { queued: true };
}

/** 转录完成后自动整理该录音所在的那一天。 */
export function scheduleScenesForRecording(db: DatabaseSync, host: SceneHost, recordingId: number): void {
  if (readSetting(db, 'scene_bots_enabled', '1') !== '1') return;
  const recordedAt = str(row(db, 'SELECT recorded_at FROM recordings WHERE id = ?', [recordingId])?.recorded_at);
  const day = recordedAt ? localDayOf(recordedAt) : null;
  if (day) scheduleSceneDay(db, host, localDayRange(day));
}

function projectStatus(day: string, stored: string | null): { status: SceneDayStatus; interrupted: boolean } {
  const label = sceneTaskLabel(day);
  if (isRunning(label)) return { status: 'running', interrupted: false };
  if (queueSnapshot().includes(label)) return { status: 'queued', interrupted: false };
  if (stored === 'running' || stored === 'queued') return { status: 'failed', interrupted: true };
  return { status: (stored as SceneDayStatus | null) ?? 'idle', interrupted: false };
}

function readSources(raw: unknown, titles: Map<number, string>): SceneSource[] {
  let refs: Array<[number, number, number, number]> = [];
  try {
    refs = JSON.parse(strOr(raw, '[]')) as typeof refs;
  } catch {
    refs = [];
  }
  const byRecording = new Map<number, SceneSource>();
  for (const [recordingId, , startMs, endMs] of refs) {
    const current = byRecording.get(recordingId);
    if (current) {
      current.fromMs = Math.min(current.fromMs, startMs);
      current.toMs = Math.max(current.toMs, endMs);
    } else {
      byRecording.set(recordingId, { recordingId, title: titles.get(recordingId) ?? `录音 ${recordingId}`, fromMs: startMs, toMs: endMs });
    }
  }
  return [...byRecording.values()];
}

function readExtraction(item: Record<string, unknown> | undefined): SceneExtraction | null {
  if (!item) return null;
  let fields: Record<string, unknown> = {};
  try {
    fields = JSON.parse(strOr(item.fields_json, '{}')) as Record<string, unknown>;
  } catch {
    fields = {};
  }
  return {
    status: strOr(item.status, 'done') === 'failed' ? 'failed' : 'done',
    fields,
    error: str(item.error),
    model: str(item.model),
    engine: strOr(item.engine, 'builtin-llm'),
  };
}

export function getSceneDay(db: DatabaseSync, range: DayRange): SceneDay {
  const { day } = range;
  const stored = row(db, 'SELECT * FROM scene_days WHERE day = ?', [day]);
  const material = loadDay(db, range);
  const projected = projectStatus(day, str(stored?.status));
  let versions: Record<string, number> = {};
  try {
    versions = JSON.parse(strOr(stored?.source_versions_json, '{}')) as Record<string, number>;
  } catch {
    versions = {};
  }
  const stale = projected.status === 'done'
    && JSON.stringify(Object.entries(versions).sort()) !== JSON.stringify(Object.entries(material.versions).sort());
  const titles = new Map(material.recordings.map((recording) => [recording.id, recording.title]));
  const scenes: Scene[] = rows(db, 'SELECT * FROM scenes WHERE day = ? ORDER BY seq', [day]).map((item) => ({
    id: Number(item.id),
    seq: Number(item.seq),
    startAt: strOr(item.start_at, ''),
    endAt: strOr(item.end_at, ''),
    sceneType: strOr(item.scene_type, ''),
    templateSlug: strOr(item.template_slug, ''),
    templateVersion: Number(item.template_version),
    confidence: Number(item.confidence),
    title: strOr(item.title, ''),
    summary: strOr(item.summary, ''),
    sources: readSources(item.utterances_json, titles),
    extraction: readExtraction(row(db, 'SELECT * FROM extractions WHERE scene_id = ? ORDER BY id DESC LIMIT 1', [Number(item.id)])),
  }));
  return {
    day,
    status: projected.status,
    message: projected.interrupted ? INTERRUPTED : str(stored?.message),
    errorCode: projected.interrupted ? 'INTERRUPTED' : str(stored?.error_code),
    updatedAt: str(stored?.updated_at),
    transcribedCount: material.recordings.length,
    untranscribedCount: material.untranscribed,
    stale,
    scenes,
    templates: activeTemplates(db),
  };
}
