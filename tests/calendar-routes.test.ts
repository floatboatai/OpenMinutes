import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createWorkbenchServer } from '../sdk/runtime.mjs';
import { registerCalendarRoutes } from '../src/server/routes/calendar.ts';
import { registerRecordingRoutes } from '../src/server/routes/recordings.ts';

test('calendar HTTP import, range, creation, linking, detail and Host error envelopes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-calendar-'));
  let close: (() => Promise<void>) | undefined;
  try {
    await cp(new URL('../migrations/', import.meta.url), path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      appId: 'calendar-test', name: 'test', version: '1',
      server: fileURLToPath(import.meta.url), ui: '.', migrations: 'migrations', resources: [],
    }));
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ appId: 'calendar-test', generation: '1', nonce: 'test', sourceDirectory: root, dataDirectory: path.join(root, 'data') }));
    const app = await createWorkbenchServer(import.meta.url, { configPath });
    close = () => app.close();
    registerCalendarRoutes(app);
    registerRecordingRoutes(app);
    const { url } = await app.listen();
    const request = async (route: string, method = 'GET', body?: unknown) => (await fetch(`${url}${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })).json();
    const content = await readFile(new URL('../test-fixtures/sample-calendar.ics', import.meta.url), 'utf8');
    const imported = await request('/api/calendar/import', 'POST', { filename: 'sample.ics', content });
    assert.equal(imported.ok, true);
    assert.equal(imported.data.imported, 4);
    const id = imported.data.events[0].id;
    assert.equal((await request('/api/calendar/import', 'POST', { filename: 'bad.txt', content })).code, 'INVALID_INPUT');
    assert.equal((await request('/api/calendar/events')).code, 'INVALID_INPUT');
    const range = '?start=2026-10-29T00:00:00Z&end=2026-10-30T00:00:00Z';
    assert.equal((await request(`/api/calendar/events${range}`)).data.length, 3);
    const manual = await request('/api/calendar/events', 'POST', {
      summary: '手动归档', startTime: '2026-10-29T02:00:00Z', endTime: '2026-10-29T03:00:00Z',
    });
    assert.equal(manual.data.summary, '手动归档');
    app.database.exec("INSERT INTO recordings(id,filename,dedupe_key,recorded_at) VALUES (1,'test.mp3','test','2026-10-29T00:15:00.000Z')");
    assert.equal((await request('/api/recordings/1/calendar-suggestions')).data[0].event.id, id);
    assert.equal((await request('/api/recordings/1', 'PUT', { calendar_event_id: 'bad' })).code, 'INVALID_INPUT');
    assert.equal((await request('/api/recordings/1', 'PUT', { calendar_event_id: 999 })).code, 'NOT_FOUND');
    assert.equal((await request('/api/recordings/1', 'PUT', { calendar_event_id: id })).data.recording.calendarEventId, id);
    assert.equal((await request('/api/recordings/1')).data.recording.calendarEventId, id);
    assert.equal((await request(`/api/calendar/events/${id}/recordings`)).data.length, 1);
    assert.equal((await request(`/api/calendar/recordings${range}`)).data.length, 1);
    assert.equal((await request(`/api/calendar/events/${id}/digest`)).data.digest, null);
    assert.match((await request(`/api/calendar/events/${id}/digest`, 'POST', {})).error, /LLM 不可用/);
    assert.equal((await request('/api/recordings/1', 'PUT', { calendar_event_id: null })).data.recording.calendarEventId, null);
    assert.equal((await request('/api/calendar/events/999/digest')).code, 'NOT_FOUND');
  } finally {
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
