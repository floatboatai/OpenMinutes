// ABOUTME: 录音页：统计条、搜索筛选、批量与「全部」转录/归类，以及「导入」对话框入口。

import { useEffect, useMemo, useState } from 'react';
import { FolderDown, Search, Sparkles, Star, Waves } from 'lucide-react';
import type { BatchResult, Category, Overview, RecordingListResult, RecordingSummary, RevealResult } from '../../contracts/app';
import { api } from '../api';
import { formatDateTime, formatDuration } from '../format';
import { buildHash, type LibraryStage } from '../router';
import { useAsyncData, useDebounced, usePolling } from '../useApi';
import { Button, Empty, ErrorState, Loading, Segmented, StatusChip, Tag, useToast } from '../components/ui';
import { ImportDialog } from '../components/ImportDialog';
import { EnvironmentBanner } from '../components/EnvironmentBanner';

type Stage = 'all' | LibraryStage;

const STAGES: Array<{ value: Stage; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '在录音笔中' },
  { value: 'ready', label: '待转录' },
  { value: 'transcribed', label: '待归类' },
  { value: 'done', label: '已整理' },
  { value: 'failed', label: '失败' },
];

const SORTS = [
  { value: 'newest', label: '最近入库' },
  { value: 'recorded', label: '录音时间' },
  { value: 'duration', label: '时长最长' },
  { value: 'importance', label: '重要度高' },
];

interface Props {
  stage?: LibraryStage;
  overview: Overview | null;
  envFailCount: number;
  onOpen: (id: number) => void;
  onChanged: () => void;
}

function StatsBar({ overview, onFailed }: { overview: Overview | null; onFailed: () => void }) {
  if (!overview) return null;
  const ready = overview.byStatus.find((item) => item.status === 'ready')?.count ?? 0;
  return (
    <div className="statsbar" aria-label="录音统计">
      <span>
        共 <strong>{overview.totalRecordings}</strong> 条
      </span>
      <span>
        累计 <strong>{formatDuration(overview.totalDurationSec)}</strong>
      </span>
      <span>
        待转录 <strong>{ready}</strong>
      </span>
      {overview.failedCount > 0 ? (
        <button type="button" className="statsbar__failed" onClick={onFailed}>
          失败 <strong>{overview.failedCount}</strong>
        </button>
      ) : null}
    </div>
  );
}

