// ABOUTME: 录音 ↔ 日程关联的唯一控件：建议一键关联、选择其他事件、新建事件、解除关联。

import { useState } from 'react';
import { ChevronDown, ChevronRight, Link2, Plus, Unlink } from 'lucide-react';
import type { CalendarEvent, CalendarRecording, CalendarSuggestion } from '../../contracts/calendar';
import { api } from '../api';
import { useAsyncData } from '../useApi';
import { Button, useToast } from './ui';

interface Props {
  recording: CalendarRecording;
  events: CalendarEvent[];
  expanded: boolean;
  highlighted?: boolean;
  onToggle: () => void;
  /** 打开新建事件对话框；创建成功后用回调把这条录音关联过去。 */
  onCreateEvent: (linkTo: (eventId: number) => Promise<void>) => void;
  onChanged: () => void;
}

export function EventLinker({ recording, events, expanded, highlighted, onToggle, onCreateEvent, onChanged }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const linkedId = recording.calendarEventId;
  const linked = events.find((event) => event.id === linkedId);
  const suggestions = useAsyncData<CalendarSuggestion[]>(
    () => (expanded ? api.get<CalendarSuggestion[]>(`/api/recordings/${recording.id}/calendar-suggestions`) : Promise.resolve([])),
    `linker:${recording.id}:${linkedId ?? 0}:${expanded ? 1 : 0}`,
  );

  const link = async (target: number | null) => {
    setBusy(true);
    try {
      await api.patch(`/api/recordings/${recording.id}`, { calendarEventId: target });
      toast.push(target ? '已关联日程' : '已解除关联', 'success');
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const status = linkedId ? `已关联：${linked?.summary ?? '其他日期的日程'}` : '未关联日程';
  const offered = (suggestions.data ?? []).filter((item) => item.event.id !== linkedId);

  return (
    <div className={`eventlinker${highlighted ? ' eventlinker--highlight' : ''}`} data-recording-id={recording.id}>
      <button type="button" className="eventlinker__toggle" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <span>{status}</span>
        <span className="eventlinker__cta">{linkedId ? '修改' : '关联'}</span>
      </button>
      {expanded ? (
        <div className="eventlinker__body">
          {offered.length > 0 ? (
            <ul className="eventlinker__suggestions" aria-label="建议关联">
              {offered.map(({ event, reason }) => (
                <li key={event.id}>
                  <Button size="sm" icon={<Link2 size={13} aria-hidden="true" />} disabled={busy} onClick={() => void link(event.id)}>
                    关联到：{event.summary}
                  </Button>
                  <span className="muted">{reason}</span>
                </li>
              ))}
            </ul>
          ) : suggestions.loading ? null : (
            <p className="muted">没有时间上接近的日程。</p>
          )}
          <label className="calendar-link">
            <span>选择其他事件</span>
            <select
              aria-label={`选择其他事件：${recording.title}`}
              disabled={busy}
              value={linkedId ?? ''}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value) void link(value);
              }}
            >
              <option value="">请选择</option>
              {linkedId && !linked ? <option value={linkedId}>当前关联的日程</option> : null}
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.summary} · {event.startTime.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <div className="eventlinker__tools">
            <Button size="sm" variant="quiet" icon={<Plus size={13} aria-hidden="true" />} disabled={busy} onClick={() => onCreateEvent((eventId) => link(eventId))}>
              新建事件
            </Button>
            {linkedId ? (
              <Button size="sm" variant="quiet" icon={<Unlink size={13} aria-hidden="true" />} disabled={busy} onClick={() => void link(null)}>
                解除关联
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
