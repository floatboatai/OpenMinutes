// ABOUTME: 录音详情页：试听、转录、AI 结论与手工整理；页头只有一个随状态切换的主按钮。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowLeft, CalendarDays, Check, ChevronDown, Download, FileAudio, Pencil, RotateCcw, Sparkles, Star, Trash2, Waves } from 'lucide-react';
import type { Category, RecordingDetail, RecordingSummary } from '../../contracts/app';
import type { CalendarEvent } from '../../contracts/calendar';
import { isBusyStatus } from '../../contracts/recording-status';
import { api } from '../api';
import { formatBytes, formatDateTime, formatDuration, localDayOf } from '../format';
import { buildHash } from '../router';
import { useAsyncData, usePolling } from '../useApi';
import {
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  IconButton,
  Loading,
  Segmented,
  StatusChip,
  statusLabel,
  Tag,
  useToast,
} from '../components/ui';
import { AnalysisView, JobsTable, MetaList, TranscriptSegments } from '../components/recording-parts';
import { ErrorNotice } from '../components/ErrorNotice';

interface Props {
  id: number;
  backLabel: string;
  onBack: () => void;
  onRemoved: () => void;
}

type Tab = 'transcript' | 'analysis' | 'jobs';

/** 日程区只读：关联只在日历页做，这里只给带上下文的跳转。 */
function CalendarLink({ recording }: { recording: RecordingSummary }) {
  const eventId = recording.calendarEventId;
  const linked = useAsyncData<CalendarEvent | null>(
    () => (eventId ? api.get<CalendarEvent>(`/api/calendar/events/${eventId}`) : Promise.resolve(null)),
    `detail-event:${eventId ?? 0}`,
  );
  const href = buildHash({
    name: 'calendar',
    ...(localDayOf(recording.recordedAt ?? recording.createdAt) ? { day: localDayOf(recording.recordedAt ?? recording.createdAt) ?? undefined } : {}),
    rec: recording.id,
  });
  if (!eventId) {
    return (
      <p className="calendarlink">
        <span className="muted">还没有关联日程。</span>
        <a className="linkbtn" href={href}>
          在日历中关联
        </a>
      </p>
    );
  }
  const event = linked.data;
  return (
    <div className="calendarlink">
      <p className="calendarlink__event">
        <CalendarDays size={14} aria-hidden="true" />
        <strong>{event?.summary ?? '已关联的日程'}</strong>
      </p>
      {event ? <p className="muted">{event.allDay ? `${event.startTime.slice(0, 10)} 全天` : formatDateTime(event.startTime)}</p> : null}
      <a className="linkbtn" href={href}>
        在日历中修改
      </a>
    </div>
  );
}

