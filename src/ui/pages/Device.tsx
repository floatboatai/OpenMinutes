// ABOUTME: 设备接入页：环境自检、设备清单拉取与导入目录扫描。

import { useState } from 'react';
import { Copy, FolderPlus, HardDriveDownload, ListTree, PlugZap, RefreshCw, ScanLine, TerminalSquare } from 'lucide-react';
import type {
  BridgeRunResult,
  DeviceState,
  DeviceStatus,
  ImportDirectoryState,
  IngestScanResult,
  ParsedDeviceFile,
  RecordingListResult,
} from '../../contracts/app';
import { api, errorText } from '../api';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { useAsyncData } from '../useApi';
import { Button, Card, ErrorState, Field, Loading, useToast } from '../components/ui';
import { SdkCommandTable } from '../components/SdkCommandTable';
import { PendingPullList } from '../components/PendingPullList';
import { EnvironmentPanel } from '../components/EnvironmentPanel';

interface Props {
  onNavigate: (route: string) => void;
}

function parseManifestText(text: string): ParsedDeviceFile[] {
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

export function DevicePage({ onNavigate }: Props) {
  const toast = useToast();
  const state = useAsyncData<DeviceState>(() => api.get<DeviceState>('/api/device'), 'device');
  const directory = useAsyncData<ImportDirectoryState>(() => api.get('/api/ingest/directory'), 'directory');
  const [serial, setSerial] = useState('');
  const [manifestText, setManifestText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [bridge, setBridge] = useState<BridgeRunResult | null>(null);
  const [statusInfo, setStatusInfo] = useState<DeviceStatus | null>(null);
  const [pullNote, setPullNote] = useState('');
  const pendingList = useAsyncData<RecordingListResult>(() => api.get<RecordingListResult>('/api/recordings?limit=100'), 'device-pending');
  const [scan, setScan] = useState<IngestScanResult | null>(null);
  const [importDir, setImportDir] = useState<string | null>(null);
  const [environmentRevision, setEnvironmentRevision] = useState(0);

  if (state.loading && !state.data) return <Loading label="正在检测本机环境" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  const data = state.data;
  if (!data) return <Loading />;

  const importState = directory.data;
  // 目录由服务端解析：设置值优先，空值或失效的临时目录回落到默认收件目录。
  const effectiveImport = importDir ?? importState?.directory ?? '';

  const check = async () => {
    setBusy('check');
    try {
      await api.post('/api/device/check');
      setEnvironmentRevision((value) => value + 1);
      state.reload();
      toast.push('环境检测已刷新', 'success');
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const savePaths = async () => {
    setBusy('save');
    try {
      await api.patch('/api/settings', {
        values: { import_dir: effectiveImport },
      });
      toast.push('路径设置已保存', 'success');
      state.reload();
      directory.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy('status');
    try {
      const result = await api.post<{ result: BridgeRunResult; device: DeviceStatus | null }>('/api/device/status', {});
      setBridge(result.result);
      setStatusInfo(result.device);
      if (result.device) {
        if (result.device.serial) setSerial(result.device.serial);
        toast.push(`已连接 ${result.device.serial ?? '录音笔'}`, 'success');
        state.reload();
      } else {
        toast.push(result.result.message, 'error');
      }
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pullList = async () => {
    setBusy('list');
    try {
      const result = await api.post<{ result: BridgeRunResult; registered: number; skipped: number; serial?: string }>(
        '/api/device/list',
        { serial },
      );
      setBridge(result.result);
      toast.push(
        result.registered > 0
          ? `已登记 ${result.registered} 条设备录音${result.skipped > 0 ? `，跳过 ${result.skipped} 条` : ''}`
          : result.result.message,
        result.registered > 0 ? 'success' : 'error',
      );
      if (result.registered > 0) {
        state.reload();
        directory.reload();
        pendingList.reload();
      }
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const submitManifest = async () => {
    const entries = parseManifestText(manifestText);
    if (entries.length === 0) {
      toast.push('请先粘贴设备文件清单，每行一个文件', 'error');
      return;
    }
    setBusy('manifest');
    try {
      const result = await api.post<{ accepted: number; skipped: number }>('/api/ingest/manifest', {
        serial: serial || 'MemoTalk-S1',
        entries,
      });
      toast.push(`已登记 ${result.accepted} 条，跳过 ${result.skipped} 条`, 'success');
      setManifestText('');
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pendingFiles = (pendingList.data?.items ?? []).filter((item) => item.status === 'pending');

  const pullFile = async (filename: string) => {
    setBusy('pull');
    setPullNote(`正在拉取 ${filename}…`);
    try {
      const result = await api.post<{
        result: BridgeRunResult;
        attached: Array<{ filename: string; ok: boolean; message: string; id: number | null }>;
        queued: number;
      }>('/api/device/download', {
        file: filename,
        serial: serial || statusInfo?.serial || '',
      });
      setBridge(result.result);
      const attached = result.attached[0];
      const ok = Boolean(attached?.ok);
      const suffix = ok && result.queued > 0 ? '，已排队转录' : '';
      setPullNote(ok ? `已拉取 ${filename}${suffix}` : result.result.message);
      toast.push(ok ? `已拉取 ${filename}${suffix}` : result.result.message, ok ? 'success' : 'error');
      pendingList.reload();
      state.reload();
    } catch (error) {
      setPullNote(errorText(error));
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pullAll = async () => {
    const queue = [...pendingFiles];
    if (queue.length === 0) return;
    for (const item of queue) {
      await pullFile(item.filename);
    }
    setPullNote(`队列处理完毕，共 ${queue.length} 个文件。`);
    pendingList.reload();
  };

  const runScan = async () => {
    setBusy('scan');
    try {
      const result = await api.post<IngestScanResult>('/api/ingest/scan', { directory: effectiveImport || undefined });
      setScan(result);
      if (result.imported === 0 && result.skipped === 0 && result.failed === 0) {
        toast.push(result.created ? '已建好导入目录，把 MP3 放进去后再扫描一次' : '目录里还没有可导入的音频文件', 'info');
      } else {
        toast.push(`导入 ${result.imported} 个文件，跳过 ${result.skipped} 个，失败 ${result.failed} 个`, result.failed > 0 ? 'error' : 'success');
      }
      state.reload();
      directory.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const createDir = async () => {
    setBusy('mkdir');
    try {
      const next = await api.post<ImportDirectoryState>('/api/ingest/directory/ensure', {
        directory: importDir ?? undefined,
      });
      setImportDir(null);
      directory.reload();
      state.reload();
      toast.push(next.created ? '导入目录已创建，把 MP3 放进去后点「立即扫描」' : '导入目录已就绪', 'success');
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyPath = async () => {
    if (!effectiveImport) return;
    try {
      await navigator.clipboard.writeText(effectiveImport);
      toast.push('目录路径已复制，可粘贴到资源管理器地址栏', 'success');
    } catch {
      toast.push(`复制失败，请手动记下路径：${effectiveImport}`, 'error');
    }
  };

  return (
    <div className="page page--device">
      <header className="page__head">
        <div>
          <h1>设备接入</h1>
          <p className="page__sub">先确认本机运行环境，再从录音笔拉取清单或扫描本地导入目录。</p>
        </div>
        <div className="page__actions">
          <Button icon={<RefreshCw size={15} aria-hidden="true" />} disabled={busy === 'check'} onClick={() => void check()}>
            重新检测
          </Button>
        </div>
      </header>

      <div className="device-grid">
        <EnvironmentPanel revision={environmentRevision} />

        <Card title="路径设置">
          <Field label="导入目录" hint="录音笔文件下载到这个目录后，扫描即可入库；留空时使用默认收件目录">
            <input value={effectiveImport} onChange={(event) => setImportDir(event.target.value)} placeholder="~/memo/memotalk/inbox" />
          </Field>
          <div className="card__actions">
            <Button variant="primary" size="sm" disabled={busy === 'save'} onClick={() => void savePaths()}>
              保存路径
            </Button>
          </div>
        </Card>

        <Card
          title="连接录音笔"
          action={<span className="muted">{data.devices.length > 0 ? `最近设备：${data.devices[0].serial}` : '尚未连接设备'}</span>}
        >
          <Field label="设备序列号" hint="用于把清单对应到具体设备；留空时自动识别或使用默认值">
            <input value={serial} onChange={(event) => setSerial(event.target.value)} placeholder="MemoTalk-S1" />
          </Field>
          <div className="card__actions">
            <Button
              variant="primary"
              size="sm"
              icon={<PlugZap size={14} aria-hidden="true" />}
              disabled={busy === 'status'}
              onClick={() => void connect()}
            >
              连接并检测
            </Button>
            <Button
              size="sm"
              icon={<ListTree size={14} aria-hidden="true" />}
              disabled={busy === 'list'}
              onClick={() => void pullList()}
            >
              读取清单
            </Button>
            <Button size="sm" onClick={() => onNavigate('library')}>
              去录音库
            </Button>
          </div>
          {statusInfo ? (
            <dl className="devicestatus">
              <div>
                <dt>序列号</dt>
                <dd>{statusInfo.serial ?? '—'}</dd>
              </div>
              <div>
                <dt>电量</dt>
                <dd>{statusInfo.batteryPct !== null ? `${statusInfo.batteryPct}%` : '—'}</dd>
              </div>
              <div>
                <dt>剩余空间</dt>
                <dd>{statusInfo.freeSpacePct !== null ? `${statusInfo.freeSpacePct}%` : '—'}</dd>
              </div>
              <div>
                <dt>固件</dt>
                <dd>{statusInfo.firmware ?? '—'}</dd>
              </div>
              <div>
                <dt>录音状态</dt>
                <dd>{statusInfo.recordingState ?? '—'}</dd>
              </div>
              <div>
                <dt>热点</dt>
                <dd>{statusInfo.hotspotSsid ?? '—'}</dd>
              </div>
            </dl>
          ) : null}
          {bridge ? (
            <div className="bridge">
              <p className={`bridge__msg${bridge.ok ? '' : ' bridge__msg--bad'}`}>{bridge.message}</p>
              <p className="bridge__cmd">
                <TerminalSquare size={13} aria-hidden="true" /> {bridge.command}
                {bridge.exitCode !== null ? ` · 退出码 ${bridge.exitCode}` : ''}
              </p>
              {bridge.parsedFiles.length > 0 ? (
                <p className="muted">解析到 {bridge.parsedFiles.length} 条文件记录。</p>
              ) : null}
              <details className="bridge__raw">
                <summary>SDK 原始输出</summary>
                <pre>{bridge.stdout || bridge.stderr || '（无输出）'}</pre>
              </details>
            </div>
          ) : null}
        </Card>

        <PendingPullList
          items={pendingFiles}
          busy={busy === 'pull'}
          note={pullNote}
          onPull={(filename) => void pullFile(filename)}
          onPullAll={() => void pullAll()}
        />

        <Card title="手动登记清单" action={<span className="muted">每行：文件名 大小 时长秒 时间戳</span>}>
          <textarea
            className="manifest-input"
            value={manifestText}
            onChange={(event) => setManifestText(event.target.value)}
            rows={5}
            placeholder={'REC20261020_103000.mp3 1048576 65 1761000000\nREC20261020_114500.mp3 2097152 132 1761004500'}
            aria-label="设备文件清单"
          />
          <div className="card__actions">
            <Button size="sm" icon={<PlugZap size={14} aria-hidden="true" />} disabled={busy === 'manifest'} onClick={() => void submitManifest()}>
              登记为待拉取
            </Button>
          </div>
        </Card>

        <Card
          title="扫描导入目录"
          action={
            <span className={`dirstate ${importState?.exists ? 'dirstate--ok' : 'dirstate--idle'}`}>
              {importState ? (importState.exists ? `${importState.audioFiles} 个音频文件` : '目录待创建') : '—'}
            </span>
          }
        >
          <p className="muted">把录音笔通过 U 盘模式或 Wi-Fi 下载的 MP3 放进导入目录，扫描后会复制进本应用的数据区。</p>
          <div className="pathrow">
            <code className="pathrow__path" title={effectiveImport || undefined}>
              {effectiveImport || '尚未设置导入目录'}
            </code>
            <Button size="sm" icon={<Copy size={14} aria-hidden="true" />} disabled={!effectiveImport} onClick={() => void copyPath()}>
              复制路径
            </Button>
          </div>
          {importState?.isDefault ? (
            <p className="hintline">正在使用默认收件目录，直接把 MP3 放进去即可；也可以在「路径设置」里换成自己的文件夹。</p>
          ) : null}
          {importState?.resetFrom ? (
            <p className="notice">
              原先保存的目录 <code>{importState.resetFrom}</code> 位于可能被系统清理的临时目录，这里已自动改用默认收件目录。
            </p>
          ) : null}
          <div className="card__actions">
            <Button
              variant="primary"
              size="sm"
              icon={<ScanLine size={14} aria-hidden="true" />}
              disabled={busy === 'scan'}
              onClick={() => void runScan()}
            >
              {importState && !importState.exists ? '创建目录并扫描' : '立即扫描'}
            </Button>
            {importState && !importState.exists ? (
              <Button
                size="sm"
                icon={<FolderPlus size={14} aria-hidden="true" />}
                disabled={busy === 'mkdir'}
                onClick={() => void createDir()}
              >
                只创建目录
              </Button>
            ) : null}
          </div>
          {scan ? (
            <ul className="scanresult">
              <li>导入 {scan.imported} 个</li>
              <li>跳过 {scan.skipped} 个</li>
              <li>失败 {scan.failed} 个</li>
            </ul>
          ) : null}
          {scan && scan.files.length === 0 ? (
            <p className="hintline">这次没有扫到音频文件。把录音笔里的 MP3 复制到上面的目录，再点一次「立即扫描」。</p>
          ) : null}
          {scan && scan.files.length > 0 ? (
            <details className="bridge__raw">
              <summary>处理明细</summary>
              <ul className="scandetail">
                {scan.files.map((file) => (
                  <li key={file.filename} className={`scandetail--${file.outcome}`}>
                    <span>{file.filename}</span>
                    <span>{file.outcome === 'imported' ? '已导入' : file.reason ?? file.outcome}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </div>

      <SdkCommandTable commands={data.commands} />

      <Card title="导入完成后">
        <div className="card__actions">
          <Button icon={<HardDriveDownload size={14} aria-hidden="true" />} onClick={() => onNavigate('library')}>
            去录音库批量转录
          </Button>
        </div>
      </Card>
    </div>
  );
}
