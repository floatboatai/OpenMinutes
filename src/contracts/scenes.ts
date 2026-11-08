// ABOUTME: 场景层（拾贝切场景、串珠按模板抽取）的前后端共用类型。

export type TemplateFieldType =
  | 'text'
  | 'list<text>'
  | 'person_ref'
  | 'list<person>'
  | 'list<concept>'
  | 'list<method>'
  | 'list<entity>'
  | 'list<idea>'
  | 'list<todo>'
  | 'list<decision>'
  | 'list<contact_exchange>';

export interface TemplateField {
  key: string;
  label: string;
  type: TemplateFieldType;
  hint: string;
}

export interface SceneTemplate {
  slug: string;
  version: number;
  name: string;
  /** 拾贝判断“该用这份模板”的线索。 */
  when: string;
  color: string;
  /** ambient 之类只保留转录、不做抽取的模板为 false。 */
  extract: boolean;
  fields: TemplateField[];
}

export type SceneDayStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface SceneSource {
  recordingId: number;
  title: string;
  /** 场景在这条录音里的起止偏移（毫秒）。 */
  fromMs: number;
  toMs: number;
}

export interface SceneExtraction {
  status: 'done' | 'failed' | 'skipped';
  fields: Record<string, unknown>;
  error: string | null;
  model: string | null;
  engine: string;
}

export interface Scene {
  id: number;
  seq: number;
  startAt: string;
  endAt: string;
  sceneType: string;
  templateSlug: string;
  templateVersion: number;
  confidence: number;
  title: string;
  summary: string;
  sources: SceneSource[];
  extraction: SceneExtraction | null;
}

export interface SceneDay {
  day: string;
  status: SceneDayStatus;
  message: string | null;
  errorCode: string | null;
  updatedAt: string | null;
  /** 当天有转录的录音数。 */
  transcribedCount: number;
  /** 当天还没有转录的录音数。 */
  untranscribedCount: number;
  /** 转录在生成之后有新增或变化。 */
  stale: boolean;
  scenes: Scene[];
  templates: SceneTemplate[];
}
