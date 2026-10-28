export interface WorkbenchPage {
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}
export declare function connectWorkbenchPage(_legacyOptions?: unknown): Promise<WorkbenchPage>;
