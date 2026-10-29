import { useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Copy, Download, FileAudio, Plus, RefreshCw, Sparkles, Upload } from 'lucide-react';
import type { CalendarEvent, CalendarRecording } from '../../contracts/calendar';
import type { RecordingDetail } from '../../contracts/app';
import { api, errorText } from '../api';
import { useAsyncData } from '../useApi';
import { Button, Empty, ErrorState, Field, IconButton, Loading, Modal, useToast } from '../components/ui';
import { formatDuration } from '../format';
import { CalendarAssociation } from '../components/CalendarAssociation';

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

function dayRange(day: string, count = 1) {
  return { start: new Date(`${day}T00:00:00`).toISOString(), end: new Date(`${shiftDay(day, count)}T00:00:00`).toISOString() };
}

function queryRange(day: string, count = 1): string {
  return new URLSearchParams(dayRange(day, count)).toString();
}

function eventOnDay(event: CalendarEvent, day: string): boolean {
  if (event.allDay) return event.startTime.slice(0, 10) <= day && event.endTime.slice(0, 10) > day;
  const { start, end } = dayRange(day);
  return event.startTime < end && event.endTime > start;
}

function eventTime(event: CalendarEvent): string {
  if (event.allDay) return '全天';
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return `${new Date(event.startTime).toLocaleTimeString('zh-CN', options)} - ${new Date(event.endTime).toLocaleTimeString('zh-CN', options)}`;
}