export function DetailPage({ id, backLabel, onBack, onRemoved }: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('transcript');
  const [plain, setPlain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [audioBroken, setAudioBroken] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);

  const detail = useAsyncData<RecordingDetail>(() => api.get<RecordingDetail>(`/api/recordings/${id}`), `detail:${id}`);
  const categories = useAsyncData<Category[]>(() => api.get<Category[]>('/api/categories'), 'categories');
  const data = detail.data;
  const busy = data ? isBusyStatus(data.recording.status) : false;
  usePolling(detail.reload, 2600, busy);

  useEffect(() => {
    if (data && !editing) setDraftTitle(data.recording.title ?? '');
  }, [data, editing]);

  // 切换录音时播放器实例会被复用，播放头与待定位状态都要归零。
  useEffect(() => {
    setPlayheadMs(0);
    pendingSeekRef.current = null;
    setAudioBroken(false);
  }, [id]);

  if (detail.loading && !data) return <Loading label="正在读取录音详情" />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!data) return <Loading />;

  const recording = data.recording;
  const hasTranscript = Boolean(data.transcript?.text);
  const onDevice = recording.status === 'pending' && !recording.hasAudioFile;
  const title = recording.title || recording.filename;

  const run = async (task: () => Promise<unknown>, successText: string) => {
    setPending(true);
    try {
      await task();
      toast.push(successText, 'success');
      detail.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setPending(false);
    }
  };

  const transcribe = () => void run(() => api.post(`/api/recordings/${id}/transcribe`), '转录任务已排队');
  const organize = () => void run(() => api.post(`/api/recordings/${id}/organize`), '归类任务已排队');

  /** 主动作随状态切换：在录音笔中 → 去同步；待转录 → 开始转录；待归类 → AI 归类；已整理 → 无。 */
  const primary: { label: string; icon: ReactNode; run: () => void } | null = (() => {
    if (busy || onDevice || recording.status === 'organized') return null;
    if (recording.status === 'transcribed' || (recording.status === 'failed' && hasTranscript)) {
      return { label: 'AI 归类', icon: <Sparkles size={14} aria-hidden="true" />, run: organize };
    }
    if (recording.hasAudioFile && !hasTranscript) {
      return { label: '开始转录', icon: <Waves size={14} aria-hidden="true" />, run: transcribe };
    }
    return null;
  })();
  const canRetranscribe = recording.hasAudioFile && hasTranscript && !busy;
  const canReorganize = hasTranscript && Boolean(data.analysis) && !busy;
  const patch = (body: Record<string, unknown>, message: string) =>
    void run(() => api.patch(`/api/recordings/${id}`, body), message);

  /** 点分段时标：定位到该句；暂停时点击本身是用户手势，可以接着起播。 */
  const seekTo = (ms: number) => {
    const audio = audioRef.current;
    const seconds = Math.max(0, ms) / 1000;
    setPlayheadMs(Math.max(0, Math.round(ms)));
    if (!audio) return;
    if (audio.readyState === 0) {
      // 元数据还没到，先记住目标位置，等 loadedmetadata 再定位。
      pendingSeekRef.current = seconds;
      return;
    }
    audio.currentTime = seconds;
    if (audio.paused) void audio.play().catch(() => undefined);
  };

  const saveTitle = () => {
    const value = draftTitle.trim();
    setEditing(false);
    if (value === (recording.title ?? '')) return;
    patch({ title: value }, '标题已更新');
  };

  const addTag = () => {
    const value = tagDraft.trim();
    if (!value) return;
    setTagDraft('');
    patch({ tags: [...recording.tags.map((tag) => tag.name), value] }, `已添加标签「${value}」`);
  };

  return (
    <div className="page page--detail">
      <div className="detail__topbar">
        <Button variant="quiet" size="sm" icon={<ArrowLeft size={15} aria-hidden="true" />} onClick={onBack}>
          {backLabel}
        </Button>
        <nav className="breadcrumb" aria-label="当前位置">
          <a href="#/library">录音</a>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{title}</span>
        </nav>
        <StatusChip status={recording.status} />
      </div>

      <header className="detail__head">
        {editing ? (
          <div className="detail__title-edit">
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveTitle();
                if (event.key === 'Escape') setEditing(false);
              }}
              autoFocus
              aria-label="录音标题"
            />
            <IconButton label="保存标题" onClick={saveTitle}>
              <Check size={16} aria-hidden="true" />
            </IconButton>
          </div>
        ) : (
          <h1 className="detail__title">
            {recording.title || recording.filename}
            <IconButton label="编辑标题" onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden="true" />
            </IconButton>
          </h1>
        )}
        <p className="detail__sub">
          <FileAudio size={13} aria-hidden="true" /> {recording.filename}
          <span className="dot">·</span>
          {formatDuration(recording.durationSec)}
          <span className="dot">·</span>
          {formatBytes(recording.sizeBytes)}
          {recording.recordedAt ? (
            <>
              <span className="dot">·</span>
              {formatDateTime(recording.recordedAt)}
            </>
          ) : null}
        </p>
        <div className="detail__actions">
          {onDevice ? (
            <p className="detail__ondevice">
              这条录音还在录音笔里，同步后即可播放和转录。
              <a className="linkbtn" href="#/device">
                去录音笔同步
              </a>
            </p>
          ) : null}
          {primary ? (
            <Button variant="primary" size="sm" icon={primary.icon} disabled={pending} onClick={primary.run}>
              {primary.label}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={recording.isFavorite ? 'primary' : 'ghost'}
            icon={<Star size={14} aria-hidden="true" />}
            onClick={() => patch({ isFavorite: !recording.isFavorite }, recording.isFavorite ? '已取消收藏' : '已收藏')}
          >
            {recording.isFavorite ? '已收藏' : '收藏'}
          </Button>
          <Button
            size="sm"
            icon={<Download size={14} aria-hidden="true" />}
            disabled={!recording.hasAudioFile}
            onClick={() =>
              void run(async () => {
                const result = await api.post<{ path: string }>(`/api/recordings/${id}/export`);
                setExported(result.path);
              }, '已导出到本机目录')
            }
          >
            导出
          </Button>
          <details className="moremenu">
            <summary className="btn btn--ghost btn--sm">
              <span>更多</span>
              <ChevronDown size={13} aria-hidden="true" />
            </summary>
            <div className="moremenu__list" role="menu">
              {canRetranscribe ? (
                <button type="button" role="menuitem" disabled={pending} onClick={transcribe}>
                  <RotateCcw size={13} aria-hidden="true" /> 重新转录
                </button>
              ) : null}
              {canReorganize ? (
                <button type="button" role="menuitem" disabled={pending} onClick={organize}>
                  <Sparkles size={13} aria-hidden="true" /> 重新归类
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => patch({ isArchived: !recording.isArchived }, recording.isArchived ? '已取消归档' : '已归档')}
              >
                <Archive size={13} aria-hidden="true" /> {recording.isArchived ? '取消归档' : '归档'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="moremenu__danger"
                onClick={() => {
                  if (!window.confirm('音频文件会移到数据目录的回收站，确认删除这条录音？')) return;
                  void run(async () => {
                    await api.remove(`/api/recordings/${id}`);
                    onRemoved();
                  }, '录音已删除');
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> 删除
              </button>
            </div>
          </details>
        </div>
        {exported ? <p className="detail__export">已复制到：{exported}</p> : null}
      </header>

      {busy ? (
        <p className="notice" role="status">
          {statusLabel(recording.status)}
          {(() => {
            if (recording.status === 'queued_transcribe' || recording.status === 'queued_organize') {
              return '，等待前面的任务完成。';
            }
            const runningJob = data.jobs.find((job) => job.status === 'running');
            return runningJob?.message ? `：${runningJob.message}` : '，长录音需要几分钟，可以离开此页。';
          })()}
        </p>
      ) : null}

      {!busy && data.lastError ? (
        <ErrorNotice
          error={{
            code: data.lastErrorCode ?? 'INTERNAL_ERROR',
            message: `上次处理未成功：${data.lastError}`,
            ...(data.lastErrorDetail ? { detail: data.lastErrorDetail } : {}),
          }}
          onRetry={primary?.run}
        />
      ) : null}

      <div className="detail__grid">
        <div className="detail__main">
          <Card tight>
            {!recording.hasAudioFile ? (
              <p className="muted">{onDevice ? '同步到电脑后即可播放。' : '这条录音缺少音频文件。'}</p>
            ) : audioBroken ? (
              <p className="notice">当前环境无法内嵌播放这段音频，请用「导出」交给本机播放器。</p>
            ) : (
              <audio
                ref={audioRef}
                className="player"
                controls
                preload="metadata"
                src={`/api/recordings/${id}/audio`}
                onTimeUpdate={(event) => setPlayheadMs(Math.round(event.currentTarget.currentTime * 1000))}
                onLoadedMetadata={(event) => {
                  const pending = pendingSeekRef.current;
                  if (pending === null) return;
                  pendingSeekRef.current = null;
                  event.currentTarget.currentTime = pending;
                  void event.currentTarget.play().catch(() => undefined);
                }}
                onError={() => setAudioBroken(true)}
              />
            )}
            <p className="player__hint">音频只在本机读取，不会上传；转录在本地解码后送入语音识别。</p>
          </Card>

          <div className="tabs">
            <Segmented
              label="详情分区"
              value={tab}
              options={[
                { value: 'transcript', label: '转录全文' },
                { value: 'analysis', label: 'AI 结论' },
                { value: 'jobs', label: `处理记录${data.jobs.length > 0 ? ` ${data.jobs.length}` : ''}` },
              ]}
              onChange={(value) => setTab(value as Tab)}
            />
            {tab === 'transcript' && hasTranscript ? (
              <label className="switch">
                <input type="checkbox" checked={plain} onChange={(event) => setPlain(event.target.checked)} />
                <span>纯文本</span>
              </label>
            ) : null}
          </div>

          {tab === 'transcript' ? (
            <Card>
              {!hasTranscript ? (
                <Empty
                  title="还没有转录文本"
                  description={
                    recording.hasAudioFile
                      ? '点页面上方的「开始转录」，识别结果会显示在这里。'
                      : onDevice
                        ? '同步到电脑后才能转录。'
                        : '这条录音缺少音频文件。'
                  }
                  action={onDevice ? <a className="linkbtn" href="#/device">去录音笔同步</a> : undefined}
                />
              ) : plain ? (
                <p className="transcript-plain">{data.transcript?.text}</p>
              ) : (
                <TranscriptSegments
                  segments={data.segments}
                  currentMs={playheadMs}
                  onSeek={audioBroken ? undefined : seekTo}
                />
              )}
            </Card>
          ) : null}

          {tab === 'analysis' ? (
            <Card>
              {data.analysis ? (
                <AnalysisView analysis={data.analysis} />
              ) : (
                <Empty
                  title="还没有 AI 归类结果"
                  description={hasTranscript ? '点页面上方的「AI 归类」，会生成标题、摘要、分类、标签、要点与待办事项。' : '转录完成后才能进行 AI 归类。'}
                />
              )}
            </Card>
          ) : null}

          {tab === 'jobs' ? <Card>{data.jobs.length === 0 ? <Empty title="还没有处理记录" /> : <JobsTable jobs={data.jobs} />}</Card> : null}
        </div>

        <aside className="detail__side">
          <Card title="日程">
            <CalendarLink recording={recording} />
          </Card>
          <Card title="整理">
            <Field label="分类">
              <select
                value={recording.categoryId ?? ''}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (value) patch({ categoryId: value }, '分类已更新');
                }}
              >
                <option value="">未分类</option>
                {(categories.data ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="重要度" hint="1 最低，5 最高">
              <div className="importance" role="group" aria-label="重要度">
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`importance__btn${recording.importance !== null && recording.importance >= level ? ' importance__btn--on' : ''}`}
                    aria-label={`重要度 ${level}`}
                    aria-pressed={recording.importance === level}
                    onClick={() => patch({ importance: level }, `重要度设为 ${level}`)}
                  >
                    <Star size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </Field>

            <Field label="标签">
              <div className="taglist">
                {recording.tags.length === 0 ? <span className="muted">暂无标签</span> : null}
                {recording.tags.map((tag) => (
                  <Tag
                    key={tag.id}
                    onRemove={() =>
                      patch({ tags: recording.tags.map((item) => item.name).filter((name) => name !== tag.name) }, '标签已移除')
                    }
                  >
                    {tag.name}
                  </Tag>
                ))}
              </div>
              <div className="taginput">
                <input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addTag();
                  }}
                  placeholder="输入标签后回车"
                  aria-label="添加标签"
                />
                <Button size="sm" onClick={addTag} disabled={!tagDraft.trim()}>
                  添加
                </Button>
              </div>
            </Field>
          </Card>

          <Card title="元数据">
            <MetaList recording={recording} storagePath={data.storagePath} />
          </Card>
        </aside>
      </div>
    </div>
  );
}
