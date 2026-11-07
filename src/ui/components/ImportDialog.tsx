// ABOUTME: 「导入」对话框：导入本地文件夹的唯一入口；目录只在设置里修改，结果在对话框内显示。

import { useState } from 'react';
import { Copy, ScanLine } from 'lucide-react';
import type { ImportDirectoryState, IngestScanResult } from '../../contracts/app';
import type { AppErrorView } from '../../contracts/errors';
import { api, toErrorView } from '../api';
import { useAsyncData } from '../useApi';
import { ErrorNotice } from './ErrorNotice';
import { Button, Loading, Modal, useToast } from './ui';

const OUTCOME_TEXT: Record<IngestScanResult['files'][number]['outcome'], string> = {
  imported: '已导入',
  skipped: '已跳过',
  failed: '没有导入',
};

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (result: IngestScanResult) => void }) {
  const toast = useToast();
  const directory = useAsyncData<ImportDirectoryState>(() => api.get<ImportDirectoryState>('/api/ingest/directory'), 'import-directory');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestScanResult | null>(null);
  const [error, setError] = useState<AppErrorView | null>(null);
  const dir = directory.data;

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<IngestScanResult>('/api/ingest/scan', {});
      setResult(next);
      directory.reload();
      onImported(next);
    } catch (cause) {
      setError(toErrorView(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async () => {
    if (!dir) return;
    try {
      await navigator.clipboard.writeText(dir.directory);
      toast.push('路径已复制，可以粘贴到文件管理器的地址栏', 'success');
    } catch {
      toast.push(`复制没有成功，请手动记下路径：${dir.directory}`, 'info');
    }
  };

  const summary = (() => {
    if (!result) return null;
    if (result.imported === 0 && result.skipped === 0 && result.failed === 0) {
      return result.created ? '已建好导入文件夹，把录音文件放进去后再扫描一次。' : '文件夹里还没有可以导入的录音文件。';
    }
    const parts = [`已导入 ${result.imported} 条`];
    if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 条`);
    if (result.failed > 0) parts.push(`${result.failed} 条没有导入`);
    return `${parts.join('，')}。`;
  })();

  return (
    <Modal
      title="导入录音"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" icon={<ScanLine size={15} aria-hidden="true" />} disabled={busy || !dir} onClick={() => void scan()}>
            {busy ? '正在扫描…' : '扫描并导入'}
          </Button>
        </>
      }
    >
      <p className="muted">把录音文件（MP3、WAV、M4A 等）放进下面的文件夹，再点「扫描并导入」。</p>
      {directory.loading && !dir ? <Loading label="正在读取导入文件夹" /> : null}
      {directory.error ? <ErrorNotice error={directory.error} onRetry={directory.reload} /> : null}
      {dir ? (
        <>
          <div className="pathrow">
            <code className="pathrow__path" title={dir.directory}>
              {dir.directory}
            </code>
            <Button size="sm" icon={<Copy size={14} aria-hidden="true" />} onClick={() => void copyPath()}>
              复制路径
            </Button>
          </div>
          <p className="hintline">
            {dir.exists ? `文件夹里有 ${dir.audioFiles} 个音频文件。` : '文件夹还不存在，扫描时会自动创建。'}{' '}
            <a className="linkbtn" href="#/settings" onClick={onClose}>
              在设置中修改目录
            </a>
          </p>
          {dir.resetFrom ? (
            <p className="notice">原先保存的文件夹位于可能被系统清理的临时目录，已改用默认文件夹。</p>
          ) : null}
        </>
      ) : null}
      {error ? <ErrorNotice error={error} onRetry={() => void scan()} /> : null}
      {summary ? (
        <p className="importdialog__summary" role="status">
          {summary}
        </p>
      ) : null}
      {result && result.files.length > 0 ? (
        <ul className="scandetail">
          {result.files.map((file) => (
            <li key={file.filename} className={`scandetail--${file.outcome}`}>
              <span>{file.filename}</span>
              {file.outcome === 'failed' && file.detail ? (
                // 失败原因一句话在主行，技术原文收在「查看详情」里，可展开、可复制。
                <ErrorNotice error={{ code: 'IMPORT_FAILED', message: file.reason ?? OUTCOME_TEXT.failed, detail: file.detail }} />
              ) : (
                <span>{file.outcome === 'imported' ? OUTCOME_TEXT.imported : file.reason ?? OUTCOME_TEXT[file.outcome]}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
