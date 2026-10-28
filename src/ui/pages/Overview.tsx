// ABOUTME: 概览页：设备连接状态、录音总览、分类分布与最近入库。

import { useState, type ReactNode } from 'react';
import { ArrowRight, Clock, FolderDown, HardDriveDownload, Layers, Mic, Sparkles } from 'lucide-react';
import type { BridgeRunResult, DeviceStatus, Overview } from '../../contracts/app';
import { api, errorText } from '../api';
import { formatDateTime, formatDuration } from '../format';
import { useAsyncData, usePolling } from '../useApi';
import { Button, Card, Empty, ErrorState, Loading, StatusChip, useToast } from '../components/ui';
import { DeviceHeroCard } from '../components/DeviceHero';

interface Props {
  onOpen: (id: number) => void;
  onNavigate: (route: string) => void;
}

function Stat({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__icon" aria-hidden="true">{icon}</span>
      <span className="stat__label">{label}</span>
      <strong className="stat__value">{value}</strong>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}

export function OverviewPage({ onOpen, onNavigate }: Props) {
  const toast = useToast();
  const state = useAsyncData<Overview>(() => api.get<Overview>('/api/overview'), 'overview');
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // 自动重连可能在任何时刻接上设备，首页保持轻量轮询让状态自动翻新。
  usePolling(state.reload, 20000, true);

  /** 首页直接连接设备：不跳转，连上后原地刷新成仪表状态。 */
  const connectDevice = async (mode: 'connect' | 'refresh') => {
    const setBusy = mode === 'connect' ? setConnecting : setRefreshing;
    setBusy(true);
    try {
      const result = await api.post<{ result: BridgeRunResult; device: DeviceStatus | null }>('/api/device/status', {});
      if (result.device) {
        toast.push(mode === 'connect' ? `已连接 ${result.device.serial ?? '录音笔'}` : `已刷新 ${result.device.serial ?? '设备'} 状态`, 'success');
        state.reload();
      } else {
        toast.push(result.result?.message ?? '没有读到设备状态，请确认录音笔已唤醒', 'error');
      }
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (state.loading && !state.data) return <Loading label="正在读取录音概览" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  const data = state.data;
  if (!data) return <Loading />;

  const device = data.device;
  const connected = Boolean(device?.connected);
  const untranscribed = data.byStatus
    .filter((item) => item.status === 'pending' || item.status === 'ready')
    .reduce((sum, item) => sum + item.count, 0);
  const totalFiles = Math.max(data.totalRecordings, 1);

  const subtitle = (() => {
    if (connected) {
      const parts = [`已连接 ${device?.model ?? '录音笔'}`];
      if (device && device.pendingPulls > 0) parts.push(`卡里还有 ${device.pendingPulls} 条待拉取`);
      if (data.totalRecordings > 0) parts.push(`库里 ${data.totalRecordings} 条录音，累计 ${formatDuration(data.totalDurationSec)}`);
      return `${parts.join('，')}。`;
    }
    if (data.totalRecordings === 0) {
      return '还没有录音入库。先连接录音笔或指定一个导入目录，就能开始转录与归类。';
    }
    return `共 ${data.totalRecordings} 条录音，累计 ${formatDuration(data.totalDurationSec)}。`;
  })();

  return (
    <div className="page page--overview">
      <header className="page__head">
        <div>
          <h1>录音概览</h1>
          <p className="page__sub">{subtitle}</p>
        </div>
        <div className="page__actions">
          <Button icon={<FolderDown size={15} aria-hidden="true" />} onClick={() => onNavigate('device')}>
            导入录音
          </Button>
          {connected ? (
            <span className="page__status">
              <span className="pulse" aria-hidden="true" />
              设备已连接
            </span>
          ) : null}
        </div>
      </header>

      <DeviceHeroCard
        device={device}
        refreshing={refreshing}
        connecting={connecting}
        onConnect={() => void connectDevice('connect')}
        onRefresh={() => void connectDevice('refresh')}
        onNavigate={onNavigate}
      />

      <div className="stat-row">
        <Stat label="录音总数" value={String(data.totalRecordings)} icon={<Mic size={16} />} hint={`${data.favoriteCount} 条收藏`} />
        <Stat label="累计时长" value={formatDuration(data.totalDurationSec)} icon={<Clock size={16} />} hint="全部录音合计" />
        <Stat label="已转录" value={String(data.transcribedCount)} icon={<Layers size={16} />} hint={`${untranscribed} 条待转录`} />
        <Stat label="已归类" value={String(data.organizedCount)} icon={<Sparkles size={16} />} hint={`${data.unreviewedToday} 条今日待处理`} />
      </div>

      <div className="overview-grid">
        <Card
          title="分类分布"
          action={
            <Button size="sm" variant="quiet" onClick={() => onNavigate('categories')}>
              管理分类
            </Button>
          }
        >
          {data.byCategory.length === 0 ? (
            <Empty title="还没有分类数据" />
          ) : (
            <ul className="bars">
              {data.byCategory.map((item) => (
                <li key={item.id} className="bars__row">
                  <span className="bars__name">
                    <span className="bars__dot" style={{ background: item.color }} aria-hidden="true" />
                    {item.name}
                  </span>
                  <span className="bars__track">
                    <span
                      className="bars__fill"
                      style={{ width: `${Math.round((item.count / totalFiles) * 100)}%`, background: item.color }}
                    />
                  </span>
                  <span className="bars__value">{item.count}</span>
                  <span className="bars__meta">{formatDuration(item.durationSec)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="最近入库"
          action={
            <Button size="sm" variant="quiet" icon={<ArrowRight size={14} aria-hidden="true" />} onClick={() => onNavigate('library')}>
              全部录音
            </Button>
          }
        >
          {data.recent.length === 0 ? (
            <Empty
              title="还没有录音"
              description={connected ? '设备已连接，去「设备接入」读取清单并拉取录音。' : '连接录音笔拉取，或扫描本地导入目录。'}
              action={
                <Button size="sm" icon={<HardDriveDownload size={14} aria-hidden="true" />} onClick={() => onNavigate('device')}>
                  去读取清单
                </Button>
              }
            />
          ) : (
            <ul className="recent">
              {data.recent.map((item) => (
                <li key={item.id}>
                  <button type="button" className="recent__item" onClick={() => onOpen(item.id)}>
                    <span className="recent__main">
                      <span className="recent__title">{item.title || item.filename}</span>
                      <span className="recent__meta">
                        {formatDateTime(item.recordedAt ?? item.createdAt)} · {formatDuration(item.durationSec)}
                        {item.categoryName ? ` · ${item.categoryName}` : ''}
                      </span>
                    </span>
                    <StatusChip status={item.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {data.failedCount > 0 ? (
        <Card title="需要注意">
          <p className="notice">
            有 {data.failedCount} 条录音处理失败，通常是音频文件缺失或识别中断。打开录音查看原因后可以重试。
          </p>
          <Button size="sm" onClick={() => onNavigate('library')}>
            查看失败录音
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
