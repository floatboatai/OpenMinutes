import type { WorkbenchServer } from './runtime-contracts.mjs';
export type * from './runtime-contracts.mjs';
export declare function createWorkbenchServer(entryUrl: string, options?: {
    configPath?: string;
}): Promise<WorkbenchServer>;
