// ABOUTME: 设置 › 诊断与高级：全应用唯一的技术细节区（本机环境、运行时路径、转录并行数、传输方式、设备操作记录、宿主能力、协议指令与开发者工具）。

import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { DeviceCallRecord, DiagnosticsView, TransportSetting } from '../../../contracts/device';
import { api } from '../../api';
import { formatBytes, formatDateTime } from '../../format';
import { useAsyncData } from '../../useApi';
import { Button, ErrorState, Field, Loading, useToast } from '../../components/ui';
import { EnvironmentPanel } from '../../components/EnvironmentPanel';
import { SdkCommandTable } from '../../components/SdkCommandTable';
import { ManifestTool } from './ManifestTool';

interface Props {
  focus: boolean;
  value: (key: string) => string;
  update: (key: string, next: string) => void;
}

const TRANSPORT_OPTIONS: Array<{ value: TransportSetting; label: string }> = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'wifi', label: '始终无线快传' },
  { value: 'ble', label: '始终蓝牙' },
];

const OP_TEXT: Record<DeviceCallRecord['op'], string> = {
  connect: '连接',
  status: '读取状态',
  list: '读取清单',
  pull: '同步',
  delete: '删除',
  disconnect: '断开',
  cancel: '停止',
  live: '实时字幕',
};

const TRANSPORT_TEXT = { wifi: '无线快传', ble: '蓝牙' };

function speed(bps: number | null): string {
  return bps && bps > 0 ? `${formatBytes(bps)}/s` : '还没有测到';
}

function DeviceLogRow({ record }: { record: DeviceCallRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`devlog__row${record.ok ? '' : ' devlog__row--bad'}`}>
      <span>{formatDateTime(record.at)}</span>
      <span>{OP_TEXT[record.op] ?? record.op}</span>
      <span>{record.origin === 'auto' ? '自动' : '手动'}</span>
      <span>{record.ok ? '成功' : record.code ?? '失败'}</span>
      <span>{record.transport ? TRANSPORT_TEXT[record.transport] : '—'}</span>
      <span>{record.bytes ? formatBytes(record.bytes) : '—'}</span>
      <span>{(record.durationMs / 1000).toFixed(1)} 秒</span>
      {record.detail ? (
        <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          详情
        </button>
      ) : (
        <span />
      )}
      {open ? <pre className="errornotice__detail devlog__detail">{record.detail}</pre> : null}
    </li>
  );
}

