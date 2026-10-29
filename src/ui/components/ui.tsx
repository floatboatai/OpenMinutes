// ABOUTME: 通用界面原子组件与轻量提示系统。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, Loader2, RefreshCw, X } from 'lucide-react';
import type { RecordingStatus } from '../../contracts/app';

// ------------------------------------------------------------------ 提示

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 5200);
  }, []);

  const value = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            {item.tone === 'success' ? <CircleCheck size={16} aria-hidden="true" /> : null}
            {item.tone === 'error' ? <CircleAlert size={16} aria-hidden="true" /> : null}
            {item.tone === 'info' ? <Info size={16} aria-hidden="true" /> : null}
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

// ------------------------------------------------------------------ 按钮

interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  icon?: ReactNode;
  title?: string;
  type?: 'button' | 'submit';
  block?: boolean;
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  icon,
  title,
  type = 'button',
  block,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size}${block ? ' btn--block' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

interface IconButtonProps {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

export function IconButton({ label, onClick, active, disabled, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn${active ? ' icon-btn--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ 状态

const STATUS_META: Record<RecordingStatus, { label: string; tone: string }> = {
  pending: { label: '待拉取', tone: 'neutral' },
  ready: { label: '待转录', tone: 'info' },
  queued_transcribe: { label: '转录已排队', tone: 'busy' },
  queued_organize: { label: '归类已排队', tone: 'busy' },
  transcribing: { label: '转录中', tone: 'busy' },
  transcribed: { label: '待归类', tone: 'info' },
  analyzing: { label: '归类中', tone: 'busy' },
  organized: { label: '已归档', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

export function StatusChip({ status }: { status: RecordingStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  const busy = meta.tone === 'busy';
  return (
    <span className={`chip chip--${meta.tone}`}>
      {busy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : <span className="chip__dot" aria-hidden="true" />}
      {meta.label}
    </span>
  );
}

export function statusLabel(status: RecordingStatus): string {
  return STATUS_META[status]?.label ?? status;
}

export function Tag({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="tag">
      {children}
      {onRemove ? (
        <button type="button" className="tag__close" onClick={onRemove} aria-label={`移除标签 ${String(children)}`}>
          <X size={10} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export function CategoryPill({ name, color }: { name: string; color: string | null }) {
  return (
    <span className="category-pill">
      <span className="category-pill__dot" style={{ background: color ?? '#64748b' }} aria-hidden="true" />
      {name}
    </span>
  );
}

// ------------------------------------------------------------------ 容器

export function Card({ title, action, children, tight }: { title?: ReactNode; action?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <section className={`card${tight ? ' card--tight' : ''}`}>
      {title ? (
        <header className="card__header">
          <h2>{title}</h2>
          {action}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Info size={22} aria-hidden="true" />
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty empty--error">
      <CircleAlert size={22} aria-hidden="true" />
      <p className="empty__title">加载失败</p>
      <p className="empty__desc">{message}</p>
      {onRetry ? (
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function Loading({ label = '正在加载' }: { label?: string }) {
  return (
    <div className="loading">
      <Loader2 size={18} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
          {option.count !== undefined ? <span className="segmented__count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <header className="modal__header">
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
