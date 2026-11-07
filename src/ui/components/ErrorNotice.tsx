// ABOUTME: 两层错误提示：主行一句中文结论，技术原文只在点「查看详情」后展开。

import { useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, Copy, Info, RefreshCw } from 'lucide-react';
import type { AppErrorView } from '../../contracts/errors';

interface Props {
  error: AppErrorView;
  /** notice 用于回退提示等非错误信息。 */
  tone?: 'error' | 'notice';
  onRetry?: () => void;
  /** 在 Modal 里使用时默认展开详情。 */
  defaultOpen?: boolean;
}

export function diagnosticText(error: AppErrorView): string {
  return [`[${error.code}] ${error.message}`, error.detail ?? ''].filter(Boolean).join('\n');
}

export function ErrorNotice({ error, tone = 'error', onRetry, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText(error));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={`errornotice errornotice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="errornotice__main">
        {tone === 'error' ? <CircleAlert size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
        <span className="errornotice__message">{error.message}</span>
        <span className="errornotice__actions">
          {error.action ? (
            <a className="linkbtn" href={error.action.href}>
              {error.action.label}
            </a>
          ) : null}
          {onRetry ? (
            <button type="button" className="linkbtn" onClick={onRetry}>
              <RefreshCw size={12} aria-hidden="true" /> 重试
            </button>
          ) : null}
          {error.detail ? (
            <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} 查看详情
            </button>
          ) : null}
        </span>
      </div>
      {open && error.detail ? (
        <div className="errornotice__more">
          <pre className="errornotice__detail">{diagnosticText(error)}</pre>
          <span className="errornotice__tools">
            <button type="button" className="linkbtn" onClick={() => void copy()}>
              <Copy size={12} aria-hidden="true" /> {copied ? '已复制' : '复制诊断信息'}
            </button>
            <a className="linkbtn" href="#/settings/diagnostics">
              在诊断中查看
            </a>
          </span>
        </div>
      ) : null}
    </div>
  );
}
