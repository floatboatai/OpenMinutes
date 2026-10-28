// ABOUTME: 由 Host 的固定 Node 运行器执行数据库一致性备份，不在 Electron Main 加载 App 数据库。
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { backupWorkbenchDatabase } from './database.mjs';
import { errorFields } from './errors.mjs';
const [operation, source, destination] = process.argv.slice(2);
if (operation !== 'backup' || !isAbsolute(source ?? '') || !isAbsolute(destination ?? ''))
    throw new Error('WORKBENCH_MAINTENANCE_INPUT_INVALID');
let exists = true;
try {
    await stat(source);
}
catch (error) {
    if (errorFields(error).code === 'ENOENT')
        exists = false;
    else
        throw error;
}
if (exists) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await backupWorkbenchDatabase(source, destination);
}
console.log(JSON.stringify({ backedUp: exists }));
