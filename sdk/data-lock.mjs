// ABOUTME: SDK 和维护 worker 共用旧版也能识别的持有式数据锁。
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { errorFields } from './errors.mjs';
export async function acquireWorkbenchDataLock(directory, appId) {
    if (!isAbsolute(directory))
        throw new Error('WORKBENCH_ABSOLUTE_PATH_REQUIRED');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('WORKBENCH_DATA_PATH_INVALID');
    const path = join(directory, '.runtime-lock.json');
    const lockId = randomUUID();
    await acquireLock(path, { pid: process.pid, lockId, appId });
    return () => releaseLock(path, lockId);
}
async function acquireLock(file, identity) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(file, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(identity));
            }
            finally {
                await handle.close();
            }
            return;
        }
        catch (error) {
            if (errorFields(error).code !== 'EEXIST')
                throw error;
            let owner;
            try {
                owner = JSON.parse(await readFile(file, 'utf8'));
            }
            catch {
                throw new Error('WORKBENCH_DATA_IN_USE');
            }
            if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.lockId !== 'string')
                throw new Error('WORKBENCH_DATA_IN_USE');
            try {
                process.kill(owner.pid, 0);
            }
            catch (probe) {
                if (errorFields(probe).code === 'ESRCH') {
                    await releaseLock(file, owner.lockId);
                    continue;
                }
            }
            throw new Error('WORKBENCH_DATA_IN_USE');
        }
    }
    throw new Error('WORKBENCH_DATA_IN_USE');
}
async function releaseLock(file, lockId) {
    try {
        const owner = JSON.parse(await readFile(file, 'utf8'));
        if (owner.lockId === lockId)
            await unlink(file);
    }
    catch (error) {
        if (errorFields(error).code !== 'ENOENT')
            throw error;
    }
}
