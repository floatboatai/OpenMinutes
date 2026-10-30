import type { DatabaseSync } from 'node:sqlite';
import type { RepairState } from '../contracts/preflight';

export interface RepairStore {
  load(): RepairState;
  save(state: RepairState): void;
}

function parseState(value: unknown): RepairState {
  if (!value || typeof value !== 'object' || !('status' in value)) throw new Error('Invalid repair journal');
  if (value.status === 'idle') return { status: 'idle' };
  if (!('idempotencyKey' in value) || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey
    || !('runId' in value) || (value.runId !== null && typeof value.runId !== 'string')
    || !('text' in value) || typeof value.text !== 'string') throw new Error('Invalid repair journal');
  const { status, idempotencyKey, runId, text } = value;
  switch (status) {
    case 'starting': case 'running': case 'recovering': case 'unknown':
    case 'completed': case 'failed': case 'cancelled': case 'interrupted':
      return { status, idempotencyKey, runId, text };
    default: throw new Error('Invalid repair journal status');
  }
}

export function sqliteRepairStore(db: DatabaseSync, workingDirectory: string): RepairStore {
  return {
    load() {
      const row = db.prepare('SELECT state_json FROM environment_repairs WHERE working_directory = ?').get(workingDirectory);
      if (!row) return { status: 'idle' };
      if (typeof row.state_json !== 'string') throw new Error('Invalid repair journal');
      return parseState(JSON.parse(row.state_json));
    },
    save(state) {
      // One SQLite statement commits the intent before any remote side effect.
      db.prepare(`INSERT INTO environment_repairs (working_directory, state_json) VALUES (?, ?)
        ON CONFLICT(working_directory) DO UPDATE SET state_json = excluded.state_json`)
        .run(workingDirectory, JSON.stringify(state));
    },
  };
}
