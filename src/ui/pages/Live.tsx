// ABOUTME: 实时字幕页：开始/停止、滚动字幕，结束后整段录音自动保存。

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Captions, Mic, Square, Waves } from 'lucide-react';
import type { LiveState } from '../../contracts/app';
import { api } from '../api';
import { formatBytes, formatClock } from '../format';
import { useAsyncData, usePolling } from '../useApi';
import { useDevice } from '../useDevice';
import { Button, Card, useToast } from '../components/ui';
import { ErrorNotice } from '../components/ErrorNotice';

interface Props {
  onOpen: (id: number) => void;
}

const STATUS_TEXT: Record<LiveState['status'], string> = {
  idle: '未开始',
  starting: '正在连接录音笔…',
  listening: '录音中 · 实时转写',
  error: '出现问题',
};

export function LivePage({ onOpen }: Props) {
  const toast = useToast();
  const state = useAsyncData<LiveState>(() => api.get<LiveState>('/api/live'), 'live');
  const [busy, setBusy] = useState(false);
  const captionRef = useRef<HTMLDivElement>(null);
  const device = useDevice();
  const deviceState = device.view?.connection.state;
  const deviceActivity = device.view?.activity ?? null;
  const deviceBusy = deviceState === 'busy' || Boolean(deviceActivity) || deviceState === 'connecting';
  // 按真实状态说明为什么暂时不能开始：连接中、清理中、同步中各有各的说法。
  const deviceBusyText = deviceActivity?.kind === 'cleanup'
    ? '录音笔正在清理已同步的录音，结束后才能开始实时字幕。'
    : deviceActivity || deviceState === 'busy'
      ? '录音笔正在同步，结束后才能开始实时字幕。'
      : '录音笔正在连接，请稍候。';

  const live = state.data;
  const active = Boolean(live?.active);
  usePolling(state.reload, 800, active || live?.status === 'starting');

  const finals = live?.finals ?? [];

  useEffect(() => {
    const node = captionRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [finals.length, live?.partial]);

  const start = async () => {
    setBusy(true);
    try {
      await api.post<LiveState>('/api/live/start', {});
      toast.push('已开始采集，说话即出字幕', 'success');
      state.reload();
    } catch (error) {
      toast.error(error);
      state.reload();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const result = await api.post<LiveState>('/api/live/stop', {});
      toast.push(result.lastSaved ? `已保存，共 ${result.lastSaved.chars} 字` : '已停止', 'success');
      state.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const elapsed = live ? live.elapsedMs / 1000 : 0;

  return (
    <div className="page page--live">
      <header className="page__head">
        <div>
          <h1>实时字幕</h1>
          <p className="page__sub">
            录音笔录音的同时把声音传到电脑，边说边出字。停止后录音和文字会一起保存到录音库。
          </p>
        </div>
        <div className="page__actions">
          {active ? (
            <Button variant="danger" icon={<Square size={14} aria-hidden="true" />} disabled={busy} onClick={() => void stop()}>
              停止并保存
            </Button>
          ) : (
            <Button variant="primary" icon={<Mic size={15} aria-hidden="true" />} disabled={busy || deviceBusy} onClick={() => void start()}>
              开始实时字幕
            </Button>
          )}
        </div>
      </header>

      {deviceBusy && !active ? (
        <p className="notice" role="status">
          {deviceBusyText}{' '}
          <a className="linkbtn" href="#/device">
            去录音笔查看
          </a>
        </p>
      ) : null}
      {live?.error ? <ErrorNotice error={live.error} onRetry={active ? undefined : () => void start()} /> : null}
      {!live?.error && live?.message ? (
        <p className="notice" role="status">
          {live.message}
        </p>
      ) : null}

      <Card tight>
        <div className={`live__bar${active ? ' live__bar--on' : ''}`}>
          <span className="live__status">
            <span className={`pulse${active ? '' : ' pulse--idle'}`} aria-hidden="true" />
            {STATUS_TEXT[live?.status ?? 'idle']}
          </span>
          <span className="live__metrics">
            <span>
              <Captions size={13} aria-hidden="true" /> {formatClock(elapsed)}
            </span>
            <span>
              <Waves size={13} aria-hidden="true" /> {formatBytes(live?.audioBytes ?? 0)}
            </span>
            <span>{finals.length} 段</span>
            {live?.deviceName ? <span className="live__device">{live.deviceName}</span> : null}
          </span>
        </div>

        <div className={`live__caption${finals.length === 0 && !live?.partial ? ' live__caption--empty' : ''}`} ref={captionRef}>
          {finals.length === 0 && !live?.partial ? (
            <p className="live__hint">
              {active ? '正在等待第一句话…' : '点右上角「开始实时字幕」，录音笔会开始录音并把声音实时传到电脑。'}
            </p>
          ) : (
            <>
              {finals.map((line, index) => (
                <p key={`${index}-${line.slice(0, 12)}`} className="live__line">
                  {line}
                </p>
              ))}
              {live?.partial ? (
                <p className="live__line live__line--partial">
                  {live.partial}
                  <span className="caret" aria-hidden="true" />
                </p>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {live?.lastSaved ? (
        <Card title="刚刚保存">
          <p className="live__saved">已保存到录音库（{live.lastSaved.chars} 字）。</p>
          <div className="card__actions">
            <Button size="sm" icon={<ArrowRight size={14} aria-hidden="true" />} onClick={() => onOpen(live.lastSaved!.recordingId)}>
              打开这条录音
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title="使用前提">
        <ul className="bullets">
          <li>先按一下录音笔按键唤醒，并放在电脑附近；开始后录音笔会自动录音。</li>
          <li>实时字幕进行时无法同步录音。</li>
          <li>结束后整段录音会自动保存到录音库。</li>
        </ul>
      </Card>
    </div>
  );
}
