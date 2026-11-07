// ABOUTME: 哈希路由的纯函数：解析、生成与侧栏高亮键；不依赖 window，便于单测。

export type LibraryStage = 'pending' | 'ready' | 'transcribed' | 'done' | 'failed';

export type Route =
  | { name: 'library'; stage?: LibraryStage }
  | { name: 'device' }
  | { name: 'live' }
  | { name: 'calendar'; day?: string; rec?: number }
  | { name: 'categories' }
  | { name: 'settings'; section?: 'diagnostics' }
  | { name: 'detail'; id: number };

export type NavKey = 'library' | 'device' | 'live' | 'calendar' | 'categories' | 'settings';

const STAGES: readonly LibraryStage[] = ['pending', 'ready', 'transcribed', 'done', 'failed'];
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function positiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 未知或已移除的哈希（含 #/overview）返回 null，由调用方改写为 #/library。 */
export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?', 2);
  const params = new URLSearchParams(query);
  if (path.startsWith('rec/')) {
    const id = positiveInt(path.slice(4));
    return id ? { name: 'detail', id } : null;
  }
  switch (path) {
    case 'library': {
      const stage = params.get('stage');
      return STAGES.includes(stage as LibraryStage) ? { name: 'library', stage: stage as LibraryStage } : { name: 'library' };
    }
    case 'device':
    case 'live':
    case 'categories':
      return { name: path };
    case 'calendar': {
      const day = params.get('day');
      const rec = positiveInt(params.get('rec'));
      return {
        name: 'calendar',
        ...(day && DAY_PATTERN.test(day) ? { day } : {}),
        ...(rec ? { rec } : {}),
      };
    }
    case 'settings':
      return { name: 'settings' };
    case 'settings/diagnostics':
      return { name: 'settings', section: 'diagnostics' };
    default:
      return null;
  }
}

export function buildHash(route: Route): string {
  switch (route.name) {
    case 'detail':
      return `#/rec/${route.id}`;
    case 'library':
      return route.stage ? `#/library?stage=${route.stage}` : '#/library';
    case 'calendar': {
      const params = new URLSearchParams();
      if (route.day) params.set('day', route.day);
      if (route.rec) params.set('rec', String(route.rec));
      const query = params.toString();
      return query ? `#/calendar?${query}` : '#/calendar';
    }
    case 'settings':
      return route.section ? `#/settings/${route.section}` : '#/settings';
    default:
      return `#/${route.name}`;
  }
}

/** 详情页高亮「录音」，设置子路由高亮「设置」。 */
export function navKey(route: Route): NavKey {
  return route.name === 'detail' ? 'library' : route.name;
}

export const DEFAULT_ROUTE: Route = { name: 'library' };
