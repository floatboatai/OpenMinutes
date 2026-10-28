export interface AgentTaskInput {
    prompt: string;
    workingDirectory: string;
    idempotencyKey: string;
    model?: string;
    timeoutMs?: number;
}
export interface AgentTaskRun {
    runId: string;
    sessionId: string;
    conversationId?: string;
    workspaceId: string;
    status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    createdAt: number;
    completedAt: number | null;
    /** 运行中为已接收文本快照，终态为最终结果或保留的部分输出。 */
    text: string;
    errorCode: string | null;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
}
export type AgentTaskProgress = {
    type: 'text';
    text: string;
} | {
    type: 'tool-started';
    toolId: string;
    toolName: string;
} | {
    type: 'tool-finished';
    toolId: string;
    failed: boolean;
} | {
    type: 'status';
    status: string;
};
export type AgentTaskEvent = {
    type: 'event';
    cursor: number;
    event: AgentTaskProgress;
} | {
    type: 'result';
    cursor: number;
    run: AgentTaskRun;
} | {
    type: 'done';
    requestId: string;
};
export interface AgentConversation {
    conversationId: string;
    title: string;
    workingDirectory: string;
    model?: string;
    createdAt: number;
    activeRunId: string | null;
}
export interface AgentConversationCreate {
    title?: string;
    workingDirectory: string;
    model?: string;
    idempotencyKey: string;
}
export interface AgentConversationSend {
    conversationId: string;
    prompt: string;
    idempotencyKey: string;
    model?: string;
    timeoutMs?: number;
}
export interface AgentConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
}
