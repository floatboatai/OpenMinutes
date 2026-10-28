// ABOUTME: 首页设备卡：已连接时展示电量与容量仪表，未连接时给出连接入口。

import { BatteryCharging, Bluetooth, HardDriveDownload, ListTree, Loader2, RefreshCw, Usb } from 'lucide-react';
import type { DeviceHero } from '../../contracts/app';
import { relativeTime } from '../format';
import { Button } from './ui';

interface Props {
  device: DeviceHero | null;
  refreshing: boolean;
  connecting: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (route: string) => void;
}

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

export function DeviceHeroCard({ device, refreshing, connecting, onConnect, onRefresh, onNavigate }: Props) {
  if (!device || !device.connected) {
    return (
      <section className="devicehero devicehero--off">
        <div className="devicehero__offmain">
          <span className="devicehero__officon" aria-hidden="true">
            <Bluetooth size={22} />
          </span>
          <div className="devicehero__offtext">
            <h2>录音笔未连接</h2>
            <p>
              {device?.lastSeenAt
                ? `上次连接于 ${relativeTime(device.lastSeenAt)}。唤醒录音笔后点右侧按钮即可直接连接。`
                : '把录音笔唤醒并放在电脑旁边，点右侧按钮直接连接，就能看到电量、剩余容量与待拉取录音。'}
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          icon={
            connecting ? (
              <Loader2 size={15} className="spin" aria-hidden="true" />
            ) : (
              <Bluetooth size={15} aria-hidden="true" />
            )
          }
          disabled={connecting}
          onClick={onConnect}
        >
          {connecting ? '连接中…' : '连接设备'}
        </Button>
      </section>
    );
  }

  const batteryTone = level(device.batteryPct, [50, 20]);
  const storageTone = level(device.freeSpacePct, [30, 10]);

  return (
    <section className="devicehero devicehero--on">
      <div className="devicehero__aurora" aria-hidden="true" />
      <div className="devicehero__waves" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} style={{ animationDelay: `${index * 90}ms` }} />
        ))}
      </div>

      <div className="devicehero__meters">
        <Ring pct={device.batteryPct} label="电量" tone={batteryTone} />
        <Ring pct={device.freeSpacePct} label="剩余" tone={storageTone} />
      </div>

      <div className="devicehero__info">
        <div className="devicehero__title">
          <h2>{device.model}</h2>
          <span className="devicehero__online">
            <span className="pulse" aria-hidden="true" />
            在线 · {relativeTime(device.lastSeenAt)}
          </span>
        </div>
        <p className="devicehero__meta">
          <code>{device.serial}</code>
          {device.firmware ? <span>固件 {device.firmware}</span> : null}
          <span>
            <BatteryCharging size={13} aria-hidden="true" /> {device.batteryPct ?? '--'}%
          </span>
          <span>
            <Usb size={13} aria-hidden="true" /> 剩余 {device.freeSpacePct ?? '--'}%
          </span>
        </p>
        <p className="devicehero__queue">
          {device.pendingPulls > 0 ? (
            <button type="button" className="devicehero__link" onClick={() => onNavigate('device')}>
              还有 {device.pendingPulls} 条录音待拉取 →
            </button>
          ) : (
            <span className="muted">设备清单已全部拉取</span>
          )}
          {device.readyToTranscribe > 0 ? (
            <button type="button" className="devicehero__link" onClick={() => onNavigate('library')}>
              {device.readyToTranscribe} 条待转录 →
            </button>
          ) : null}
        </p>
      </div>

      <div className="devicehero__actions">
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} disabled={refreshing} onClick={onRefresh}>
          {refreshing ? '读取中' : '刷新状态'}
        </Button>
        <Button size="sm" icon={<ListTree size={14} aria-hidden="true" />} onClick={() => onNavigate('device')}>
          读取清单
        </Button>
        <Button size="sm" variant="quiet" icon={<HardDriveDownload size={14} aria-hidden="true" />} onClick={() => onNavigate('device')}>
          拉取录音
        </Button>
      </div>
    </section>
  );
}
