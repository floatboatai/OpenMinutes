// ABOUTME: 录音笔页：连接/断开、同步、单条同步、停止与清理的唯一入口；不展示任何传输细节。

import type { RecordingListResult, SettingEntry } from '../../contracts/app';
import type { DeviceLastResult, DeviceRecordingOnDevice, DeviceView } from '../../contracts/device';
import { api } from '../api';
import { formatTime } from '../format';
import { useAsyncData } from '../useApi';
import { useDevice } from '../useDevice';
import { ErrorState, Loading, useToast } from '../components/ui';
import { DeviceCard } from '../components/DeviceCard';
import { DeviceRecordingList } from '../components/DeviceRecordingList';
import { EnvironmentBanner } from '../components/EnvironmentBanner';

interface Props {
  envFailCount: number;
  onChanged: () => void;
}

function finishedText(result: DeviceLastResult, autoTranscribe: boolean): { message: string; tone: 'success' | 'info' } | null {
  if (result.origin === 'auto') return null;
  if (result.kind === 'cleanup') {
    return result.done > 0
      ? { message: `已清理 ${result.done} 条，录音笔空间已释放`, tone: 'success' }
      : { message: '没有可以清理的录音', tone: 'info' };
  }
  if (result.cancelled) return { message: `已停止同步${result.done > 0 ? `，已同步 ${result.done} 条录音` : ''}`, tone: 'info' };
  if (result.done > 0) {
    return { message: `已同步 ${result.done} 条录音${autoTranscribe ? '，已开始转录' : ''}`, tone: 'success' };
  }
  if (result.failed === 0) return { message: '录音笔里没有新录音', tone: 'info' };
  return null;
}

function AutoConnectLine({ view }: { view: DeviceView }) {
  const auto = view.autoConnect;
  const last = view.lastResult;
  let text: string;
  if (view.connection.userDisconnected) {
    text = '已手动断开，自动连接暂停。点「连接」恢复。';
  } else if (auto.enabled) {
    text = `自动连接已开启 · 每 ${auto.intervalMinutes} 分钟${auto.nextAttemptAt && view.connection.state === 'disconnected' ? ` · 下次 ${formatTime(auto.nextAttemptAt)}` : ''}`;
  } else {
    text = '自动连接已关闭';
  }
  return (
    <div className="statusline">
      <span>{text}</span>
      {!view.connection.userDisconnected ? (
        <a className="linkbtn" href="#/settings">
          调整
        </a>
      ) : null}
      {last && last.origin === 'auto' && last.kind !== 'cleanup' && (last.done > 0 || last.deferred > 0) ? (
        <span className="statusline__extra">
          {`自动同步了 ${last.done} 条${last.deferred > 0 ? `，另有 ${last.deferred} 条较大的录音等你点「同步录音」` : ''}`}
        </span>
      ) : null}
    </div>
  );
}

export function DevicePage({ envFailCount, onChanged }: Props) {
  const toast = useToast();
  const settings = useAsyncData<SettingEntry[]>(() => api.get<SettingEntry[]>('/api/settings'), 'device-settings');
  const autoTranscribe = settings.data?.find((entry) => entry.key === 'auto_transcribe')?.value === '1';
  const device = useDevice({
    onFinished: (result) => {
      const text = finishedText(result, autoTranscribe);
      if (text) toast.push(text.message, text.tone);
      pendingList.reload();
      onChanged();
    },
    onError: (error) => toast.error(error),
  });
  const view = device.view;
  const revision = `${view?.lastResult?.jobId ?? ''}:${view?.activity ? 'busy' : 'idle'}:${view?.connection.state ?? ''}`;
  const pendingList = useAsyncData<RecordingListResult>(
    () => api.get<RecordingListResult>('/api/recordings?stage=pending&limit=100&sort=recorded'),
    `device-pending:${revision}`,
  );

  if (!view && device.error) return <ErrorState error={device.error} onRetry={device.reload} />;
  if (!view) return <Loading label="正在读取录音笔状态" />;

  const listed = view.cleanable !== null;
  const items: DeviceRecordingOnDevice[] = listed
    ? view.onDevice
    : (pendingList.data?.items ?? []).map((item) => ({
        id: item.id,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        durationSec: item.durationSec,
        recordedAt: item.recordedAt,
      }));
  const state = view.connection.state;
  const blockedReason =
    state === 'live'
      ? '实时字幕进行中，结束后才能同步。'
      : state === 'busy' || view.activity
        ? '正在同步，完成后可以继续。'
        : device.pending !== null
          ? '请稍候…'
          : null;

  return (
    <div className="page page--device">
      <header className="page__head">
        <div>
          <h1>录音笔</h1>
          <p className="page__sub">连上录音笔就会把新录音同步到电脑；用完可以断开，录音笔会更省电。</p>
        </div>
      </header>

      <EnvironmentBanner failCount={Math.max(envFailCount, view.environment.failCount)} />
      {device.error ? <ErrorState error={device.error} onRetry={device.reload} /> : null}
      <DeviceCard device={device} pendingCount={items.length} />
      <AutoConnectLine view={view} />
      <DeviceRecordingList items={items} blockedReason={blockedReason} wifiFromBytes={view.wifiFromBytes} onPull={(id) => void device.pull([id])} />
    </div>
  );
}
