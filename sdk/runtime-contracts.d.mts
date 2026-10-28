import type { IncomingMessage } from 'node:http';
import type { WorkbenchResources, WorkbenchResourceDeclaration } from './resources.mjs';
import type { DatabaseSync } from 'node:sqlite';
import type { HostClient } from './host.mjs';
export interface WorkbenchManifest {
    appId: string;
    name: string;
    version: string;
    server: string;
    ui: string;
    migrations: string;
    capabilities: string[];
    resources?: WorkbenchResourceDeclaration[];
}
export interface RouteContext {
    request: IncomingMessage;
    url: URL;
    params: Record<string, string>;
    body: unknown;
    database: DatabaseSync;
    host: HostClient;
}
export interface WorkbenchServer {
    manifest: WorkbenchManifest;
    resources: WorkbenchResources;
    database: DatabaseSync;
    host: HostClient;
    route(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: (context: RouteContext) => unknown | Promise<unknown>): void;
    action(name: string, handler: (input: unknown) => unknown | Promise<unknown>): void;
    trackTask<T>(operation: () => Promise<T>, kind?: string): Promise<T>;
    tasks(): Array<{
        id: string;
        kind: string;
        state: string;
        updated_at: string;
        error_code: string | null;
    }>;
    close(): Promise<void>;
    listen(): Promise<{
        url: string;
        close(): Promise<void>;
    }>;
}
