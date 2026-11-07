// ABOUTME: 「还在录音笔里」列表：单条同步的唯一入口；同步中或实时字幕占用时禁用并写明原因。

import { RefreshCw } from 'lucide-react';
import type { DeviceRecordingOnDevice } from '../../contracts/device';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { Button, Card } from './ui';

interface Props {
  items: DeviceRecordingOnDevice[];
  /** 禁用原因；null 表示可以同步。 */
  blockedReason: string | null;
  /** 单条达到这个大小会走无线快传、暂时断开外网；null 表示不会。 */
  wifiFromBytes: number | null;
  onPull: (id: number) => void;
}

function goesOffline(item: DeviceRecordingOnDevice, wifiFromBytes: number | null): boolean {
  if (wifiFromBytes === null) return false;
  // 大小未知（只登记了清单）时不提示：真正同步前会先读录音笔里的实际大小。
  return item.sizeBytes !== null && item.sizeBytes >= wifiFromBytes;
}

export function DeviceRecordingList({ items, blockedReason, wifiFromBytes, onPull }: Props) {
  const anyOffline = items.some((item) => goesOffline(item, wifiFromBytes));
  return (
    <Card title={`还在录音笔里${items.length > 0 ? `（${items.length}）` : ''}`}>
      {items.length === 0 ? (
        <p className="muted">录音笔里的录音都已同步到电脑。</p>
      ) : (
        <ul className="pulllist">
          {items.map((item) => {
            const offline = goesOffline(item, wifiFromBytes);
            return (
              <li key={item.id}>
                <span className="pulllist__name">{item.filename}</span>
                <span className="pulllist__meta">
                  {item.recordedAt ? `${formatDateTime(item.recordedAt)} · ` : ''}
                  {formatDuration(item.durationSec)} · {formatBytes(item.sizeBytes)}{offline ? ' · 无线快传' : ''}
                </span>
                <Button
                  size="sm"
                  icon={<RefreshCw size={13} aria-hidden="true" />}
                  disabled={blockedReason !== null}
                  title={blockedReason ?? (offline ? '将通过无线快传，期间电脑会暂时断开外网' : undefined)}
                  onClick={() => onPull(item.id)}
                >
                  同步
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {anyOffline && !blockedReason ? (
        <p className="muted pulllist__hint">标「无线快传」的录音较大，同步期间电脑会暂时断开外网。</p>
      ) : null}
      {blockedReason && items.length > 0 ? <p className="muted">{blockedReason}</p> : null}
    </Card>
  );
}
