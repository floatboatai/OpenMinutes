import { CalendarDays, Link2, Unlink } from 'lucide-react';
import type { CalendarEvent, CalendarSuggestion } from '../../contracts/calendar';
import { api, errorText } from '../api';
import { useAsyncData } from '../useApi';
import { Button, useToast } from './ui';
import { useState } from 'react';

export function CalendarAssociation({ id, eventId, revision = '', onChanged }: {
  id: number; eventId: number | null; revision?: string; onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const suggestions = useAsyncData(() => api.get<CalendarSuggestion[]>(`/api/recordings/${id}/calendar-suggestions`), `suggestions:${id}:${eventId}:${revision}`);
  const linked = useAsyncData(() => eventId ? api.get<CalendarEvent>(`/api/calendar/events/${eventId}`) : Promise.resolve(null), `linked:${eventId}`);
  const link = (target: number | null) => {
    setBusy(true);
    void api.put(`/api/recordings/${id}`, { calendar_event_id: target }).then(() => {
      suggestions.reload(); linked.reload(); onChanged(); toast.push(target ? '录音关联已更新' : '已解除关联', 'success');
    }).catch((cause: unknown) => toast.push(errorText(cause), 'error')).finally(() => setBusy(false));
  };
  return <div className="calendar-suggestion">
    {eventId ? <>
      <p><CalendarDays size={14} /> {linked.data?.summary ?? `日历事件 #${eventId}`}</p>
      <Button size="sm" icon={<Unlink size={13} />} disabled={busy} onClick={() => link(null)}>解除关联</Button>
    </> : suggestions.data?.map(({ event, reason }) => <div key={event.id}>
      <Button size="sm" icon={<Link2 size={13} />} disabled={busy} onClick={() => link(event.id)}>建议关联到：{event.summary}</Button>
      <p className="muted">{reason}</p>
    </div>)}
    {suggestions.error ? <p role="alert">{suggestions.error}</p> : null}
    {linked.error ? <p role="alert">{linked.error}</p> : null}
  </div>;
}
