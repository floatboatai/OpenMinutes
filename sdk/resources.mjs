// ABOUTME: 服务端通过逻辑资源和相对路径定位文件，避免把旧机器路径写入业务记录。
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
export async function prepareWorkbenchResourceDirectories(declarations, dataDirectory) {
    for (const entry of declarations) {
        if (entry.location !== 'data' || entry.kind !== 'directory' || !entry.path)
            continue;
        if (isAbsolute(entry.path) ||
            /[\\:]/u.test(entry.path) ||
            [...entry.path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
            entry.path.split('/').some((part) => !part || part === '.' || part === '..'))
            throw new Error('WORKBENCH_RESOURCE_PATH_INVALID');
        const parts = entry.path.split('/');
        for (let count = 0; count <= parts.length; count++) {
            const path = join(dataDirectory, ...parts.slice(0, count));
            const stat = await lstat(path).catch((error) => {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (stat?.isSymbolicLink())
                throw new Error('WORKBENCH_RESOURCE_LINK_UNSUPPORTED');
            if (stat && !stat.isDirectory())
                throw new Error('WORKBENCH_RESOURCE_TYPE_INVALID');
            if (!stat)
                await mkdir(path, { recursive: true });
        }
    }
}
export function createWorkbenchResources(declarations, configuration) {
    const bindings = new Map();
    for (const entry of declarations) {
        if (entry.path &&
            (isAbsolute(entry.path) ||
                /[\\:]/u.test(entry.path) ||
                [...entry.path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
                entry.path.split('/').some((part) => !part || part === '.' || part === '..')))
            throw new Error('WORKBENCH_RESOURCE_PATH_INVALID');
        const configured = configuration.resources?.[entry.id];
        if (configured)
            bindings.set(entry.id, { ...configured, access: entry.access, kind: entry.kind });
        else if (entry.location !== 'external' && entry.path)
            bindings.set(entry.id, {
                path: join(entry.location === 'project' ? configuration.sourceDirectory : configuration.dataDirectory, entry.path),
                access: entry.access,
                kind: entry.kind,
            });
    }
    return {
        configured: (id) => bindings.has(id),
        async path(id, child = '', intent = 'read') {
            const binding = bindings.get(id);
            if (!binding)
                throw new Error(`WORKBENCH_RESOURCE_UNBOUND:${id}`);
            if (intent === 'write' && binding.access !== 'read-write')
                throw new Error('WORKBENCH_RESOURCE_READ_ONLY');
            if (!isAbsolute(binding.path) ||
                /[\\:]/u.test(child) ||
                [...child].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
                isAbsolute(child) ||
                child.split('/').some((part) => part === '..' || part === '.') ||
                (binding.kind === 'file' && child))
                throw new Error('WORKBENCH_RESOURCE_PATH_INVALID');
            const target = join(binding.path, child);
            const local = relative(binding.path, target);
            if (isAbsolute(local) || local.split(sep).includes('..'))
                throw new Error('WORKBENCH_RESOURCE_PATH_INVALID');
            const segments = local ? local.split(sep) : [];
            for (let index = 0; index <= segments.length; index++) {
                try {
                    const stat = await lstat(join(binding.path, ...segments.slice(0, index)));
                    if (stat.isSymbolicLink())
                        throw new Error('WORKBENCH_RESOURCE_LINK_UNSUPPORTED');
                    if (index < segments.length && !stat.isDirectory())
                        throw new Error('WORKBENCH_RESOURCE_TYPE_INVALID');
                }
                catch (error) {
                    if (intent === 'write' &&
                        index > 0 &&
                        error &&
                        typeof error === 'object' &&
                        'code' in error &&
                        error.code === 'ENOENT')
                        break;
                    throw error;
                }
            }
            return target;
        },
    };
}
