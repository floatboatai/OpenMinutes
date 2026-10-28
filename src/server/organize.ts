// ABOUTME: 调用 Host LLM 对转录文本做结构化归类，并把结论写回录音记录。

import type { DatabaseSync } from 'node:sqlite';
import type { HostClient } from '../../sdk/host.mjs';
import { listCategories } from './repo';
import { num, nowIso, row, run, syncTags } from './sql';

export class OrganizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrganizeError';
    this.code = code;
  }
}

export interface OrganizeResult {
  model: string | null;
  title: string;
  summary: string;
  categorySlug: string;
  tags: string[];
  keyPoints: string[];
  actionItems: string[];
  importance: number;
  sentiment: string;
}

const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildSchema(slugs: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'categorySlug', 'tags', 'keyPoints', 'actionItems', 'importance', 'sentiment'],
    properties: {
      title: { type: 'string', description: '不超过 20 个汉字的标题' },
      summary: { type: 'string', description: '2~4 句话的摘要' },
      categorySlug: { type: 'string', enum: slugs },
      tags: { type: 'array', items: { type: 'string' } },
      keyPoints: { type: 'array', items: { type: 'string' } },
      actionItems: { type: 'array', items: { type: 'string' } },
      importance: { type: 'integer' },
      sentiment: { type: 'string', enum: [...SENTIMENTS] },
    },
  };
}

const SYSTEM_PROMPT = [
  '你是中文录音助理，负责把一段录音转写文本整理成可检索的知识条目。',
  '只依据文本内容判断，不要编造文本里没有的人名、数字或结论。',
  '如果文本是零散口语或信息量很低，就把 importance 给低分，并在 summary 里如实说明。',
  'tags 使用简短名词（2~6 个字），不要带 # 号，不要重复分类名。',
  'actionItems 只写文本中明确出现的待办、承诺或后续动作；没有就返回空数组。',
  'categorySlug 必须从给定枚举中选择最贴切的一个。',
].join('\n');


const JSON_ONLY = '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。';

/** 从自由文本里取出第一个完整 JSON 对象，容忍代码块包裹。 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface StructuredResult {
  object: unknown;
  model: string | null;
}

/**
 * 优先用结构化输出；当服务端拒绝该 JSON Schema 时退回文本生成，
 * 由本地做 JSON 抽取与字段收敛，避免整条归类任务因输出格式失败。
 */
async function requestStructured(host: HostClient, prompt: string, schema: Record<string, unknown>): Promise<StructuredResult> {
  try {
    const response = await host.llm.generateObject({ prompt, system: SYSTEM_PROMPT, temperature: 0.2, schema });
    const object: unknown = response.object;
    if (object !== null && typeof object === 'object') return { object, model: response.model ?? null };
  } catch {
    // 继续尝试文本回退
  }
  const fallback = await host.llm.generateText({
    prompt: `${prompt}

请按以下字段输出：title、summary、categorySlug、tags、keyPoints、actionItems、importance、sentiment。${JSON_ONLY}`,
    system: SYSTEM_PROMPT,
    temperature: 0.2,
  });
  const parsed = extractJsonObject(fallback.text);
  if (parsed === null || typeof parsed !== 'object') {
    throw new OrganizeError('LLM_OBJECT_INVALID', '模型没有返回可解析的结构化结果，请稍后重试');
  }
  return { object: parsed, model: fallback.model ?? null };
}

