import type { AgentTaskInput, AgentTaskRun, AgentTaskEvent, AgentConversation, AgentConversationCreate, AgentConversationSend, AgentConversationMessage } from './agent-contracts.mjs';
import type { AsrStartInput, AsrSession, AsrEvent } from './asr-contracts.mjs';
export type * from './agent-contracts.mjs';
export type * from './asr-contracts.mjs';
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export interface HostConnection {
    url: string;
}
export interface CallOptions {
    requestId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ModelInput {
    prompt: string;
    model?: string;
    system?: string;
    maxOutputTokens?: number;
    temperature?: number;
}
export interface ModelResult {
    type: 'result';
    text: string;
    model: string;
    finishReason: string;
    requestId: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}
export type ModelEvent = {
    type: 'delta';
    text: string;
    model: string;
    requestId: string;
} | ModelResult | {
    type: 'done';
    requestId: string;
};
export type WorkflowRunStatus = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'skipped' | 'rejected' | 'timed_out' | 'emergency_stopped' | 'cancelled';
export interface WorkflowRun {
    workspaceId: string;
    source: {
        kind: string;
        workspaceId: string | null;
        appId: string | null;
    } | null;
    id: string;
    workflowId: string;
    status: WorkflowRunStatus;
    triggerType: string;
    startedAt: number;
    completedAt: number | null;
    durationMs: number | null;
    output: Record<string, Json> | null;
    safeError: {
        category: string;
        userAction: Record<string, Json> | null;
    } | null;
}
export interface WorkflowStart {
    workspaceId?: string;
    name?: string;
    dependency?: string;
    input?: Record<string, Json>;
    idempotencyKey: string;
    timeoutMs?: number;
}
export interface WorkflowEvent {
    type: 'event' | 'result' | 'done';
    cursor?: number;
    event?: {
        id: string;
        workflowRunId: string;
        sequence: number;
        eventType: 'output' | 'error';
        status: string | null;
    };
    run?: WorkflowRun;
}
export interface ConnectionReference {
    provider: string;
    accountId: string;
    displayName: string;
    connectionId: string;
}
export interface ConnectionResult {
    requestId: string;
    status: 'requested' | 'connected' | 'cancelled' | 'failed' | 'expired';
    connection?: ConnectionReference;
    error?: string;
}
export type ConnectionRequest = {
    service: string;
    provider?: never;
} | {
    provider: string;
    service?: never;
};
export type CalendarProvider = 'floatboat_calendar' | 'system_calendar';
export interface CalendarFields {
    title?: string;
    note?: string | null;
    location?: string | null;
    scheduledAt?: number;
    endAt?: number | null;
    timezone?: string;
    isAllDay?: boolean;
    recurrenceType?: 'once' | 'rrule';
    rrule?: string | null;
}
export interface AutomationDraft {
    bindingId?: string;
    title: string;
    objective: string;
    scheduledAt: number;
    endAt?: number | null;
    timezone: string;
    note?: string | null;
    status?: 'draft' | 'active' | 'paused';
    isAllDay?: boolean;
    executionMode?: 'readonly' | 'standard';
    trustLevel: 'basic_autonomy' | 'enhanced_autonomy' | 'trusted_execution';
    recurrenceType?: 'once' | 'rrule';
    rrule?: string | null;
}
export interface WorkspaceSummary {
    id: string;
    name: string | null;
    status: string;
}
export interface HostClient {
    workspaces: {
        list(input?: {
            limit?: number;
            cursor?: string;
        }): Promise<{
            workspaces: WorkspaceSummary[];
            nextCursor: string | null;
        }>;
        create(input: {
            name: string;
            absolutePath?: string;
            browserIdentity?: 'isolated' | 'default';
            idempotencyKey: string;
        }, options?: CallOptions): Promise<{
            workspace: WorkspaceSummary;
            created: boolean;
        }>;
        activate(input: {
            workspaceId: string;
        }, options?: CallOptions): Promise<{
            workspaceId: string;
            displayed: true;
        }>;
        openUrl(input: {
            workspaceId: string;
            url: string;
            idempotencyKey: string;
        }, options?: CallOptions): Promise<{
            workspaceId: string;
            tabId: string;
            displayed: true;
        }>;
    };
    agent: {
        conversations: {
            create(input: AgentConversationCreate): Promise<AgentConversation>;
            list(input?: {
                offset?: number;
                limit?: number;
            }): Promise<{
                conversations: AgentConversation[];
                nextOffset: number | null;
            }>;
            get(input: {
                conversationId: string;
            }): Promise<AgentConversation>;
            messages(input: {
                conversationId: string;
                offset?: number;
                limit?: number;
            }): Promise<{
                messages: AgentConversationMessage[];
                nextOffset: number | null;
            }>;
            send(input: AgentConversationSend, options?: CallOptions): Promise<{
                runId: string;
            }>;
        };
        start(input: AgentTaskInput, options?: CallOptions): Promise<{
            runId: string;
        }>;
        get(input: {
            runId: string;
        }): Promise<AgentTaskRun>;
        list(input?: {
            limit?: number;
        }): Promise<{
            runs: AgentTaskRun[];
        }>;
        findByIdempotencyKey(input: {
            idempotencyKey: string;
        }): Promise<AgentTaskRun | null>;
        /** 只读订阅自动按游标恢复短暂断线；timeoutMs 限制整个订阅，不会取消任务。 */
        events(input: {
            runId: string;
            afterSequence?: number;
        }, options?: CallOptions): AsyncIterable<AgentTaskEvent>;
        cancel(input: {
            runId: string;
        }): Promise<{
            accepted: boolean;
            run: AgentTaskRun;
        }>;
    };
    asr: {
        start(input: AsrStartInput, options?: CallOptions): Promise<{
            streamId: string;
        }>;
        sendFrame(input: {
            streamId: string;
            sequence: number;
            pcmBase64: string;
        }): Promise<{
            nextSequence: number;
        }>;
        get(input: {
            streamId: string;
        }): Promise<AsrSession>;
        events(input: {
            streamId: string;
            afterSequence?: number;
        }, options?: CallOptions): AsyncIterable<AsrEvent>;
        stop(input: {
            streamId: string;
        }): Promise<AsrSession>;
        cancel(input: {
            streamId: string;
        }): Promise<AsrSession>;
    };
    capabilities: {
        list(input?: {
            domain?: string;
            operation?: string;
        }): Promise<{
            sdkVersion: string;
            capabilities: Array<{
                domain: string;
                operation: string;
                readOnly: boolean;
                requiresAccount: boolean;
                declared: boolean;
                status: 'available' | 'not-declared' | 'account-required';
                authorization: 'checked-on-call';
                inputSchema: Record<string, unknown> | null;
                outputSchema: Record<string, unknown> | null;
            }>;
        }>;
    };
    llm: {
        generateText(input: ModelInput, options?: CallOptions): Promise<ModelResult>;
        generateObject(input: ModelInput & {
            schema: Record<string, unknown>;
        }, options?: CallOptions): Promise<ModelResult & {
            object: unknown;
        }>;
        streamText(input: ModelInput, options?: CallOptions): AsyncIterable<ModelEvent>;
    };
    workflows: {
        start(input: WorkflowStart, options?: CallOptions): Promise<{
            runId: string;
            idempotencyKey: string;
        }>;
        get(input: {
            runId: string;
        }): Promise<WorkflowRun>;
        list(input?: {
            workspaceId?: string;
            workflowId?: string;
            status?: WorkflowRunStatus;
            cursor?: string;
            limit?: number;
        }): Promise<{
            runs: WorkflowRun[];
            nextCursor: string | null;
        }>;
        cancel(input: {
            runId: string;
        }): Promise<{
            accepted: boolean;
            run: WorkflowRun;
        }>;
        findByIdempotencyKey(input: {
            idempotencyKey: string;
        }): Promise<{
            runId: string | null;
            idempotencyKey: string;
            execution: 'executed' | 'unknown';
        } | null>;
        events(input: {
            runId: string;
            afterSequence?: number;
        }, options?: CallOptions): AsyncIterable<WorkflowEvent>;
    };
    connectedServices: {
        searchProviders(input?: {
            query?: string;
            pageSize?: number;
            pageToken?: string;
        }): Promise<{
            providers: Array<{
                provider: string;
                service: string;
                displayName: string;
                description: string;
                authTypes: string[];
                source: string;
                authorization: string;
            }>;
            nextPageToken: string | null;
        }>;
        getConnection(input: {
            service: string;
        }): Promise<ConnectionReference | null>;
        getConnectionRequest(input: {
            requestId: string;
        }): Promise<ConnectionResult>;
        cancelConnectionRequest(input: {
            requestId: string;
        }): Promise<ConnectionResult>;
        connect(input: {
            service: string;
        }, options?: CallOptions): Promise<ConnectionResult>;
        search(input: {
            provider?: string;
            query?: string;
            domain?: string;
            pageSize?: number;
            pageToken?: string;
        }, options?: CallOptions): Promise<unknown>;
        describe(input: {
            capability: string;
        }, options?: CallOptions): Promise<unknown>;
        listConnections(input: {
            provider: string;
        }): Promise<{
            connections: ConnectionReference[];
        }>;
        requestConnection(input: ConnectionRequest): Promise<{
            status: 'requested';
            requestId: string;
        }>;
        call(input: {
            capability: string;
            params?: Record<string, unknown>;
        } & ({
            connectionId: string;
            service?: never;
        } | {
            service: string;
            connectionId?: never;
        }), options?: CallOptions): Promise<unknown>;
    };
    calendar: {
        search(input?: {
            providerKind?: CalendarProvider;
            textQuery?: string;
            rangeStart?: number;
            rangeEnd?: number;
            limit?: number;
        }): Promise<unknown>;
        get(input: {
            providerKind?: CalendarProvider;
            eventId: string;
            rangeStart?: number;
            rangeEnd?: number;
        }): Promise<unknown>;
        create(input: CalendarFields & {
            providerKind?: CalendarProvider;
            title: string;
            scheduledAt: number;
            timezone: string;
        }): Promise<unknown>;
        update(input: CalendarFields & {
            providerKind: CalendarProvider;
            eventId: string;
        }): Promise<unknown>;
        delete(input: {
            providerKind: CalendarProvider;
            eventId: string;
            deletionScope?: 'single_event' | 'this_and_future_events' | 'entire_owned_series';
        }): Promise<unknown>;
    };
    automation: {
        preview(input: AutomationDraft): Promise<{
            previewToken: string;
            expiresAt: number;
            confirmationRequired: true;
            preview: unknown;
        }>;
        create(input: AutomationDraft & {
            previewToken: string;
        }): Promise<{
            bindingId: string;
            detail: unknown;
        }>;
        update(input: AutomationDraft & {
            bindingId: string;
            previewToken: string;
        }): Promise<{
            bindingId: string;
            detail: unknown;
        }>;
        archive(input: {
            bindingId: string;
        }): Promise<{
            archived: boolean;
        }>;
        list(): Promise<{
            tasks: unknown[];
        }>;
        get(input: {
            bindingId: string;
        }): Promise<unknown>;
        runs(input: {
            bindingId: string;
            from?: number;
            to?: number;
        }): Promise<unknown>;
    };
}