export function DigestDocument({ title, text }: { title: string; text: string }) {
  const toast = useToast();
  return <section className="calendar-document">
    <div className="calendar-panel-head">
      <h2>{title}</h2>
      <div className="page__actions">
        <IconButton label="复制 Markdown" onClick={() => void navigator.clipboard.writeText(text).then(
          () => toast.push('已复制纪要', 'success'), (error: unknown) => toast.push(errorText(error), 'error'),
        )}><Copy size={16} /></IconButton>
        <IconButton label="导出 Markdown" onClick={() => {
          const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = `${title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}.md`;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}><Download size={16} /></IconButton>
      </div>
    </div>
    <pre className="calendar-markdown">{text}</pre>
  </section>;
}

export function CalendarRecordingDetail({ id }: { id: number }) {
  const detail = useAsyncData(() => api.get<RecordingDetail>(`/api/recordings/${id}`), `calendar-detail:${id}`);
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (detail.loading || !detail.data) return <Loading />;
  const data = detail.data;
  return <section className="calendar-transcript">
    <div className="calendar-panel-head"><h2>{data.recording.title || data.recording.filename}</h2></div>
    <a href={`#/rec/${id}`}>打开录音详情</a>
    <h3>摘要</h3><p>{data.recording.summary || '尚无摘要'}</p>
    {data.analysis ? <><h3>关键点</h3><ul>{data.analysis.keyPoints.map((point, i) => <li key={i}>{point}</li>)}</ul>
      <h3>待办事项</h3><ul>{data.analysis.actionItems.map((point, i) => <li key={i}>{point}</li>)}</ul></> : null}
    <h3>转录全文</h3><p className="calendar-markdown">{data.transcript?.text || '尚无转录文本'}</p>
  </section>;
}

function CreateEvent({ day, onClose, onCreated }: { day: string; onClose: () => void; onCreated: (event: CalendarEvent) => void }) {
  const [summary, setSummary] = useState('');
  const [start, setStart] = useState(`${day}T09:00`);
  const [end, setEnd] = useState(`${day}T10:00`);
  const [location, setLocation] = useState('');
  const [attendees, setAttendees] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="新建日历事件" onClose={onClose}>
    <form className="calendar-form" onSubmit={(event) => {
      event.preventDefault();
      setBusy(true); setError('');
      void (async () => {
        try {
          const created = await api.post<CalendarEvent>('/api/calendar/events', {
            summary, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
            location, attendees: attendees.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
          });
          onCreated(created);
        } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
      })();
    }}>
      <Field label="事件标题"><input required maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
      <Field label="开始时间"><input required type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
      <Field label="结束时间"><input required type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      <Field label="地点"><input maxLength={1000} value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
      <Field label="参会人"><input placeholder="姓名，以逗号分隔" value={attendees} onChange={(e) => setAttendees(e.target.value)} /></Field>
      {error ? <p className="alert" role="alert">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={busy} icon={<Plus size={15} />}>{busy ? '正在创建' : '创建事件'}</Button>
    </form>
  </Modal>;
}

type Selection = { kind: 'day'; day: string } | { kind: 'event'; day: string; id: number };
type Panel = { kind: 'empty' } | { kind: 'recording'; id: number } | { kind: 'digest'; title: string; text: string };

export function CalendarPage() {
  const today = localDay(new Date());
  const [endingDay, setEndingDay] = useState(today);
  const [selection, setSelection] = useState<Selection>({ kind: 'day', day: today });
  const [panel, setPanel] = useState<Panel>({ kind: 'empty' });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const firstDay = shiftDay(endingDay, -6);
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(endingDay, -i));
  // Include UTC date-only events at either edge of the local calendar week.
  const events = useAsyncData(() => api.get<CalendarEvent[]>(`/api/calendar/events?${queryRange(shiftDay(firstDay, -1), 9)}`), `calendar-events:${endingDay}`);
  const selectedEvent = selection.kind === 'event' ? events.data?.find((item) => item.id === selection.id) : undefined;
  const recordings = useAsyncData(() => api.get<CalendarRecording[]>(selection.kind === 'event'
    ? `/api/calendar/events/${selection.id}/recordings`
    : `/api/calendar/recordings?${queryRange(selection.day)}`), `calendar-recordings:${JSON.stringify(selection)}`);
  const refresh = () => { events.reload(); recordings.reload(); };
  const choose = (next: Selection, event?: CalendarEvent) => {
    setSelection(next); setGenerationError('');
    setPanel(event?.digest ? { kind: 'digest', title: `${event.summary}纪要`, text: event.digest } : { kind: 'empty' });
  };
  const moveWeek = (offset: number) => {
    const day = shiftDay(endingDay, offset);
    setEndingDay(day); choose({ kind: 'day', day });
  };
  const generate = async (daily: boolean) => {
    setBusy(true); setGenerationError(''); setPanel({ kind: 'empty' });
    try {
      const result = await api.post<{ digest: string }>(daily
        ? '/api/calendar/digest' : `/api/calendar/events/${selectedEvent?.id}/digest`,
      daily ? { ...dayRange(selection.day), day: selection.day } : {});
      setPanel({ kind: 'digest', title: daily ? `${selection.day} 日报` : `${selectedEvent?.summary}纪要`, text: result.digest });
      events.reload();
    } catch (cause) { setGenerationError(errorText(cause)); } finally { setBusy(false); }
  };
  return <div className="page calendar-page">
    <header className="page__head">
      <div><h1><CalendarDays size={22} /> 日历视图</h1><p className="page__sub">{firstDay} 至 {endingDay}</p></div>
      <div className="page__actions">
        <IconButton label="上一周" disabled={busy} onClick={() => moveWeek(-7)}><ChevronLeft size={17} /></IconButton>
        <input aria-label="日历截止日期" type="date" value={endingDay} disabled={busy} onChange={(e) => {
          if (e.target.value) { setEndingDay(e.target.value); choose({ kind: 'day', day: e.target.value }); }
        }} />
        <IconButton label="下一周" disabled={busy} onClick={() => moveWeek(7)}><ChevronRight size={17} /></IconButton>
        <IconButton label="刷新日历" onClick={refresh}><RefreshCw size={16} /></IconButton>
        <Button icon={<Upload size={15} />} disabled={busy} onClick={() => fileInput.current?.click()}>导入日历</Button>
        <Button icon={<Plus size={15} />} disabled={busy} onClick={() => setCreating(true)}>新建事件</Button>
        <input ref={fileInput} type="file" accept=".ics,text/calendar" hidden aria-label="日历文件" onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > 2 * 1024 * 1024) { toast.push('日历文件不能超过 2 MB', 'error'); return; }
          setBusy(true);
          void file.text().then((content) => api.post<{ imported: number; events: CalendarEvent[] }>('/api/calendar/import', { filename: file.name, content }))
            .then((result) => {
              toast.push(`已导入 ${result.imported} 个日历事件`, 'success');
              const first = result.events[0];
              if (first) {
                const day = first.allDay ? first.startTime.slice(0, 10) : localDay(new Date(first.startTime));
                setEndingDay(day); choose({ kind: 'event', id: first.id, day }, first);
              }
              refresh();
            }).catch((cause: unknown) => toast.push(errorText(cause), 'error')).finally(() => setBusy(false));
        }} />
      </div>
    </header>
    {events.error ? <ErrorState message={events.error} onRetry={events.reload} /> : null}
    <div className="calendar-layout">
      <aside className="calendar-timeline" aria-label="日历时间轴">
        {events.loading && !events.data ? <Loading /> : days.map((day) => {
          const dayEvents = (events.data ?? []).filter((event) => eventOnDay(event, day));
          return <details key={day} open={day === selection.day || undefined}>
            <summary><span>{day === today ? '今天' : day.slice(5)} <span className="muted">{new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })}</span></span><span>{dayEvents.length}</span></summary>
            <button className={`calendar-event${selection.kind === 'day' && selection.day === day ? ' is-selected' : ''}`} disabled={busy} onClick={() => choose({ kind: 'day', day })}>
              <strong>当日录音 / 未关联事件</strong>
            </button>
            {dayEvents.map((event) => <button key={event.id} disabled={busy}
              className={`calendar-event${selectedEvent?.id === event.id ? ' is-selected' : ''}`}
              onClick={() => choose({ kind: 'event', day, id: event.id }, event)}>
              <span className="calendar-event-time">{eventTime(event)}</span>
              <strong>{event.summary}</strong>
              <span className="calendar-event-meta"><span>{event.recordingCount} 段录音</span><span className={event.digest ? 'calendar-done' : 'muted'}>{event.digest ? '已整理' : '未整理'}</span></span>
            </button>)}
          </details>;
        })}
      </aside>
      <section className="calendar-recordings" aria-label="事件与录音">
        <div className="calendar-panel-head"><h2>{selectedEvent?.summary ?? `${selection.day} 录音`}</h2></div>
        {selectedEvent ? <div className="calendar-event-info">
          <p>{selection.day} · {eventTime(selectedEvent)}</p>
          <dl><dt>地点</dt><dd>{selectedEvent.location || '未提供'}</dd>
            <dt>参会人</dt><dd>{selectedEvent.attendees.join('、') || '未提供'}</dd></dl>
          {selectedEvent.description ? <p>{selectedEvent.description}</p> : null}
          <Button icon={<Sparkles size={15} />} variant="primary" disabled={busy || !selectedEvent.recordingCount} onClick={() => void generate(false)}>
            {busy ? '正在处理' : '生成事件纪要'}
          </Button>
        </div> : <Button icon={<Sparkles size={15} />} disabled={busy || recordings.loading || !recordings.data?.length} onClick={() => void generate(true)}>
          {busy ? '正在处理' : selection.day === today ? '生成今日总结' : '生成当日总结'}
        </Button>}
        <h3 className="calendar-list-title">录音 <span className="muted">{recordings.loading ? '' : recordings.data?.length ?? 0}</span></h3>
        {recordings.loading ? <Loading /> : recordings.error ? <ErrorState message={recordings.error} onRetry={recordings.reload} /> : !recordings.data?.length ? <Empty title="暂无录音" /> :
          recordings.data.map((recording) => <div className="calendar-recording" key={recording.id}>
            <button className={`calendar-recording-button${panel.kind === 'recording' && panel.id === recording.id ? ' is-selected' : ''}`}
              onClick={() => { setPanel({ kind: 'recording', id: recording.id }); setGenerationError(''); }}>
              <FileAudio size={16} /><span><strong>{recording.title}</strong>
                <small>{recording.recordedAt ? new Date(recording.recordedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '录音时间未知'} · {formatDuration(recording.durationSec)}</small>
                <small>{recording.calendarEventId ? '已关联事件' : '未关联事件'}</small></span>
            </button>
            <RecordingLinkSlot recording={recording} events={events.data ?? []} onChanged={refresh} />
            {!recording.calendarEventId ? <CalendarAssociation id={recording.id} eventId={null} onChanged={refresh} /> : null}
          </div>)}
      </section>
      <aside className="calendar-results" aria-label="转录与纪要">
        {busy ? <Loading label="正在处理，请稍候" /> : generationError ? <div className="alert" role="alert"><h2>纪要未生成</h2><p>{generationError}</p></div> :
          panel.kind === 'recording' ? <CalendarRecordingDetail key={panel.id} id={panel.id} /> :
          panel.kind === 'digest' ? <DigestDocument title={panel.title} text={panel.text} /> :
          <Empty title="转录与纪要" />}
      </aside>
    </div>
    {creating ? <CreateEvent day={selection.day} onClose={() => setCreating(false)} onCreated={(event) => {
      setCreating(false); refresh(); const day = localDay(new Date(event.startTime)); setEndingDay(day); choose({ kind: 'event', id: event.id, day }, event);
    }} /> : null}
  </div>;
}

function RecordingLinkSlot({ recording, events, onChanged }: { recording: CalendarRecording; events: CalendarEvent[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return <label className="calendar-link"><span>关联事件</span><select aria-label={`关联事件：${recording.title}`} disabled={busy} value={recording.calendarEventId ?? ''}
    onChange={(e) => {
      setBusy(true);
      void api.put(`/api/recordings/${recording.id}`, { calendar_event_id: e.target.value ? Number(e.target.value) : null })
        .then(() => { toast.push('录音关联已更新', 'success'); onChanged(); })
        .catch((cause: unknown) => toast.push(errorText(cause), 'error')).finally(() => setBusy(false));
    }}>
    <option value="">未关联事件</option>
    {recording.calendarEventId && !events.some((event) => event.id === recording.calendarEventId)
      ? <option value={recording.calendarEventId}>已关联事件 #{recording.calendarEventId}</option> : null}
    {events.map((event) => <option key={event.id} value={event.id}>{event.summary} · {event.startTime.slice(0, 10)}</option>)}
  </select></label>;
}
