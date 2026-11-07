// ABOUTME: 录音笔卡片：连接/断开、电量与空间、同步（进度、停止）与清理已同步的录音，全部在这一处。

import { BatteryCharging, Bluetooth, Loader2, PlugZap, RefreshCw, Square, Trash2, Unplug, Usb } from 'lucide-react';
import type { DeviceActivity, DeviceView } from '../../contracts/device';
import { formatBytes, formatTime, relativeTime } from '../format';
import type { DeviceHook } from '../useDevice';
import { ErrorNotice } from './ErrorNotice';
import { Button } from './ui';

function level(pct: number | null, thresholds: [number, number]): 'good' | 'warn' | 'low' {
  if (pct === null) return 'low';
  if (pct >= thresholds[0]) return 'good';
  if (pct >= thresholds[1]) return 'warn';
  return 'low';
}

function Ring({ pct, label, tone }: { pct: number | null; label: string; tone: 'good' | 'warn' | 'low' }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const value = Math.min(100, Math.max(0, pct ?? 0));
  const offset = circumference - (circumference * value) / 100;
  return (
    <div className={`ring ring--${tone}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="ring__track" cx="50" cy="50" r={radius} />
        <circle
          className="ring__value"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="ring__label">
        <strong>{pct === null ? '--' : pct}</strong>
        <em>%</em>
        <span className="ring__caption">{label}</span>
      </span>
    </div>
  );
}

/** 断开后的灰字说明：休眠、空闲断开都不是错误。 */
function offlineLine(view: DeviceView): string {
  const lastSeen = view.device?.lastSeenAt ? `上次在线 ${formatTime(view.device.lastSeenAt)}` : '';
  switch (view.connection.disconnectReason) {
    case 'user':
      return '已断开连接。';
    case 'idle':
      return '空闲 10 分钟，已自动断开以节省录音笔电量。';
    case 'device_sleep':
    case 'lost':
      return '录音笔已休眠或离开范围。';
    case 'live':
      return '实时字幕结束后会恢复连接。';
    default:
      return lastSeen ? `${lastSeen}。` : '唤醒录音笔并放在电脑旁边，点「连接」。';
  }
}

const PHASE_TEXT: Record<DeviceActivity['phase'], string> = {
  connecting: '正在连接录音笔',
  listing: '正在查看录音笔里的录音',
  'waiting-network': '等待当前转录完成',
  preparing: '正在准备无线快传（暂时断开外网）',
  transferring: '正在传输',
  restoring: '正在恢复网络',
  finishing: '正在保存到录音库',
  deleting: '正在从录音笔删除',
};

function phaseText(activity: DeviceActivity): string {
  if (activity.phase === 'transferring' && activity.offline) return '无线快传中（暂时断开外网）';
  return PHASE_TEXT[activity.phase];
}

function progressPct(activity: DeviceActivity): number | null {
  if (!activity.bytesTotal || activity.bytesTotal <= 0) return null;
  return Math.min(100, Math.round((activity.bytesDone / activity.bytesTotal) * 100));
}

function Progress({ activity, onCancel, cancelling }: { activity: DeviceActivity; onCancel: () => void; cancelling: boolean }) {
  const pct = progressPct(activity);
  const title =
    activity.kind === 'cleanup'
      ? '正在清理已同步的录音'
      : `正在同步${activity.count > 0 ? ` ${Math.max(1, activity.index)}/${activity.count}` : ''}${pct !== null ? ` · ${pct}%` : ''}`;
  return (
    <div className="devicecard__progress" role="status" aria-live="polite">
      <div className="devicecard__progresshead">
        <strong>{title}</strong>
        <Button
          size="sm"
          variant="quiet"
          icon={<Square size={13} aria-hidden="true" />}
          disabled={cancelling || activity.cancelling}
          onClick={onCancel}
        >
          {activity.cancelling ? '正在停止…' : '停止'}
        </Button>
      </div>
      <div className="progressbar" aria-hidden="true">
        <span className={`progressbar__fill${pct === null ? ' progressbar__fill--indeterminate' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <p className="devicecard__phase">{phaseText(activity)}</p>
    </div>
  );
}

interface Props {
  device: DeviceHook;
  /** 还没读过清单时用库里的待同步条数估算。 */
  pendingCount: number;
}

export function DeviceCard({ device, pendingCount }: Props) {
  const view = device.view;
  if (!view) return null;
  const { state } = view.connection;
  const info = view.device;
  const fallback = view.activity?.fallback ?? (state === 'connected' ? view.lastResult?.fallback ?? null : null);
  const listed = view.cleanable !== null;
  const onDeviceCount = listed ? view.onDevice.length : pendingCount;
  const lastError = view.lastError ?? (state === 'connected' ? view.lastResult?.error ?? null : null);

  if (state === 'disconnected' || state === 'connecting') {
    const connecting = state === 'connecting' || device.pending === 'connect';
    // 点「连接」会直接开始同步：断网提示必须在点之前就能看到。
    const offlineHint = !connecting && view.autoConnect.syncOnConnect && view.syncPlan?.willGoOffline;
    return (
      <section className="devicehero devicehero--off devicecard">
        <div className="devicehero__offmain">
          <span className="devicehero__officon" aria-hidden="true">
            <Bluetooth size={22} />
          </span>
          <div className="devicehero__offtext">
            <h2>{connecting ? '正在连接录音笔…' : '录音笔未连接'}</h2>
            <p className="muted">{connecting ? '请保持录音笔在电脑旁边。' : offlineLine(view)}</p>
          </div>
        </div>
        <div className="devicecard__primary devicecard__primary--off">
          <Button
            variant="primary"
            icon={connecting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}
            disabled={connecting}
            onClick={() => void device.connect()}
          >
            {connecting ? '正在连接…' : '连接'}
          </Button>
          {offlineHint ? (
            <span className="devicecard__hint">连上后会自动同步，较大的录音将通过无线快传，期间电脑会暂时断开外网</span>
          ) : null}
        </div>
        {lastError && !connecting ? (
          <div className="devicecard__notice">
            <ErrorNotice error={lastError} />
          </div>
        ) : null}
      </section>
    );
  }

  if (state === 'live') {
    return (
      <section className="devicehero devicehero--off devicecard">
        <div className="devicehero__offmain">
          <span className="devicehero__officon" aria-hidden="true">
            <Bluetooth size={22} />
          </span>
          <div className="devicehero__offtext">
            <h2>实时字幕正在使用录音笔</h2>
            <p className="muted">实时字幕进行时无法同步录音，结束后会恢复连接。</p>
          </div>
        </div>
        <a className="linkbtn" href="#/live">
          去实时字幕
        </a>
      </section>
    );
  }

  const busy = state === 'busy' || Boolean(view.activity);
  const syncLabel = onDeviceCount > 0 ? `同步录音（${onDeviceCount}）` : listed ? '检查新录音' : '同步录音';
  const cleanable = view.cleanable && view.cleanable.count > 0 ? view.cleanable : null;

  const confirmCleanup = () => {
    if (!cleanable) return;
    if (!window.confirm(`从录音笔删除 ${cleanable.count} 条已经同步到电脑的录音（${formatBytes(cleanable.bytes)}）？电脑上的录音不受影响，录音笔上的删除不可恢复。`)) return;
    void device.cleanup();
  };

  return (
    <section className="devicehero devicehero--on devicecard">
      <div className="devicehero__aurora" aria-hidden="true" />
      <div className="devicehero__meters">
        <Ring pct={info?.batteryPct ?? null} label="电量" tone={level(info?.batteryPct ?? null, [50, 20])} />
        <Ring pct={info?.freeSpacePct ?? null} label="剩余" tone={level(info?.freeSpacePct ?? null, [30, 10])} />
      </div>

      <div className="devicehero__info">
        <div className="devicehero__title">
          <h2>{info?.model ?? '录音笔'}</h2>
          <span className="devicehero__online">
            <span className="pulse" aria-hidden="true" />
            已连接{info?.lastSeenAt ? ` · ${relativeTime(info.lastSeenAt)}` : ''}
          </span>
        </div>
        <p className="devicehero__meta">
          {info?.serial ? <code>{info.serial}</code> : null}
          {info?.firmware ? <span>固件 {info.firmware}</span> : null}
          <span>
            <BatteryCharging size={13} aria-hidden="true" /> {info?.batteryPct ?? '--'}%
          </span>
          <span>
            <Usb size={13} aria-hidden="true" /> 剩余 {info?.freeSpacePct ?? '--'}%
          </span>
        </p>

        {busy && view.activity ? (
          <Progress activity={view.activity} cancelling={device.pending === 'cancel'} onCancel={() => void device.cancel()} />
        ) : (
          <div className="devicecard__actions">
            <div className="devicecard__primary">
              <Button
                variant="primary"
                icon={device.pending === 'sync' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                disabled={device.pending !== null}
                onClick={() => void device.sync()}
              >
                {syncLabel}
              </Button>
              {view.syncPlan?.willGoOffline ? (
                <span className="devicecard__hint">将通过无线快传，期间电脑会暂时断开外网（约 1 分钟）</span>
              ) : null}
            </div>
            <Button
              icon={<Unplug size={15} aria-hidden="true" />}
              disabled={device.pending !== null}
              onClick={() => void device.disconnect()}
            >
              断开连接
            </Button>
            {cleanable ? (
              <Button
                variant="quiet"
                icon={<Trash2 size={14} aria-hidden="true" />}
                disabled={device.pending !== null}
                onClick={confirmCleanup}
              >
                清理已同步的录音（{cleanable.count} 条 · {formatBytes(cleanable.bytes)}）
              </Button>
            ) : null}
          </div>
        )}

        {fallback ? <ErrorNotice error={fallback} tone="notice" /> : null}
        {lastError && !busy ? <ErrorNotice error={lastError} onRetry={() => void device.sync()} /> : null}
      </div>
    </section>
  );
}
