// ABOUTME: 「今日」页：拾贝切出的一天场景时间线，以及串珠按模板整理的结果（只读）。

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileAudio, RefreshCw, Shell, Sparkles } from 'lucide-react';
import type { Scene, SceneDay, SceneTemplate, TemplateField } from '../../contracts/scenes';
import { api } from '../api';
import { formatMs, formatTime, localDayOf } from '../format';
import { buildHash } from '../router';
import { usePolling, useAsyncData } from '../useApi';
import { Button, Empty, ErrorState, IconButton, Loading, useToast } from '../components/ui';
import { ErrorNotice } from '../components/ErrorNotice';

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDayOf(date.toISOString()) ?? day;
}

function busy(day: SceneDay | null): boolean {
  return day?.status === 'queued' || day?.status === 'running';
}

function FieldValue({ field, value }: { field: TemplateField; value: unknown }) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return <p>{value}</p>;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return <ul>
      {value.map((item, index) => {
        if (typeof item === 'string') return <li key={index}>{item}</li>;
        const entries = Object.entries(item as Record<string, unknown>);
        const [, head] = entries[0] ?? [];
        const rest = entries.slice(1).map(([, part]) => (Array.isArray(part) ? part.join(' → ') : String(part ?? ''))).filter(Boolean);
        return <li key={index}><strong>{String(head ?? '')}</strong>{rest.length ? <span className="muted"> · {rest.join(' · ')}</span> : null}</li>;
      })}
    </ul>;
  }
  if (typeof value === 'object' && field.type === 'person_ref') {
    const person = value as { name?: string; role?: string };
    return <p><strong>{person.name}</strong>{person.role ? <span className="muted"> · {person.role}</span> : null}</p>;
  }
  return null;
}

