import type { HostClient, HostConnection } from './host-contracts.mjs';
export type * from './host-contracts.mjs';
interface HostFailure {
    code: string;
    message?: string;
    requestId?: string;
    execution?: 'not-executed' | 'executed' | 'unknown';
}
type TrackTask = <T>(operation: () => Promise<T>, kind?: string) => Promise<T>;
export declare class WorkbenchHostError extends Error {
    readonly code: string;
    readonly requestId?: string;
    readonly execution: 'not-executed' | 'executed' | 'unknown';
    constructor(error: HostFailure);
}
export declare function createHostClient(connection: HostConnection | null | (() => HostConnection | null | undefined), track?: TrackTask): HostClient;
