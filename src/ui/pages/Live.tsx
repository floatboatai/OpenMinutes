// ABOUTME: 实时字幕页：启动采集、滚动字幕与收尾归档。

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Captions, Mic, Square, Waves } from 'lucide-react';
import type { LiveState } from '../../contracts/app';
import { api, errorText } from '../api';
import { formatBytes, formatClock } from '../format';
import { useAsyncData, usePolling } from '../useApi';
import { Button, Card, useToast } from '../components/ui';

interface Props {
  onOpen: (id: number) => void;
  onNavigate: (route: string) => void;
}

const STATUS_TEXT: Record<LiveState['status'], string> = {
  idle: '未开始',
  starting: '正在连接录音笔…',
  listening: '录音中 · 实时回传',
  error: '出现问题',
};

export function LivePage({ onOpen, onNavigate }: Props) {
  const toast = useToast();
  const state = useAsyncData<LiveState>(() => api.get<LiveState>('/api/live'), 'live');
  const [busy, setBusy] = useState(false);
  const captionRef = useRef<HTMLDivElement>(null);

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
      toast.push(errorText(error), 'error');
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
      toast.push(errorText(error), 'error');
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
            录音笔录音的同时把音频回传到本机，边说边出字。停止后音频与文字一起归档到录音库。
          </p>
        </div>
        <div className="page__actions">
          {active ? (
            <Button variant="danger" icon={<Square size={14} aria-hidden="true" />} disabled={busy} onClick={() => void stop()}>
              停止并归档
            </Button>
          ) : (
            <Button variant="primary" icon={<Mic size={15} aria-hidden="true" />} disabled={busy} onClick={() => void start()}>
              开始实时字幕
            </Button>
          )}
        </div>
      </header>

      {live?.message ? (
        <div className="alert" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{live.message}</span>
        </div>
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
              {active ? '正在等待第一句话…' : '点右上角「开始实时字幕」，录音笔会自动开始录音并把声音实时传回来。'}
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
        <Card title="刚刚归档">
          <p className="live__saved">
            已保存到录音库：<code>{live.lastSaved.filePath}</code>（{live.lastSaved.chars} 字）
          </p>
          <div className="card__actions">
            <Button size="sm" icon={<ArrowRight size={14} aria-hidden="true" />} onClick={() => onOpen(live.lastSaved!.recordingId)}>
              打开这条录音
            </Button>
            <Button size="sm" onClick={() => onNavigate('library')}>
              去录音库
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title="使用前提与限制">
        <ul className="bullets">
          <li>录音笔需要先按一下物理键唤醒，并保持在电脑旁边；深度休眠后无法被远程唤醒。</li>
          <li>实时回传走 BLE 的 0x90 流，设备必须处于录音中；连接中断时这一段音频不会补发。</li>
          <li>开启实时音频流后，设备不再上报实时音量电平（0xA4 是二选一）。</li>
          <li>长时间开着会明显耗电。长会议建议录完再拉取（那条链路更稳、更省电）。</li>
          <li>停止时会自动归档 MP3 与文字；开启「转录后自动归类」还会顺带生成摘要与分类。</li>
        </ul>
      </Card>
    </div>
  );
}
