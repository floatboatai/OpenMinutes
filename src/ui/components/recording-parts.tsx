// ABOUTME: 详情页的展示型片段：转录分段、AI 结论、执行记录与元数据。

import type { AnalysisRecord, JobRun, RecordingSummary, TranscriptSegment } from '../../contracts/app';
import { formatDateTime, formatMs } from '../format';

const SENTIMENT_LABEL: Record<string, string> = {
  positive: '积极',
  neutral: '中性',
  negative: '消极',
  mixed: '复杂',
};

/** 播放头落在哪一段：取 startMs 不大于播放头的最靠后一段，不依赖分段是否已排序。 */
function activeSegmentIndex(segments: TranscriptSegment[], currentMs: number | undefined): number {
  if (currentMs === undefined || currentMs <= 0) return -1;
  let active = -1;
  segments.forEach((segment, index) => {
    if (segment.startMs <= currentMs) active = index;
  });
  return active;
}

interface TranscriptSegmentsProps {
  segments: TranscriptSegment[];
  /** 播放头位置（毫秒），用于高亮正在播的那句；不传则只是静态列表。 */
  currentMs?: number;
  /** 传入后每句时标变成可点按钮，点一下定位到该句。 */
  onSeek?: (ms: number) => void;
}

export function TranscriptSegments({ segments, currentMs, onSeek }: TranscriptSegmentsProps) {
  if (segments.length === 0) return <p className="muted">没有可展示的分段</p>;
  const active = activeSegmentIndex(segments, currentMs);
  return (
    <ol className="segments">
      {segments.map((segment, index) => {
        const label = formatMs(segment.startMs || undefined);
        return (
          <li key={`${segment.startMs}-${index}`} className={index === active ? 'segment segment--active' : 'segment'}>
            {onSeek ? (
              <button
                type="button"
                className="segment__time segment__jump"
                onClick={() => onSeek(segment.startMs)}
                title={`从 ${label} 开始播放`}
                aria-label={`从 ${label} 开始播放这一段`}
              >
                {label}
              </button>
            ) : (
              <span className="segment__time">{label}</span>
            )}
            <span className="segment__text">{segment.text}</span>
            {segment.speaker ? <span className="segment__speaker">{segment.speaker}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AnalysisView({ analysis }: { analysis: AnalysisRecord }) {
  return (
    <div className="analysis">
      <div className="analysis__summary">
        <h3>摘要</h3>
        <p>{analysis.summary || '（模型没有返回摘要）'}</p>
      </div>
      <div className="analysis__cols">
        <div>
          <h3>要点</h3>
          {analysis.keyPoints.length === 0 ? (
            <p className="muted">没有提取到要点</p>
          ) : (
            <ul className="bullets">
              {analysis.keyPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>待办事项</h3>
          {analysis.actionItems.length === 0 ? (
            <p className="muted">文本中没有明确的待办</p>
          ) : (
            <ul className="bullets bullets--todo">
              {analysis.actionItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="analysis__meta">
        模型 {analysis.model ?? '未知'} · {formatDateTime(analysis.createdAt)} · 情绪：
        {SENTIMENT_LABEL[analysis.sentiment ?? 'neutral'] ?? '中性'}
      </p>
    </div>
  );
}

const JOB_STATUS: Record<string, string> = {
  running: '执行中',
  success: '成功',
  failure: '失败',
  interrupted: '中断',
};

export function JobsTable({ jobs }: { jobs: JobRun[] }) {
  return (
    <ul className="jobs">
      {jobs.map((job) => (
        <li key={job.id} className={`jobs__row jobs__row--${job.status}`}>
          <span className="jobs__kind">{job.kind === 'transcribe' ? '转录' : '归类'}</span>
          <span className="jobs__status">{JOB_STATUS[job.status] ?? job.status}</span>
          <span className="jobs__message">{job.message ?? '—'}</span>
          <span className="jobs__time">{formatDateTime(job.startedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  folder_import: '目录导入',
  device_manifest: '设备清单',
  device_pull: '设备拉取',
  manual: '手动登记',
  live_caption: '实时字幕',
};

export function MetaList({ recording, storagePath }: { recording: RecordingSummary; storagePath: string | null }) {
  return (
    <dl className="meta">
      <div>
        <dt>来源</dt>
        <dd>{SOURCE_LABEL[recording.source] ?? recording.source}</dd>
      </div>
      <div>
        <dt>设备</dt>
        <dd>{recording.deviceSerial ?? '未关联设备'}</dd>
      </div>
      <div>
        <dt>入库时间</dt>
        <dd>{formatDateTime(recording.createdAt)}</dd>
      </div>
      <div>
        <dt>转写字数</dt>
        <dd>{recording.transcriptChars > 0 ? `${recording.transcriptChars} 字` : '—'}</dd>
      </div>
      <div>
        <dt>音频文件</dt>
        <dd>{storagePath ?? '缺失'}</dd>
      </div>
    </dl>
  );
}
