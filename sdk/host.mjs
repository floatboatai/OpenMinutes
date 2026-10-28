// ABOUTME: 工作台服务端使用的 HTTP/JSON/SSE 客户端，按本地工作台上下文地址调用，不发送连接凭据。
export class WorkbenchHostError extends Error {
    code;
    requestId;
    execution;
    constructor(error) {
        super(error.message ?? error.code ?? 'WORKBENCH_HOST_ERROR');
        this.name = 'WorkbenchHostError';
        this.code = error.code ?? 'WORKBENCH_HOST_ERROR';
        this.requestId = error.requestId;
        this.execution = error.execution ?? 'not-executed';
    }
}
export function createHostClient(connection, track = (operation) => operation()) {
    const getConnection = typeof connection === 'function' ? connection : () => connection;
    function currentConnection() {
        const current = getConnection();
        if (!current)
            throw new WorkbenchHostError({ code: 'HOST_NOT_CONNECTED' });
        const endpoint = new URL(current.url);
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
            throw new WorkbenchHostError({ code: 'HOST_ENDPOINT_INVALID' });
        return current;
    }
    async function transmit(route, body, options, streamSignal) {
        const signal = streamSignal ??
            (options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)])
                : AbortSignal.timeout(options.timeoutMs ?? 120_000));
        try {
            const current = currentConnection();
            return await fetch(`${current.url.replace(/\/$/u, '')}/${route.replace(/^\//u, '')}`, {
                method: 'POST',
                redirect: 'error',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            });
        }
        catch (error) {
            if (error instanceof WorkbenchHostError)
                throw error;
            throw new WorkbenchHostError({ code: 'HOST_TRANSPORT_FAILED', execution: 'unknown' });
        }
    }
    async function request(domain, operation, input = {}, options = {}) {
        return track(async () => {
            const response = await transmit('/v1/call', { domain, operation, input, requestId: options.requestId }, options);
            const result = (await response.json());
            if (!response.ok || result.error)
                throw new WorkbenchHostError(result.error ?? { code: 'HOST_REQUEST_FAILED' });
            return result.data;
        }, `${domain}.${operation}`);
    }
    async function* events(domain, operation, input = {}, options = {}, resumable = false) {
        const controller = new AbortController();
        let idle;
        const resetIdle = () => {
            if (!resumable)
                return;
            clearTimeout(idle);
            idle = setTimeout(() => controller.abort(), 120_000);
            idle.unref?.();
        };
        const subscriptionSignal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
        resetIdle();
        try {
            const response = await transmit('/v1/events', { domain, operation, input, requestId: options.requestId }, options, resumable ? subscriptionSignal : undefined);
            if (!response.ok)
                throw new WorkbenchHostError((await response.json()).error ?? { code: 'HOST_REQUEST_FAILED' });
            if (!response.body)
                throw new WorkbenchHostError({ code: 'HOST_STREAM_EMPTY', execution: 'unknown' });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let terminal = false;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    resetIdle();
                    buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll('\r\n', '\n');
                    if (buffer.length > 2_000_000)
                        throw new WorkbenchHostError({ code: 'HOST_STREAM_TOO_LARGE', execution: 'unknown' });
                    let end;
                    while ((end = buffer.indexOf('\n\n')) >= 0) {
                        const frame = buffer.slice(0, end);
                        buffer = buffer.slice(end + 2);
                        const data = frame
                            .split('\n')
                            .filter((line) => line.startsWith('data:'))
                            .map((line) => line.slice(5).trimStart())
                            .join('\n');
                        if (!data)
                            continue;
                        const event = JSON.parse(data);
                        if (event.type === 'error')
                            throw new WorkbenchHostError(event.error ?? { code: 'HOST_STREAM_FAILED', execution: 'unknown' });
                        if (event.type === 'done')
                            terminal = true;
                        yield event;
                    }
                    if (done)
                        break;
                }
                if (!terminal)
                    throw new WorkbenchHostError({ code: 'HOST_STREAM_INTERRUPTED', execution: 'unknown' });
            }
            catch (error) {
                if (error instanceof WorkbenchHostError)
                    throw error;
                throw new WorkbenchHostError({ code: 'HOST_STREAM_INTERRUPTED', execution: 'unknown' });
            }
            finally {
                await reader.cancel().catch(() => undefined);
            }
        }
        finally {
            clearTimeout(idle);
            controller.abort();
        }
    }
    async function* agentEvents(input, options = {}) {
        const signal = options.timeoutMs === undefined
            ? options.signal
            : options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
                : AbortSignal.timeout(options.timeoutMs);
        let cursor = input.afterSequence ?? 0;
        let failures = 0;
        let resultReceived = false;
        while (true) {
            signal?.throwIfAborted();
            try {
                for await (const event of events('agent', 'events', { ...input, afterSequence: cursor }, { ...options, signal }, true)) {
                    if (event.type === 'event') {
                        if (event.cursor <= cursor)
                            continue;
                        cursor = event.cursor;
                        failures = 0;
                    }
                    if (event.type === 'result')
                        resultReceived = true;
                    yield event;
                    if (event.type === 'done')
                        return;
                }
                return;
            }
            catch (error) {
                if (resultReceived)
                    return;
                if (signal?.aborted ||
                    !(error instanceof WorkbenchHostError) ||
                    !['HOST_STREAM_INTERRUPTED', 'HOST_TRANSPORT_FAILED'].includes(error.code) ||
                    ++failures > 3)
                    throw error;
                // 只恢复只读事件订阅，绝不重发 start 或其它业务动作。
                await new Promise((resolve, reject) => {
                    const abort = () => {
                        clearTimeout(timer);
                        signal?.removeEventListener('abort', abort);
                        reject(signal?.reason);
                    };
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', abort);
                        resolve();
                    }, 100 * 2 ** (failures - 1));
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted)
                        abort();
                });
            }
        }
    }
    return {
        workspaces: {
            list: (input = {}) => request('workspaces', 'list', input),
            create: (input, options) => request('workspaces', 'create', input, options),
            activate: (input, options) => request('workspaces', 'activate', input, options),
            openUrl: (input, options) => request('workspaces', 'openUrl', input, options),
        },
        agent: {
            conversations: {
                create: (input) => request('agent', 'conversationCreate', input),
                list: (input = {}) => request('agent', 'conversationList', input),
                get: (input) => request('agent', 'conversationGet', input),
                messages: (input) => request('agent', 'conversationMessages', input),
                send: (input, options) => request('agent', 'conversationSend', input, options),
            },
            start: (input, options) => request('agent', 'start', input, options),
            get: (input) => request('agent', 'get', input),
            list: (input) => request('agent', 'list', input),
            findByIdempotencyKey: (input) => request('agent', 'findByIdempotencyKey', input),
            events: (input, options) => agentEvents(input, options),
            cancel: (input) => request('agent', 'cancel', input),
        },
        asr: {
            start: (input, options) => request('asr', 'start', input, options),
            sendFrame: (input) => request('asr', 'sendFrame', input),
            get: (input) => request('asr', 'get', input),
            events: (input, options) => events('asr', 'events', input, options),
            stop: (input) => request('asr', 'stop', input),
            cancel: (input) => request('asr', 'cancel', input),
        },
        capabilities: { list: (input = {}) => request('capabilities', 'list', input) },
        llm: {
            generateText: (input, options) => request('llm', 'generateText', input, options),
            generateObject: (input, options) => request('llm', 'generateObject', input, options),
            streamText: (input, options) => events('llm', 'streamText', input, options),
        },
        workflows: {
            start: (input, options) => request('workflows', 'start', input, options),
            get: (input) => request('workflows', 'get', input),
            list: (input) => request('workflows', 'list', input),
            cancel: (input) => request('workflows', 'cancel', input),
            findByIdempotencyKey: (input) => request('workflows', 'findByIdempotencyKey', input),
            events: (input, options) => events('workflows', 'events', input, options),
        },
        connectedServices: {
            searchProviders: (input = {}) => request('connected-services', 'searchProviders', input),
            getConnection: (input) => request('connected-services', 'getConnection', input),
            getConnectionRequest: (input) => request('connected-services', 'getConnectionRequest', input),
            cancelConnectionRequest: (input) => request('connected-services', 'cancelConnectionRequest', input),
            connect: async (input, options = {}) => {
                const signal = options.signal
                    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000)])
                    : AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000);
                signal.throwIfAborted();
                const initial = await request('connected-services', 'requestConnection', input, {
                    requestId: options.requestId,
                });
                try {
                    signal.throwIfAborted();
                    let result = initial;
                    while (result.status === 'requested') {
                        await new Promise((resolve, reject) => {
                            const finish = () => {
                                signal.removeEventListener('abort', abort);
                                resolve();
                            };
                            const timer = setTimeout(finish, 500);
                            const abort = () => {
                                clearTimeout(timer);
                                signal.removeEventListener('abort', abort);
                                reject(signal.reason);
                            };
                            signal.addEventListener('abort', abort, { once: true });
                            if (signal.aborted)
                                abort();
                        });
                        result = await request('connected-services', 'getConnectionRequest', { requestId: initial.requestId }, { signal });
                    }
                    return result;
                }
                catch (error) {
                    if (signal.aborted) {
                        await request('connected-services', 'cancelConnectionRequest', { requestId: initial.requestId }, { timeoutMs: 5000 }).catch(() => undefined);
                    }
                    throw error;
                }
            },
            search: (input, options) => request('connected-services', 'search', input, options),
            describe: (input, options) => request('connected-services', 'describe', input, options),
            listConnections: (input) => request('connected-services', 'listConnections', input),
            requestConnection: (input) => request('connected-services', 'requestConnection', input),
            call: (input, options) => request('connected-services', 'call', input, options),
        },
        calendar: {
            search: (input) => request('calendar', 'search', input),
            get: (input) => request('calendar', 'get', input),
            create: (input) => request('calendar', 'create', input),
            update: (input) => request('calendar', 'update', input),
            delete: (input) => request('calendar', 'delete', input),
        },
        automation: {
            preview: (input) => request('automation', 'preview', input),
            create: (input) => request('automation', 'create', input),
            update: (input) => request('automation', 'update', input),
            archive: (input) => request('automation', 'archive', input),
            list: () => request('automation', 'list'),
            get: (input) => request('automation', 'get', input),
            runs: (input) => request('automation', 'runs', input),
        },
    };
}
