import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import type { EnvironmentState, RepairState } from '../../contracts/preflight';
import { api, errorText } from '../api';
import { Button, Card } from './ui';
import { formatDateTime } from '../format';

const statusText = { ok: '就绪', warn: '待确认', fail: '失败' };
const repairText = {
  idle: '尚未请求修复', starting: '正在提交', running: '修复中',
  completed: '任务已结束', failed: '任务失败', cancelled: '任务已取消', interrupted: '任务已中断',
};

export function EnvironmentPanel({ revision }: { revision: number }) {
  const [state, setState] = useState<EnvironmentState | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.get<EnvironmentState>('/api/environment');
        if (!disposed) {
          setState(next);
          setError('');
        }
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 2500);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [revision]);

  const repair = async () => {
    setSubmitting(true);
    setError('');
    try {
      const next = await api.post<RepairState>('/api/environment/repair');
      setState((previous) => previous ? { ...previous, repair: next } : previous);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSubmitting(false);
    }
  };
  const available = state?.report.items.find((item) => item.id === 'host-agent')?.status === 'ok';
  const fixable = state?.report.items.some((item) => item.status === 'fail' && item.autoRepair);
  const running = state?.repair.status === 'running' || state?.repair.status === 'starting';
  return <div className="environment-panel"><Card title="本机环境" action={<span className="muted">{state ? `检测于 ${formatDateTime(state.report.checkedAt)}` : '正在检测'}</span>}>
    {error ? <p className="notice" role="alert">{error}</p> : null}
    <ul className="env">
      {state?.report.items.map((item) => <li key={item.id} className={`env__row env__row--${item.status}`} data-preflight-id={item.id}>
        <span className="env__dot" aria-hidden="true" />
        <span className="env__label">{item.label}</span>
        <span className="env__detail">{item.reason}</span>
        <span className="env__state">{statusText[item.status]}</span>
        {item.status !== 'ok' && item.action ? <span className="env__action">{item.action}</span> : null}
      </li>)}
    </ul>
    {fixable ? <Button icon={<Wrench size={15} aria-hidden="true" />} disabled={!available || submitting || running} onClick={() => void repair()}>
      让 Floatboat 助手修复
    </Button> : null}
    {state && !available ? <p className="notice">agent 不可用。请按失败项的手动步骤修复，或在 Floatboat 中授权 agent 能力后重新检测。</p> : null}
    {state && state.repair.status !== 'idle' ? <section className="environment-repair" aria-live="polite">
      <p>{repairText[state.repair.status]}</p>
      <pre>{state.repair.text}</pre>
      {state.repair.runId ? <p className="muted">Host 任务：{state.repair.runId}</p> : null}
    </section> : null}
  </Card></div>;
}