export function LibraryPage({ stage: routeStage, overview, envFailCount, onOpen, onChanged }: Props) {
  const [query, setQuery] = useState('');
  const [stage, setStageState] = useState<Stage>(routeStage ?? 'all');
  const [categoryId, setCategoryId] = useState('all');
  const [tag, setTag] = useState('all');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const debouncedQuery = useDebounced(query, 260);
  const toast = useToast();

  // 从统计条或外部链接带着 ?stage= 进来时同步筛选。
  useEffect(() => {
    setStageState(routeStage ?? 'all');
  }, [routeStage]);

  const setStage = (next: Stage) => {
    setStageState(next);
    setSelected([]);
    window.history.replaceState(null, '', buildHash(next === 'all' ? { name: 'library' } : { name: 'library', stage: next }));
  };

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

  const runBatch = async (kind: 'transcribe' | 'organize', body: { ids: number[] } | { stage: 'ready' | 'transcribed' }) => {
    setBusy(true);
    try {
      const result = await api.post<BatchResult>(`/api/recordings/batch/${kind}`, body);
      toast.push(
        result.accepted > 0
          ? `已开始${kind === 'transcribe' ? '转录' : '归类'} ${result.accepted} 条${result.skipped > 0 ? `，${result.skipped} 条不满足条件已跳过` : ''}`
          : '没有可以处理的录音（可能缺少音频或还没转录）',
        result.accepted > 0 ? 'success' : 'info',
      );
      setSelected([]);
      list.reload();
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  // 打开录音所在文件夹的唯一入口；打开方式由设置「打开录音所在文件夹」决定。
  const reveal = async (item: RecordingSummary) => {
    try {
      const result = await api.post<RevealResult>(`/api/recordings/${item.id}/reveal`);
      toast.push(`已${result.mode === 'explorer' ? '在资源管理器中' : '在 Floatboat 中'}打开 ${result.folder}`, 'success');
    } catch (error) {
      toast.error(error);
    }
  };

  const activeFilters = useMemo(
    () => [stage !== 'all', categoryId !== 'all', tag !== 'all', Boolean(debouncedQuery.trim())].filter(Boolean).length,
    [stage, categoryId, tag, debouncedQuery],
  );

  const clearFilters = () => {
    setQuery('');
    setStage('all');
    setCategoryId('all');
    setTag('all');
  };

  const total = list.data?.total ?? 0;
  // 「全部…」由服务端按阶段选录音（不看搜索、分类、标签），所以只在阶段是唯一筛选条件时出现，
  // 数量取服务端同口径的阶段计数（不含已归档，上限 400），保证按钮上的数字就是实际处理的条数。
  const onlyStageFilter = activeFilters === 1 && !query.trim();
  const stageCount = stage === 'ready' || stage === 'transcribed'
    ? Math.min(400, overview?.byStatus.find((item) => item.status === stage)?.count ?? 0)
    : 0;
  const showAll = selected.length === 0 && onlyStageFilter && stageCount > 0;

  return (
    <div className="page page--library">
      <header className="page__head">
        <div>
          <h1>录音</h1>
          <p className="page__sub">
            {list.data ? `当前显示 ${total} 条` : '正在统计'}
            {activeFilters > 0 ? ` · ${activeFilters} 个筛选条件生效` : ''}
          </p>
        </div>
        <div className="page__actions">
          <Button icon={<FolderDown size={15} aria-hidden="true" />} onClick={() => setImporting(true)}>
            导入
          </Button>
        </div>
      </header>

      <EnvironmentBanner failCount={envFailCount} />
      <StatsBar overview={overview} onFailed={() => setStage('failed')} />

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
        <Segmented label="处理阶段" value={stage} options={STAGES} onChange={setStage} />
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
          <Button size="sm" disabled={busy} icon={<Waves size={14} aria-hidden="true" />} onClick={() => void runBatch('transcribe', { ids: selected })}>
            批量转录
          </Button>
          <Button size="sm" disabled={busy} icon={<Sparkles size={14} aria-hidden="true" />} onClick={() => void runBatch('organize', { ids: selected })}>
            批量归类
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setSelected([])}>
            取消选择
          </Button>
        </div>
      ) : null}

      {showAll ? (
        <div className="batchbar" role="region" aria-label="全部处理">
          {stage === 'ready' ? (
            <Button size="sm" variant="primary" disabled={busy} icon={<Waves size={14} aria-hidden="true" />} onClick={() => void runBatch('transcribe', { stage: 'ready' })}>
              全部转录（{stageCount}）
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={busy} icon={<Sparkles size={14} aria-hidden="true" />} onClick={() => void runBatch('organize', { stage: 'transcribed' })}>
              全部归类（{stageCount}）
            </Button>
          )}
        </div>
      ) : null}

      {list.loading && !list.data ? <Loading label="正在读取录音" /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {list.data && items.length === 0 ? (
        activeFilters > 0 ? (
          <Empty
            title="没有符合条件的录音"
            description="试着放宽筛选条件，或清空搜索关键词。"
            action={
              <button type="button" className="linkbtn" onClick={clearFilters}>
                清空筛选
              </button>
            }
          />
        ) : (
          <Empty
            title="还没有录音"
            action={
              <p className="empty__desc">
                连上录音笔后在「<a href="#/device">录音笔</a>」页同步，或点右上角「导入」。
              </p>
            }
          />
        )
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
            <span className="col-location">位置</span>
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
                onReveal={() => void reveal(item)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(result) => {
            if (result.imported > 0) {
              list.reload();
              tags.reload();
              onChanged();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** 过长的文件夹保留末尾（月份目录最有信息量），完整路径放在 title。 */
function shortFolder(label: string, max = 24): string {
  return label.length > max ? `…${label.slice(label.length - max + 1)}` : label;
}

function Row({
  item,
  checked,
  onToggle,
  onOpen,
  onReveal,
}: {
  item: RecordingSummary;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onReveal: () => void;
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
          {item.hasAudioFile || item.status === 'pending' ? '' : ' · 缺音频文件'}
        </span>
      </button>
      <span className="col-location">
        {item.location === 'local' ? (
          <button
            type="button"
            className="location-link"
            title={item.folderPath ? `打开所在文件夹：${item.folderPath}` : '打开所在文件夹'}
            aria-label={`打开所在文件夹${item.folderLabel ? `：${item.folderLabel}` : ''}`}
            onClick={onReveal}
          >
            <span className="location-link__kind">本机</span>
            {item.folderLabel ? <span className="location-link__path">{shortFolder(item.folderLabel)}</span> : null}
          </button>
        ) : item.location === 'device' ? (
          <span className="muted">录音笔</span>
        ) : (
          <span className="muted">—</span>
        )}
      </span>
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
