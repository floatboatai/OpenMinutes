// ABOUTME: 场景层的结构化模型调用：先 generateObject，服务端拒绝 Schema 时退回文本 + 本地 JSON 抽取。

import type { HostClient } from '../../../sdk/host.mjs';
import { AppError } from '../../contracts/errors';
import { extractJsonObject } from '../organize';

export type SceneHost = Pick<HostClient, 'llm'>;

export interface StructuredOutput {
  object: Record<string, unknown>;
  model: string | null;
}

function hostFailure(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /HOST|CAPABILITY|ACCOUNT|LLM/.test(error.code)) {
    return new AppError('LLM_UNAVAILABLE', undefined, `${error.code}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

export async function generateStructured(
  host: SceneHost,
  input: { system: string; prompt: string; schema: Record<string, unknown>; fieldsHint: string },
): Promise<StructuredOutput> {
  try {
    const response = await host.llm.generateObject(
      { system: input.system, prompt: input.prompt, temperature: 0.2, schema: input.schema },
      { timeoutMs: 120000 },
    );
    if (response.object !== null && typeof response.object === 'object' && !Array.isArray(response.object)) {
      return { object: response.object as Record<string, unknown>, model: response.model ?? null };
    }
  } catch (error) {
    // 账号或能力缺失时文本回退同样会失败，直接报告。
    const failure = hostFailure(error);
    if (failure?.code === 'LLM_UNAVAILABLE') throw failure;
  }
  let text: string;
  let model: string | null;
  try {
    const fallback = await host.llm.generateText(
      {
        system: input.system,
        prompt: `${input.prompt}\n\n请按以下字段输出：${input.fieldsHint}。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。`,
        temperature: 0.2,
      },
      { timeoutMs: 120000 },
    );
    text = fallback.text ?? '';
    model = fallback.model ?? null;
  } catch (error) {
    throw hostFailure(error) ?? error;
  }
  const parsed = extractJsonObject(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('LLM_INCOMPLETE', '模型没有返回可解析的结构化结果，请稍后重试。', text.slice(0, 500));
  }
  return { object: parsed as Record<string, unknown>, model };
}