function DiagnosticsBody({ value, update }: Omit<Props, 'focus'>) {
  const toast = useToast();
  const diagnostics = useAsyncData<DiagnosticsView>(() => api.get<DiagnosticsView>('/api/diagnostics'), 'diagnostics');
  const data = diagnostics.data;

  const copyReport = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ ...data, commands: undefined }, null, 2));
      toast.push('诊断报告已复制', 'success');
    } catch {
      toast.push('复制没有成功，请手动选择上面的内容', 'info');
    }
  };

  return (
    <div className="diag">
      <section className="diag__section">
        <h3>本机环境</h3>
        <EnvironmentPanel />
      </section>

      <section className="diag__section">
        <h3>运行时路径</h3>
        <Field label="Python 解释器" hint="留空时自动使用 Floatboat 内置 Python；录音笔组件依赖它">
          <input value={value('python_path')} placeholder="python" onChange={(event) => update('python_path', event.target.value)} />
        </Field>
        <Field label="ffmpeg 路径" hint="留空时使用 Floatboat 内置 ffmpeg；转录依赖它解码音频">
          <input value={value('ffmpeg_path')} placeholder="ffmpeg" onChange={(event) => update('ffmpeg_path', event.target.value)} />
        </Field>
      </section>

      <section className="diag__section">
        <h3>转录任务</h3>
        <Field label="同时转录的录音数" hint="1–8，默认 3。调大处理更快，但更容易遇到识别服务繁忙（会自动排队重试）；保存后对之后开始的转录生效">
          <input
            type="number"
            min={1}
            max={8}
            aria-label="同时转录的录音数"
            value={value('asr_concurrency')}
            placeholder="3"
            onChange={(event) => update('asr_concurrency', event.target.value)}
          />
        </Field>
      </section>

      <section className="diag__section">
        <h3>传输方式</h3>
        <Field label="同步录音时使用" hint="自动：较大的录音走无线快传（录音笔 Wi-Fi 热点 + FTP，期间电脑暂时断开外网），失败时改用蓝牙">
          <select aria-label="传输方式" value={value('device_transport') || 'auto'} onChange={(event) => update('device_transport', event.target.value)}>
            {TRANSPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {data ? (
          <dl className="meta">
            <div>
              <dt>无线网卡</dt>
              <dd>{data.transport.wifiCapable ? '有' : '没有检测到'}（{data.transport.platform}）</dd>
            </div>
            <div>
              <dt>无线快传阈值</dt>
              <dd>本批合计 ≥ {formatBytes(data.transport.thresholdBytes)}</dd>
            </div>
            <div>
              <dt>实测速度</dt>
              <dd>无线快传 {speed(data.transport.measured.wifiBps)} · 蓝牙 {speed(data.transport.measured.bleBps)}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      {diagnostics.loading && !data ? <Loading label="正在读取诊断信息" /> : null}
      {diagnostics.error ? <ErrorState error={diagnostics.error} onRetry={diagnostics.reload} /> : null}

      {data ? (
        <>
          <section className="diag__section">
            <div className="diag__head">
              <h3>最近设备操作</h3>
              <Button size="sm" variant="quiet" onClick={diagnostics.reload}>
                刷新
              </Button>
            </div>
            {data.deviceLog.length === 0 ? (
              <p className="muted">这次启动后还没有设备操作。</p>
            ) : (
              <ul className="devlog">
                <li className="devlog__row devlog__head">
                  <span>时间</span>
                  <span>操作</span>
                  <span>来源</span>
                  <span>结果</span>
                  <span>传输</span>
                  <span>字节</span>
                  <span>耗时</span>
                  <span />
                </li>
                {data.deviceLog.map((record, index) => (
                  <DeviceLogRow key={`${record.at}-${index}`} record={record} />
                ))}
              </ul>
            )}
          </section>

          <section className="diag__section">
            <h3>宿主能力</h3>
            <ul className="caplist">
              {[...data.capabilities.asr.map((item) => ({ ...item, domain: '语音识别' })), ...data.capabilities.llm.map((item) => ({ ...item, domain: 'AI 整理' }))].map((item) => (
                <li key={`${item.domain}-${item.operation}`}>
                  <span>{item.domain}</span>
                  <code>{item.operation}</code>
                  <span className={item.status === 'available' ? 'caplist__ok' : 'muted'}>{item.status}</span>
                  <span className="muted">{item.declared ? '已声明' : '未声明'}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="diag__section">
            <h3>设备协议指令参考（开发者）</h3>
            <SdkCommandTable commands={data.commands} />
          </section>

          <section className="diag__section">
            <h3>开发者工具</h3>
            <ManifestTool />
          </section>

          <div className="card__actions">
            <Button size="sm" icon={<Copy size={14} aria-hidden="true" />} onClick={() => void copyReport()}>
              复制诊断报告
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function DiagnosticsSection({ focus, value, update }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(focus);

  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    window.setTimeout(() => ref.current?.scrollIntoView({ block: 'start' }), 0);
  }, [focus]);

  return (
    <details
      id="diagnostics"
      ref={ref}
      className="card diagnostics"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="diagnostics__summary">
        <h2>诊断与高级</h2>
        <span className="muted">本机环境、传输方式与设备操作记录，排查问题时再展开</span>
      </summary>
      <div className="card__body">{open ? <DiagnosticsBody value={value} update={update} /> : null}</div>
    </details>
  );
}