export function buildPrompt(input: {
  transcript: string;
  filename: string;
  durationSec: number | null;
  categories: Array<{ slug: string; name: string; description: string | null }>;
}): string {
  const categoryLines = input.categories
    .map((category) => `- ${category.slug}（${category.name}）：${category.description ?? '无说明'}`)
    .join('\n');
  const transcript = input.transcript.length > 12000 ? `${input.transcript.slice(0, 12000)}\n…（后文已截断）` : input.transcript;
  const minutes = input.durationSec ? Math.max(1, Math.round(input.durationSec / 60)) : null;
  return [
    `文件名：${input.filename}`,
    minutes ? `录音时长：约 ${minutes} 分钟` : null,
    '',
    '可选分类：',
    categoryLines,
    '',
    '转写文本：',
    '"""',
    transcript,
    '"""',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 执行一次结构化归类并落库；返回本次 AI 结论。 */
export async function organizeRecording(
  db: DatabaseSync,
  host: HostClient,
  recordingId: number,
): Promise<OrganizeResult> {
  const recording = row(
    db,
    'SELECT id, filename, duration_sec, transcript_text, title FROM recordings WHERE id = ?',
    [recordingId],
  );
  if (!recording) throw new OrganizeError('NOT_FOUND', '录音不存在');
  const transcriptText = typeof recording.transcript_text === 'string' ? recording.transcript_text.trim() : '';
  if (!transcriptText) throw new OrganizeError('NO_TRANSCRIPT', '还没有转写文本，请先完成转录');

  const categories = listCategories(db);
  const prompt = buildPrompt({
    transcript: transcriptText,
    filename: typeof recording.filename === 'string' ? recording.filename : '未命名录音',
    durationSec: num(recording.duration_sec),
    categories: categories.map((category) => ({
      slug: category.slug,
      name: category.name,
      description: category.description,
    })),
  });

  const response = await requestStructured(host, prompt, buildSchema(categories.map((category) => category.slug)));
  const raw: unknown = response.object;
  if (raw === null || typeof raw !== 'object') throw new OrganizeError('BAD_MODEL_OUTPUT', '模型返回结构不符合预期');
  const payload = raw as Record<string, unknown>;

  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 60) : '未命名录音';
  const summary = typeof payload.summary === 'string' ? payload.summary.trim().slice(0, 600) : '';
  const requestedSlug = typeof payload.categorySlug === 'string' ? payload.categorySlug : '';
  const matched = categories.find((category) => category.slug === requestedSlug);
  const fallback = categories.find((category) => category.slug === 'uncategorized') ?? categories[0];
  const category = matched ?? fallback;
  const importanceRaw = num(payload.importance);
  const importance = importanceRaw === null ? 3 : Math.min(5, Math.max(1, Math.round(importanceRaw)));
  const sentiment = typeof payload.sentiment === 'string' && (SENTIMENTS as readonly string[]).includes(payload.sentiment)
    ? payload.sentiment
    : 'neutral';
  const tags = asStringArray(payload.tags, 6);
  const keyPoints = asStringArray(payload.keyPoints, 8);
  const actionItems = asStringArray(payload.actionItems, 8);
  const result: OrganizeResult = {
    model: response.model,
    title,
    summary,
    categorySlug: category?.slug ?? 'uncategorized',
    tags,
    keyPoints,
    actionItems,
    importance,
    sentiment,
  };

  run(
    db,
    `INSERT INTO analyses (recording_id, model, title, summary, category_slug, key_points_json,
       action_items_json, tags_json, importance, sentiment, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      recordingId,
      result.model,
      result.title,
      result.summary,
      result.categorySlug,
      JSON.stringify(result.keyPoints),
      JSON.stringify(result.actionItems),
      JSON.stringify(result.tags),
      result.importance,
      result.sentiment,
      JSON.stringify(payload).slice(0, 20000),
      nowIso(),
    ],
  );

  const existingTitle = typeof recording.title === 'string' ? recording.title.trim() : '';
  run(
    db,
    `UPDATE recordings
        SET title = ?, summary = ?, category_id = ?, importance = ?, sentiment = ?,
            status = 'organized', last_error = NULL, updated_at = ?
      WHERE id = ?`,
    [
      existingTitle || result.title,
      result.summary,
      category?.id ?? null,
      result.importance,
      result.sentiment,
      nowIso(),
      recordingId,
    ],
  );
  syncTags(db, recordingId, tags, 'ai');

  return result;
}
