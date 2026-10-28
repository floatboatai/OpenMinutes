// ABOUTME: HTTP/JSON 不可信输入的最小运行时校验工具，服务端统一复用。

export class BadInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadInput';
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadInput('请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

export function optString(source: Record<string, unknown>, key: string, maxLength = 4000): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new BadInput(`${key} 必须是字符串`);
  const trimmed = raw.trim();
  if (trimmed.length > maxLength) throw new BadInput(`${key} 超过 ${maxLength} 字符`);
  return trimmed;
}

export function reqString(source: Record<string, unknown>, key: string, maxLength = 4000): string {
  const value = optString(source, key, maxLength);
  if (!value) throw new BadInput(`${key} 不能为空`);
  return value;
}

export function optInt(source: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value)) throw new BadInput(`${key} 必须是整数`);
  if (value < min || value > max) throw new BadInput(`${key} 需在 ${min}~${max} 之间`);
  return value;
}

export function reqInt(source: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = optInt(source, key, min, max);
  if (value === undefined) throw new BadInput(`${key} 不能为空`);
  return value;
}

export function optBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  throw new BadInput(`${key} 必须是布尔值`);
}

export function optStringArray(source: Record<string, unknown>, key: string, maxItems = 200): string[] | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new BadInput(`${key} 必须是字符串数组`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadInput(`${key} 必须是字符串数组`);
    const trimmed = item.trim();
    if (trimmed && trimmed.length <= 200) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function optIntArray(source: Record<string, unknown>, key: string, maxItems = 500): number[] | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new BadInput(`${key} 必须是数字数组`);
  const out: number[] = [];
  for (const item of raw) {
    const value = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(value) || value <= 0) throw new BadInput(`${key} 只能包含正整数`);
    if (!out.includes(value)) out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function pathParam(params: Record<string, string>, key: string): number {
  const value = Number(params[key]);
  if (!Number.isInteger(value) || value <= 0) throw new BadInput(`非法的 ${key}`);
  return value;
}

/** 把用户输入转成安全的 LIKE 模式，转义 SQL 通配符。 */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
