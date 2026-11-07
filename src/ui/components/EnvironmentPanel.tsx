// ABOUTME: 本机环境自检（设置 › 诊断与高级）：按 4 个分组显示，每行可展开详情；重新检测与 Floatboat 助手修复。

import { useEffect, useState } from 'react';
import { RefreshCw, Wrench } from 'lucide-react';
import type { AppErrorView } from '../../contracts/errors';
import type { EnvironmentState, PreflightGroup, PreflightItem, RepairState } from '../../contracts/preflight';
import { api, toErrorView } from '../api';
import { formatDateTime } from '../format';
import { ErrorNotice } from './ErrorNotice';
import { Button, useToast } from './ui';

const statusText = { ok: '就绪', warn: '待确认', fail: '没准备好' };
const repairText = {
  idle: '尚未请求修复', starting: '正在提交', running: '修复中',
  recovering: '正在恢复上次修复', unknown: '修复结果未知，已禁止重复提交',
  completed: '修复已结束', failed: '修复没有完成', cancelled: '修复已取消', interrupted: '修复被中断',
};
const GROUPS: Array<{ key: PreflightGroup; label: string }> = [
  { key: 'device', label: '录音笔组件' },
  { key: 'audio', label: '音频处理' },
  { key: 'ai', label: '语音识别与 AI 整理' },
  { key: 'storage', label: '存储目录' },
];

function EnvRow({ item }: { item: PreflightItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`env__row env__row--${item.status}`} data-preflight-id={item.id}>
      <span className="env__dot" aria-hidden="true" />
      <span className="env__label">{item.label}</span>
      <span className="env__detail">
        {item.reason}
        {item.status !== 'ok' && item.action ? <span className="env__action">{item.action}</span> : null}
      </span>
      <span className="env__state">{statusText[item.status]}</span>
      {item.detail && item.status !== 'ok' ? (
        <button type="button" className="linkbtn env__more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          查看详情
        </button>
      ) : null}
      {open && item.detail ? <pre className="errornotice__detail env__pre">{item.detail}</pre> : null}
    </li>
  );
}

function RepairStatus({ repair }: { repair: RepairState }) {
  if (repair.status === 'idle') return null;
  return (
    <section className="environment-repair" aria-live="polite">
      <p>{repairText[repair.status]}</p>
      {repair.text ? <pre>{repair.text}</pre> : null}
      <details className="env__ids">
        <summary>查看详情</summary>
        <p className="muted">任务编号：{repair.runId ?? '—'}</p>
        <p className="muted">提交编号：{repair.idempotencyKey}</p>
      </details>
    </section>
  );
}

export function EnvironmentPanel() {
  const toast = useToast();
  const [state, setState] = useState<EnvironmentState | null>(null);
  const [error, setError] = useState<AppErrorView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.get<EnvironmentState>('/api/environment');
        if (!disposed) {
          setState(next);
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(toErrorView(failure));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 2500);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [revision]);

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      await api.post('/api/environment/check');
      setRevision((value) => value + 1);
      toast.push('环境检测已刷新', 'success');
    } catch (failure) {
      setError(toErrorView(failure));
    } finally {
      setChecking(false);
    }
  };

  const repair = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const next = await api.post<RepairState>('/api/environment/repair');
      setState((previous) => previous ? { ...previous, repair: next } : previous);
    } catch (failure) {
      setError(toErrorView(failure));
    } finally {
      setSubmitting(false);
    }
  };
  const items = state?.report.items ?? [];
  const available = items.find((item) => item.id === 'host-agent')?.status === 'ok';
  const fixable = items.some((item) => item.status === 'fail' && item.autoRepair);
  const running = state !== null && ['running', 'starting', 'recovering', 'unknown'].includes(state.repair.status);
  return (
    <div className="environment-panel">
      <div className="diag__head">
        <span className="muted">{state ? `检测于 ${formatDateTime(state.report.checkedAt)}` : '正在检测'}</span>
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} disabled={checking} onClick={() => void recheck()}>
          {checking ? '正在检测…' : '重新检测'}
        </Button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {GROUPS.map((group) => {
        const rows = items.filter((item) => (item.group ?? 'storage') === group.key);
        if (rows.length === 0) return null;
        return (
          <div key={group.key} className="env__group">
            <h4>{group.label}</h4>
            <ul className="env">
              {rows.map((item) => <EnvRow key={item.id} item={item} />)}
            </ul>
          </div>
        );
      })}
      {fixable ? (
        <Button icon={<Wrench size={15} aria-hidden="true" />} disabled={!available || submitting || running} onClick={() => void repair()}>
          让 Floatboat 助手修复
        </Button>
      ) : null}
      {state && fixable && !available ? (
        <p className="notice">Floatboat 助手暂不可用。请按失败项的提示手动处理，或在 Floatboat 中开启助手后重新检测。</p>
      ) : null}
      {state ? <RepairStatus repair={state.repair} /> : null}
    </div>
  );
}
