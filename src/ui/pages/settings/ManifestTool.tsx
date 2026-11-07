// ABOUTME: 开发者工具：手动登记录音笔文件清单（只在「设置 › 诊断与高级」里出现）。

import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { ParsedDeviceFile } from '../../../contracts/device';
import { api } from '../../api';
import { Button, useToast } from '../../components/ui';

export function parseManifestText(text: string): ParsedDeviceFile[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, size, duration, timestamp] = line.split(/[,|\t ]+/);
      return {
        name: name ?? '',
        format: 'MP3',
        sizeBytes: Number(size) || null,
        durationSec: Number(duration) || null,
        timestamp: Number(timestamp) || null,
      };
    })
    .filter((entry) => entry.name.length > 0);
}

export function ManifestTool() {
  const toast = useToast();
  const [serial, setSerial] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const entries = parseManifestText(text);
    if (entries.length === 0) {
      toast.push('请先粘贴文件清单，每行一个文件', 'info');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ accepted: number; skipped: number }>('/api/ingest/manifest', {
        serial: serial.trim() || 'MemoTalk-S1',
        entries,
      });
      toast.push(`已登记 ${result.accepted} 条，跳过 ${result.skipped} 条`, 'success');
      setText('');
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="manifest-tool">
      <p className="muted">手动登记清单（每行：文件名 大小 时长秒 时间戳），用于调试同步流程。</p>
      <input
        className="manifest-serial"
        value={serial}
        onChange={(event) => setSerial(event.target.value)}
        placeholder="序列号（留空为 MemoTalk-S1）"
        aria-label="清单序列号"
      />
      <textarea
        className="manifest-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder={'REC20261020_103000.mp3 1048576 65 1761000000\nREC20261020_114500.mp3 2097152 132 1761004500'}
        aria-label="文件清单"
      />
      <div className="card__actions">
        <Button size="sm" icon={<ClipboardList size={14} aria-hidden="true" />} disabled={busy} onClick={() => void submit()}>
          登记清单
        </Button>
      </div>
    </div>
  );
}
