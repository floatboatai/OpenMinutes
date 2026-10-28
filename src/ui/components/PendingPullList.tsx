// ABOUTME: 待拉取录音列表，管理单条与批量 BLE 拉取。

import { HardDriveDownload } from 'lucide-react';
import type { RecordingSummary } from '../../contracts/app';
import { formatBytes, formatDuration } from '../format';
import { Button, Card } from './ui';

interface Props {
  items: RecordingSummary[];
  busy: boolean;
  note: string;
  onPull: (filename: string) => void;
  onPullAll: () => void;
}

export function PendingPullList({ items, busy, note, onPull, onPullAll }: Props) {
  return (
    <Card
      title={`待拉取的录音${items.length > 0 ? `（${items.length}）` : ''}`}
      action={
        items.length > 0 ? (
          <Button size="sm" icon={<HardDriveDownload size={14} aria-hidden="true" />} disabled={busy} onClick={onPullAll}>
            全部拉取
          </Button>
        ) : null
      }
    >
      {items.length === 0 ? (
        <p className="muted">没有待拉取的录音。先用上方「读取清单」把设备里的录音登记进来。</p>
      ) : (
        <ul className="pulllist">
          {items.map((item) => (
            <li key={item.id}>
              <span className="pulllist__name">{item.filename}</span>
              <span className="pulllist__meta">
                {formatDuration(item.durationSec)} · {formatBytes(item.sizeBytes)}
              </span>
              <Button size="sm" disabled={busy} onClick={() => onPull(item.filename)}>
                拉取
              </Button>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="muted">{note}</p> : null}
      <p className="muted">BLE 单文件串行传输，大文件较慢；拉取完成后到录音库批量转录即可。</p>
    </Card>
  );
}
