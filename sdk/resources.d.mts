export interface WorkbenchResourceDeclaration {
    id: string;
    kind: 'file' | 'directory';
    location: 'project' | 'data' | 'external';
    path?: string;
    access: 'read' | 'read-write';
    required?: boolean;
}
export interface WorkbenchResourceBinding {
    path: string;
    kind: 'file' | 'directory';
    access: 'read' | 'read-write';
}
export interface WorkbenchResources {
    path(id: string, relativePath?: string, intent?: 'read' | 'write'): Promise<string>;
    configured(id: string): boolean;
}
export declare function prepareWorkbenchResourceDirectories(declarations: readonly WorkbenchResourceDeclaration[], dataDirectory: string): Promise<void>;
export declare function createWorkbenchResources(declarations: readonly WorkbenchResourceDeclaration[], configuration: {
    sourceDirectory: string;
    dataDirectory: string;
    resources?: Record<string, WorkbenchResourceBinding>;
}): WorkbenchResources;
