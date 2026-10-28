import { DatabaseSync } from 'node:sqlite';
export interface WorkbenchDatabaseConfiguration {
    appId: string;
    dataDirectory: string;
    migrationsDirectory: string;
}
export declare function openWorkbenchDatabase(config: WorkbenchDatabaseConfiguration): Promise<{
    database: DatabaseSync;
    close(): Promise<void>;
}>;
export declare function backupWorkbenchDatabase(source: string, destination: string): Promise<void>;
