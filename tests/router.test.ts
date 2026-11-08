import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHash, DEFAULT_ROUTE, navKey, parseHash, type Route } from '../src/ui/router.ts';

test('each nav page parses and round-trips', () => {
  const routes: Route[] = [
    { name: 'library' },
    { name: 'library', stage: 'failed' },
    { name: 'library', stage: 'ready' },
    { name: 'device' },
    { name: 'live' },
    { name: 'today' },
    { name: 'today', day: '2026-11-08' },
    { name: 'calendar' },
    { name: 'calendar', day: '2026-11-08' },
    { name: 'calendar', day: '2026-11-08', rec: 12 },
    { name: 'categories' },
    { name: 'settings' },
    { name: 'settings', section: 'diagnostics' },
    { name: 'detail', id: 7 },
  ];
  for (const route of routes) assert.deepEqual(parseHash(buildHash(route)), route, buildHash(route));
  assert.equal(buildHash({ name: 'calendar', day: '2026-11-08', rec: 3 }), '#/calendar?day=2026-11-08&rec=3');
  assert.equal(buildHash({ name: 'settings', section: 'diagnostics' }), '#/settings/diagnostics');
  assert.equal(buildHash({ name: 'library', stage: 'transcribed' }), '#/library?stage=transcribed');
  assert.deepEqual(DEFAULT_ROUTE, { name: 'library' });
});

test('removed and unknown hashes return null so the app rewrites them to #/library', () => {
  for (const hash of ['', '#', '#/', '#/overview', '#/nope', '#/rec/', '#/rec/abc', '#/rec/0', '#/rec/-3', '#/settings/paths']) {
    assert.equal(parseHash(hash), null, hash);
  }
});

test('invalid query values are dropped instead of breaking the page', () => {
  assert.deepEqual(parseHash('#/library?stage=bogus'), { name: 'library' });
  assert.deepEqual(parseHash('#/calendar?day=11/08/2026&rec=x'), { name: 'calendar' });
  assert.deepEqual(parseHash('#/calendar?rec=5'), { name: 'calendar', rec: 5 });
  assert.deepEqual(parseHash('#/today?day=bad'), { name: 'today' });
  assert.deepEqual(parseHash('#device'), { name: 'device' });
});

test('navKey highlights library for details and settings for its sub-route', () => {
  assert.equal(navKey({ name: 'detail', id: 1 }), 'library');
  assert.equal(navKey({ name: 'settings', section: 'diagnostics' }), 'settings');
  assert.equal(navKey({ name: 'calendar', day: '2026-11-08', rec: 1 }), 'calendar');
  for (const name of ['library', 'device', 'live', 'categories', 'settings'] as const) {
    assert.equal(navKey({ name } as Route), name);
  }
});