function SceneCard({ scene, template, selected, onSelect }: { scene: Scene; template: SceneTemplate | undefined; selected: boolean; onSelect: () => void }) {
  const fields = template?.fields ?? [];
  const filled = fields.filter((field) => {
    const value = scene.extraction?.fields[field.key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
  return <article id={`scene-${scene.id}`} className={`scene-card${selected ? ' is-selected' : ''}`} aria-label={`场景：${scene.title || scene.sceneType}`} onClick={onSelect}>
    <header className="scene-card__head">
      <span className="scene-card__time">{formatTime(scene.startAt)}–{formatTime(scene.endAt)}</span>
      <span className="scene-pill" style={{ ['--scene-color' as string]: template?.color ?? '#94a3b8' }}>{template?.name ?? scene.templateSlug}</span>
      {scene.sceneType ? <span className="muted">{scene.sceneType}</span> : null}
      <span className="muted scene-card__confidence" title="模板匹配程度">匹配 {Math.round(scene.confidence * 100)}%</span>
    </header>
    <h2>{scene.title || '未命名场景'}</h2>
    {scene.summary ? <p className="scene-card__summary">{scene.summary}</p> : null}
    <div className="scene-card__sources">
      {scene.sources.map((source) => <a key={source.recordingId} href={buildHash({ name: 'detail', id: source.recordingId })}>
        <FileAudio size={14} aria-hidden="true" />{source.title} <span className="muted">{formatMs(source.fromMs)}–{formatMs(source.toMs)}</span>
      </a>)}
    </div>
    {!template?.extract ? <p className="muted">背景片段，只保留转录，串珠不整理。</p>
      : !scene.extraction ? <p className="muted">串珠还没有整理这个场景。</p>
      : scene.extraction.status === 'failed' ? <p className="scene-card__error">串珠没整理好：{scene.extraction.error ?? '未知原因'}</p>
      : filled.length === 0 ? <p className="muted">按「{template.name}」模板没有找到可记录的内容。</p>
      : <dl className="scene-fields">
        {filled.map((field) => <div key={field.key}><dt>{field.label}</dt><dd><FieldValue field={field} value={scene.extraction?.fields[field.key]} /></dd></div>)}
      </dl>}
  </article>;
}

function Timeline({ scenes, templates, selected, onSelect }: { scenes: Scene[]; templates: Map<string, SceneTemplate>; selected: number | null; onSelect: (id: number) => void }) {
  const start = Math.min(...scenes.map((scene) => Date.parse(scene.startAt)));
  const end = Math.max(...scenes.map((scene) => Date.parse(scene.endAt)));
  const span = Math.max(1, end - start);
  return <div className="scene-timeline">
    <ol aria-label="场景时间线">
      {scenes.map((scene) => {
        const left = ((Date.parse(scene.startAt) - start) / span) * 100;
        const width = Math.max(1.5, ((Date.parse(scene.endAt) - Date.parse(scene.startAt)) / span) * 100);
        const template = templates.get(scene.templateSlug);
        return <li key={scene.id} style={{ left: `${Math.min(left, 98.5)}%`, width: `${Math.min(width, 100 - Math.min(left, 98.5))}%` }}>
          <button type="button" aria-pressed={selected === scene.id} style={{ ['--scene-color' as string]: template?.color ?? '#94a3b8' }}
            aria-label={`${formatTime(scene.startAt)} ${scene.title || scene.sceneType}（${template?.name ?? scene.templateSlug}）`}
            title={`${formatTime(scene.startAt)}–${formatTime(scene.endAt)} ${scene.title}`} onClick={() => onSelect(scene.id)} />
        </li>;
      })}
    </ol>
    <div className="scene-timeline__axis muted"><span>{formatTime(new Date(start).toISOString())}</span><span>{formatTime(new Date(end).toISOString())}</span></div>
  </div>;
}

export function TodayPage({ day: focusDay }: { day?: string }) {
  const toast = useToast();
  const today = localDayOf(new Date().toISOString()) ?? '';
  const [day, setDay] = useState(focusDay ?? today);
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const state = useAsyncData<SceneDay>(() => api.get<SceneDay>(`/api/scenes?day=${day}`), `scenes:${day}`);
  const data = state.data?.day === day ? state.data : null;
  usePolling(state.reload, 2600, busy(data));

  useEffect(() => {
    if (focusDay) setDay(focusDay);
  }, [focusDay]);

  const choose = (next: string) => {
    setDay(next);
    setSelected(null);
    window.history.replaceState(null, '', buildHash({ name: 'today', day: next }));
  };
  const select = (id: number) => {
    setSelected(id);
    document.getElementById(`scene-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const rebuild = async () => {
    setSubmitting(true);
    try {
      await api.post('/api/scenes/rebuild', { day });
      toast.push('已交给拾贝和串珠整理', 'success');
      state.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  const templates = new Map((data?.templates ?? []).map((template) => [template.slug, template]));
  const working = busy(data);
  const hasScenes = (data?.scenes.length ?? 0) > 0;
  const label = day === today ? '今天' : day;

  return <div className="page today-page">
    <header className="page__head">
      <div><h1><Shell size={22} aria-hidden="true" /> 今日</h1>
        <p className="page__sub">{label} · 拾贝切场景，串珠按模板整理</p></div>
      <div className="page__actions">
        <IconButton label="前一天" onClick={() => choose(shiftDay(day, -1))}><ChevronLeft size={17} /></IconButton>
        <input aria-label="选择日期" type="date" value={day} onChange={(event) => { if (event.target.value) choose(event.target.value); }} />
        <IconButton label="后一天" onClick={() => choose(shiftDay(day, 1))}><ChevronRight size={17} /></IconButton>
        <Button variant="primary" icon={<Sparkles size={15} />} disabled={submitting || working || !data?.transcribedCount} onClick={() => void rebuild()}>
          {working ? '正在整理' : hasScenes ? '重新整理' : '整理这一天'}
        </Button>
      </div>
    </header>

    {state.error && !data ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
    {!data && !state.error ? <Loading /> : null}
    {data ? <>
      <div className="today-status" role="status">
        {working ? <><RefreshCw size={14} className="spin" aria-hidden="true" /> {data.message ?? '正在整理'}</>
          : data.status === 'done' ? <span>{data.message}</span> : null}
        {data.untranscribedCount > 0 ? <span className="muted">还有 {data.untranscribedCount} 段录音没有转录，转录完成后会自动整理。</span> : null}
        {data.stale && !working ? <span className="today-status__stale">这一天有新的转录，结果可能已过期，点「重新整理」更新。</span> : null}
      </div>
      {data.status === 'failed' && !working ? <ErrorNotice error={{ code: data.errorCode ?? 'INTERNAL_ERROR', message: data.message ?? '整理没有完成' }} onRetry={data.transcribedCount ? () => void rebuild() : undefined} /> : null}
      {hasScenes ? <>
        <Timeline scenes={data.scenes} templates={templates} selected={selected} onSelect={select} />
        <div className="scene-list">
          {data.scenes.map((scene) => <SceneCard key={scene.id} scene={scene} template={templates.get(scene.templateSlug)} selected={selected === scene.id} onSelect={() => setSelected(scene.id)} />)}
        </div>
      </> : working ? null : data.transcribedCount === 0
        ? <Empty title={`${label}还没有转录完成的录音`} description="录音转录完成后，拾贝会自动把这一天切成场景，串珠再按模板整理。" />
        : <Empty title="这一天还没有整理" description={`有 ${data.transcribedCount} 段转录可以整理。`} action={<Button variant="primary" icon={<Sparkles size={15} />} disabled={submitting} onClick={() => void rebuild()}>整理这一天</Button>} />}
    </> : null}
  </div>;
}
