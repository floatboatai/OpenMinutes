// ABOUTME: 从异常对象提取可公开的错误字段，不将未知异常冒充成功。
export function errorFields(value) {
    const record = value && typeof value === 'object' ? value : {};
    return {
        code: 'code' in record && typeof record.code === 'string' ? record.code : undefined,
        message: value instanceof Error ? value.message : String(value),
        execution: 'execution' in record && typeof record.execution === 'string' ? record.execution : undefined,
    };
}
