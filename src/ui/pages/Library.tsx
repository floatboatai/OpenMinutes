// ABOUTME: 录音库：搜索、筛选、批量转录与批量归类。

import { useMemo, useState } from 'react';
import { Mic, Search, Sparkles, Star, Waves } from 'lucide-react';
import type { Category, RecordingListResult, RecordingSummary } from '../../contracts/app';
import { api, errorText } from '../api';
import { formatDateTime, formatDuration } from '../format';
import { useAsyncData, useDebounced, usePolling } from '../useApi';
import { Button, Empty, ErrorState, Loading, Segmented, StatusChip, Tag, useToast } from '../components/ui';

const STAGES = [
  { value: 'all', label: '全部' },
  { value: 'need-transcribe', label: '待转录' },
  { value: 'need-organize', label: '待归类' },
  { value: 'done', label: '已归档' },
  { value: 'failed', label: '失败' },
] as const;

type Stage = (typeof STAGES)[number]['value'];

const SORTS = [
  { value: 'newest', label: '最近入库' },
  { value: 'recorded', label: '录音时间' },
  { value: 'duration', label: '时长最长' },
  { value: 'importance', label: '重要度高' },
];

interface Props {
  onOpen: (id: number) => void;
  onNavigate: (route: string) => void;
}

export function LibraryPage({ onOpen, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<Stage>('all');
  const [categoryId, setCategoryId] = useState('all');
  const [tag, setTag] = useState('all');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const debouncedQuery = useDebounced(query, 260);
  const toast = useToast();

  const search = new URLSearchParams();
  if (debouncedQuery.trim()) search.set('q', debouncedQuery.trim());
  if (stage !== 'all') search.set('stage', stage);
  if (categoryId !== 'all') search.set('categoryId', categoryId);
  if (tag !== 'all') search.set('tag', tag);
  search.set('sort', sort);
  search.set('limit', '120');
  const queryKey = search.toString();

  const list = useAsyncData<RecordingListResult>(() => api.get<RecordingListResult>(`/api/recordings?${queryKey}`), queryKey);
  usePolling(list.reload, 2600, list.data?.hasActiveTasks ?? false);
  const categories = useAsyncData<Category[]>(() => api.get<Category[]>('/api/categories'), 'categories');
  const tags = useAsyncData<Array<{ name: string; count: number }>>(() => api.get('/api/tags'), 'tags');

  const items = list.data?.items ?? [];
  const allSelected = items.length > 0 && selected.length === items.length;

  const toggle = (id: number) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const runBatch = async (kind: 'transcribe' | 'organize') => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const result = await api.post<{ accepted: number; skipped: number }>(`/api/recordings/batch/${kind}`, {
        ids: selected,
      });
      toast.push(
        result.accepted > 0
          ? `已排队 ${result.accepted} 条${kind === 'transcribe' ? '转录' : '归类'}任务${result.skipped > 0 ? `，${result.skipped} 条被跳过` : ''}`
          : '没有可处理的录音（可能缺少音频或不满足条件）',
        result.accepted > 0 ? 'success' : 'info',
      );
      setSelected([]);
      list.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const activeFilters = useMemo(
    () => [stage !== 'all', categoryId !== 'all', tag !== 'all', Boolean(debouncedQuery.trim())].filter(Boolean).length,
    [stage, categoryId, tag, debouncedQuery],
  );

  return (
    <div className="page page--library">
      <header className="page__head">
        <div>
          <h1>录音库</h1>
          <p className="page__sub">
            {list.data ? `命中 ${list.data.total} 条录音` : '正在统计'}
            {activeFilters > 0 ? ` · ${activeFilters} 个筛选条件生效` : ''}
          </p>
        </div>
        <div className="page__actions">
          <Button icon={<Mic size={15} aria-hidden="true" />} onClick={() => onNavigate('device')}>
            导入新录音
          </Button>
        </div>
      </header>

      <div className="toolbar">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索标题、摘要或转录全文"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索录音"
          />
        </div>
        <Segmented label="处理阶段" value={stage} options={STAGES.map((item) => ({ ...item }))} onChange={(value) => setStage(value as Stage)} />
        <div className="toolbar__selects">
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="按分类筛选">
            <option value="all">全部分类</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}（{category.recordingCount}）
              </option>
            ))}
          </select>
          <select value={tag} onChange={(event) => setTag(event.target.value)} aria-label="按标签筛选">
            <option value="all">全部标签</option>
            {(tags.data ?? []).map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}（{item.count}）
              </option>
            ))}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序方式">
            {SORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selected.length > 0 ? (
        <div className="batchbar" role="region" aria-label="批量操作">
          <span>已选 {selected.length} 条</span>
          <Button size="sm" disabled={busy} icon={<Waves size={14} aria-hidden="true" />} onClick={() => void runBatch('transcribe')}>
            批量转录
          </Button>
          <Button size="sm" disabled={busy} icon={<Sparkles size={14} aria-hidden="true" />} onClick={() => void runBatch('organize')}>
            批量归类
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setSelected([])}>
            取消选择
          </Button>
        </div>
      ) : null}

      {list.loading && !list.data ? <Loading label="正在读取录音" /> : null}
      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : null}

      {list.data && items.length === 0 ? (
        <Empty
          title={activeFilters > 0 ? '没有符合条件的录音' : '录音库还是空的'}
          description={
            activeFilters > 0
              ? '试着放宽筛选条件，或清空搜索关键词。'
              : '先到设备页扫描导入目录或从录音笔拉取文件清单。'
          }
          action={
            activeFilters > 0 ? (
              <Button
                size="sm"
                onClick={() => {
                  setQuery('');
                  setStage('all');
                  setCategoryId('all');
                  setTag('all');
                }}
              >
                清空筛选
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => onNavigate('device')}>
                去导入录音
              </Button>
            )
          }
        />
      ) : null}

      {items.length > 0 ? (
        <div className="table">
          <div className="table__head">
            <span className="table__check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
                aria-label="全选当前页"
              />
            </span>
            <span>录音</span>
            <span className="col-category">分类</span>
            <span className="col-tags">标签</span>
            <span className="col-duration">时长</span>
            <span className="col-status">状态</span>
            <span className="col-star" />
          </div>
          <ul className="table__body">
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                checked={selected.includes(item.id)}
                onToggle={() => toggle(item.id)}
                onOpen={() => onOpen(item.id)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  item,
  checked,
  onToggle,
  onOpen,
}: {
  item: RecordingSummary;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <li className={`row${checked ? ' row--checked' : ''}`}>
      <span className="table__check">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`选择 ${item.title || item.filename}`} />
      </span>
      <button type="button" className="row__main" onClick={onOpen}>
        <span className="row__title">
          {item.title || item.filename}
          {item.importance !== null && item.importance >= 4 ? <span className="row__hot">重要</span> : null}
        </span>
        <span className="row__meta">
          {formatDateTime(item.recordedAt ?? item.createdAt)}
          {item.transcriptChars > 0 ? ` · ${item.transcriptChars} 字转写` : ''}
          {item.hasAudioFile ? '' : ' · 缺音频文件'}
        </span>
      </button>
      <span className="col-category">
        {item.categoryName ? (
          <span className="category-inline">
            <span className="category-inline__dot" style={{ background: item.categoryColor ?? '#64748b' }} aria-hidden="true" />
            {item.categoryName}
          </span>
        ) : (
          <span className="muted">未分类</span>
        )}
      </span>
      <span className="col-tags">
        {item.tags.slice(0, 2).map((tag) => (
          <Tag key={tag.id}>{tag.name}</Tag>
        ))}
        {item.tags.length > 2 ? <span className="muted">+{item.tags.length - 2}</span> : null}
      </span>
      <span className="col-duration">{formatDuration(item.durationSec)}</span>
      <span className="col-status">
        <StatusChip status={item.status} />
      </span>
      <span className="col-star">{item.isFavorite ? <Star size={14} className="star-on" aria-label="已收藏" /> : null}</span>
    </li>
  );
}
