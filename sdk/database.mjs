// ABOUTME: 在 App 进程内打开标准 SQLite，管理互斥运行、顺序迁移与一致性备份。
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { acquireWorkbenchDataLock } from './data-lock.mjs';
export async function openWorkbenchDatabase(config) {
    if (!isAbsolute(config.dataDirectory))
        throw new Error('WORKBENCH_ABSOLUTE_PATH_REQUIRED');
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    const release = await acquireWorkbenchDataLock(config.dataDirectory, config.appId);
    let database;
    try {
        database = new DatabaseSync(join(config.dataDirectory, 'data.sqlite'));
        database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        database.exec('CREATE TABLE IF NOT EXISTS _workbench_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)');
        database.exec('CREATE TABLE IF NOT EXISTS _workbench_tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT)');
        database
            .prepare("UPDATE _workbench_tasks SET state='interrupted', updated_at=? WHERE state='running'")
            .run(new Date().toISOString());
        await applyMigrations(database, config.migrationsDirectory);
    }
    catch (error) {
        database?.close();
        await release();
        throw error;
    }
    let closed = false;
    return {
        database,
        async close() {
            if (closed)
                return;
            closed = true;
            try {
                database.close();
            }
            finally {
                await release();
            }
        },
    };
}
async function applyMigrations(database, directory) {
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    const history = new Map(database
        .prepare('SELECT name, hash FROM _workbench_migrations ORDER BY name')
        .all()
        .map((row) => [String(row.name), String(row.hash)]));
    for (const name of history.keys())
        if (!files.includes(name))
            throw new Error(`WORKBENCH_MIGRATION_REMOVED:${name}`);
    const versions = new Set();
    for (const name of files) {
        const match = /^(\d{4,})_[a-zA-Z0-9_.-]+\.sql$/.exec(name);
        if (!match || versions.has(match[1]))
            throw new Error(`WORKBENCH_MIGRATION_NAME_INVALID:${name}`);
        versions.add(match[1]);
        const sql = await readFile(join(directory, name), 'utf8');
        const hash = createHash('sha256').update(sql).digest('hex');
        if (history.has(name)) {
            if (history.get(name) !== hash)
                throw new Error(`WORKBENCH_MIGRATION_CHANGED:${name}`);
            continue;
        }
        const lastApplied = [...history.keys()].at(-1);
        if (lastApplied && name < lastApplied)
            throw new Error(`WORKBENCH_MIGRATION_ORDER_INVALID:${name}`);
        database.exec('BEGIN IMMEDIATE');
        try {
            database.exec(sql);
            database
                .prepare('INSERT INTO _workbench_migrations(name, hash, applied_at) VALUES (?, ?, ?)')
                .run(name, hash, new Date().toISOString());
            database.exec('COMMIT');
            history.set(name, hash);
        }
        catch (error) {
            try {
                database.exec('ROLLBACK');
            }
            catch {
                /* 提交边界被业务 SQL 改变时，交由 Host 从备份恢复。 */
            }
            throw error;
        }
    }
}
export async function backupWorkbenchDatabase(source, destination) {
    const database = new DatabaseSync(source, { readOnly: true });
    try {
        await backup(database, destination);
    }
    finally {
        database.close();
    }
}
