// ABOUTME: 录音详情页：编排元数据、试听、转录、AI 结论与手工整理操作。

import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Check, Download, FileAudio, HardDriveDownload, Pencil, Sparkles, Star, Trash2, Waves } from 'lucide-react';
import type { Category, RecordingDetail } from '../../contracts/app';
import { api, errorText } from '../api';
import { formatBytes, formatDateTime, formatDuration } from '../format';
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
  Tag,
  useToast,
} from '../components/ui';
import { AnalysisView, JobsTable, MetaList, TranscriptSegments } from '../components/recording-parts';

interface Props {
  id: number;
  onBack: () => void;
  onRemoved: () => void;
}

type Tab = 'transcript' | 'analysis' | 'jobs';

export function DetailPage({ id, onBack, onRemoved }: Props) {
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
  const busy = data ? data.recording.status === 'transcribing' || data.recording.status === 'analyzing' : false;
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
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!data) return <Loading />;

  const recording = data.recording;
  const hasTranscript = Boolean(data.transcript?.text);

  const run = async (task: () => Promise<unknown>, successText: string) => {
    setPending(true);
    try {
      await task();
      toast.push(successText, 'success');
      detail.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setPending(false);
    }
  };

  const transcribe = () => void run(() => api.post(`/api/recordings/${id}/transcribe`), '转录任务已排队');
  const organize = () => void run(() => api.post(`/api/recordings/${id}/organize`), '归类任务已排队');
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
          返回录音库
        </Button>
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
          <Button
            variant="primary"
            size="sm"
            icon={<Waves size={14} aria-hidden="true" />}
            disabled={pending || busy || !recording.hasAudioFile}
            title={recording.hasAudioFile ? '用 Host ASR 识别录音内容' : '缺少音频文件'}
            onClick={transcribe}
          >
            {hasTranscript ? '重新转录' : '开始转录'}
          </Button>
          {recording.status === 'pending' && !recording.hasAudioFile ? (
            <Button
              variant="primary"
              size="sm"
              icon={<HardDriveDownload size={14} aria-hidden="true" />}
              disabled={pending || busy}
              onClick={() =>
                void run(
                  () => api.post('/api/device/download', { file: recording.filename, serial: recording.deviceSerial ?? '' }),
                  '已发起拉取，完成后状态会变为待转录',
                )
              }
            >
              从设备拉取音频
            </Button>
          ) : null}
          <Button
            size="sm"
            icon={<Sparkles size={14} aria-hidden="true" />}
            disabled={pending || busy || !hasTranscript}
            title={hasTranscript ? '用 AI 归类并生成摘要' : '需要先完成转录'}
            onClick={organize}
          >
            {data.analysis ? '重新归类' : 'AI 归类'}
          </Button>
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
          <Button
            size="sm"
            icon={<Archive size={14} aria-hidden="true" />}
            onClick={() => patch({ isArchived: !recording.isArchived }, recording.isArchived ? '已取消归档' : '已归档')}
          >
            {recording.isArchived ? '取消归档' : '归档'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
            onClick={() => {
              if (!window.confirm('音频文件会移动到数据目录的 _trash 子目录，确认删除这条记录？')) return;
              void run(async () => {
                await api.remove(`/api/recordings/${id}`);
                onRemoved();
              }, '录音已删除');
            }}
          >
            删除
          </Button>
        </div>
        {exported ? <p className="detail__export">已复制到：{exported}</p> : null}
      </header>

      {busy ? (
        <p className="notice" role="status">
          {recording.status === 'transcribing' ? '正在转录' : '正在归类'}
          {(() => {
            const runningJob = data.jobs.find((job) => job.status === 'running');
            return runningJob?.message ? `：${runningJob.message}` : '，长录音需要几分钟，可以离开此页。';
          })()}
        </p>
      ) : null}

      {!busy && data.lastError ? (
        <div className="alert" role="alert">
          <strong>上次处理未成功：</strong> {data.lastError}
        </div>
      ) : null}

      <div className="detail__grid">
        <div className="detail__main">
          <Card tight>
            {audioBroken ? (
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
                { value: 'jobs', label: `执行记录${data.jobs.length > 0 ? ` ${data.jobs.length}` : ''}` },
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
                      ? '点击「开始转录」，会用本机 ffmpeg 解码后送入语音识别。'
                      : '这条录音缺少音频文件，请先在设备页完成拉取或导入。'
                  }
                  action={
                    <Button size="sm" variant="primary" disabled={pending || busy || !recording.hasAudioFile} onClick={transcribe}>
                      开始转录
                    </Button>
                  }
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
                  description="归类会生成标题、摘要、分类、标签、要点与待办事项。"
                  action={
                    <Button size="sm" variant="primary" disabled={pending || busy || !hasTranscript} onClick={organize}>
                      AI 归类
                    </Button>
                  }
                />
              )}
            </Card>
          ) : null}

          {tab === 'jobs' ? <Card>{data.jobs.length === 0 ? <Empty title="还没有执行记录" /> : <JobsTable jobs={data.jobs} />}</Card> : null}
        </div>

        <aside className="detail__side">
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
