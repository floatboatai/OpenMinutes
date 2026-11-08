// ABOUTME: 内置场景模板定义与读写；模板按 (slug, version) 存库，启动时幂等补齐内置版本。

import type { DatabaseSync } from 'node:sqlite';
import type { SceneTemplate, TemplateField } from '../../contracts/scenes';
import { rows, run } from '../sql';

export const FALLBACK_TEMPLATE = 'ambient';

const todos: TemplateField = { key: 'todos', label: '待办', type: 'list<todo>', hint: '文本里明确出现的待办、承诺或后续动作' };

export const BUILTIN_TEMPLATES: readonly SceneTemplate[] = [
  {
    slug: 'social',
    version: 1,
    name: '结识新朋友 / 社交',
    when: '与一位或几位不太熟的人寒暄、自我介绍、聊彼此的工作或生活，可能出现“加个微信”“我扫你”“名片发你”',
    color: '#d97706',
    extract: true,
    fields: [
      { key: 'people', label: '对方是谁', type: 'list<person>', hint: '称呼、公司、职位、身份特征；只写文本里出现的' },
      { key: 'topics', label: '共同话题', type: 'list<text>', hint: '聊到的主要话题' },
      { key: 'contactExchanges', label: '交换联系方式', type: 'list<contact_exchange>', hint: '加微信、留电话、交换名片的时刻与对象' },
      { key: 'followUps', label: '后续约定', type: 'list<text>', hint: '约好的下一次见面、要发的资料等' },
      todos,
    ],
  },
  {
    slug: 'lecture',
    version: 1,
    name: '听课 / 讲座',
    when: '单一主讲人长时间输出，有授课语气（“今天讲”“第几点”“大家看”），偶尔有提问',
    color: '#2563eb',
    extract: true,
    fields: [
      { key: 'speaker', label: '讲者', type: 'person_ref', hint: '主讲人的称呼与身份' },
      { key: 'concepts', label: '核心概念', type: 'list<concept>', hint: '概念名称、讲者给出的解释、原话' },
      { key: 'methods', label: '方法论', type: 'list<method>', hint: '方法名称、步骤、适用场景' },
      { key: 'cases', label: '案例', type: 'list<text>', hint: '讲者举的例子' },
      { key: 'resources', label: '书单 / 工具', type: 'list<entity>', hint: '提到的书、工具、网站、组织' },
      { key: 'experiments', label: '可以尝试', type: 'list<idea>', hint: '听完可以自己试的点子' },
      todos,
    ],
  },
  {
    slug: 'meeting',
    version: 1,
    name: '会议 / 商务沟通',
    when: '几个人围绕具体事项讨论、对齐、做决定，出现排期、负责人、方案比较',
    color: '#7c3aed',
    extract: true,
    fields: [
      { key: 'participants', label: '参与人', type: 'list<person>', hint: '出现的参与人及其角色' },
      { key: 'decisions', label: '决策', type: 'list<decision>', hint: '已经做出的决定' },
      { key: 'disagreements', label: '分歧与未决问题', type: 'list<text>', hint: '尚未达成一致的点' },
      { key: 'contactExchanges', label: '交换联系方式', type: 'list<contact_exchange>', hint: '会上新认识的人交换联系方式的时刻' },
      todos,
    ],
  },
  {
    slug: 'musing',
    version: 1,
    name: '自言自语 / 灵感随记',
    when: '只有用户本人在说，记想法、计划、感受或备忘',
    color: '#059669',
    extract: true,
    fields: [
      { key: 'ideas', label: '灵感', type: 'list<idea>', hint: '想法和想尝试的事' },
      { key: 'reflections', label: '情绪与反思', type: 'list<text>', hint: '感受、复盘' },
      todos,
    ],
  },
  {
    slug: FALLBACK_TEMPLATE,
    version: 1,
    name: '背景 / 无实质内容',
    when: '通勤、背景噪声、路人交谈、点单等与用户无关或没有信息量的片段',
    color: '#94a3b8',
    extract: false,
    fields: [],
  },
];

/** 补齐内置模板；已存在的 (slug, version) 不覆盖。 */
export function ensureBuiltinTemplates(db: DatabaseSync): void {
  for (const template of BUILTIN_TEMPLATES) {
    run(
      db,
      `INSERT OR IGNORE INTO templates (slug, version, name, definition_json, origin, status)
       VALUES (?, ?, ?, ?, 'builtin', 'active')`,
      [template.slug, template.version, template.name, JSON.stringify(template)],
    );
  }
}

/** 每个 slug 取最新的 active 版本。 */
export function activeTemplates(db: DatabaseSync): SceneTemplate[] {
  ensureBuiltinTemplates(db);
  const latest = new Map<string, SceneTemplate>();
  for (const item of rows(db, "SELECT definition_json FROM templates WHERE status = 'active' ORDER BY slug, version")) {
    const template = JSON.parse(String(item.definition_json)) as SceneTemplate;
    latest.set(template.slug, template);
  }
  return [...latest.values()];
}
