export interface CalendarEvent {
  id: number;
  summary: string;
  description: string;
  location: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  attendees: string[];
  source: string;
  digest: string | null;
  recordingCount: number;
}

export type CalendarEventInput = Omit<CalendarEvent, 'id' | 'digest' | 'recordingCount'>;

export interface CalendarRecording {
  id: number;
  title: string;
  recordedAt: string | null;
  durationSec: number | null;
  calendarEventId: number | null;
  summary: string | null;
}

export interface CalendarSuggestion {
  event: CalendarEvent;
  reason: string;
}
