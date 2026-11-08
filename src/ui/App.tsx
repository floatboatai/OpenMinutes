// ABOUTME: 工作台外壳：7 项侧栏导航、哈希路由与页面装配；每个功能只在一个页面里有入口。

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, CalendarDays, Captions, FolderTree, LibraryBig, Mic, Settings2, Shell } from 'lucide-react';
import { api } from './api';
import type { AppInfo, Overview } from '../contracts/app';
import type { EnvironmentState } from '../contracts/preflight';
import { useAsyncData } from './useApi';
import { buildHash, DEFAULT_ROUTE, navKey, parseHash, type NavKey, type Route } from './router';
import { ToastProvider } from './components/ui';
import { LibraryPage } from './pages/Library';
import { DetailPage } from './pages/Detail';
import { DevicePage } from './pages/Device';
import { LivePage } from './pages/Live';
import { CategoriesPage } from './pages/Categories';
import { SettingsPage } from './pages/Settings';
import { CalendarPage } from './pages/Calendar';
import { TodayPage } from './pages/Today';
import './today.css';
import './calendar.css';

const NAV: ReadonlyArray<{ key: NavKey; label: string; icon: typeof Mic }> = [
  { key: 'library', label: '录音', icon: LibraryBig },
  { key: 'today', label: '今日', icon: Shell },
  { key: 'device', label: '录音笔', icon: Mic },
  { key: 'live', label: '实时字幕', icon: Captions },
  { key: 'calendar', label: '日历', icon: CalendarDays },
  { key: 'categories', label: '分类', icon: FolderTree },
  { key: 'settings', label: '设置', icon: Settings2 },
];

/** 未知或已移除的哈希（含 #/overview）改写为 #/library，不留历史记录。 */
function currentRoute(): Route {
  const parsed = parseHash(window.location.hash);
  if (parsed) return parsed;
  window.history.replaceState(null, '', buildHash(DEFAULT_ROUTE));
  return DEFAULT_ROUTE;
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [revision, setRevision] = useState(0);
  // 详情页的返回按钮回到应用内的上一条路由（含页面用 replaceState 写进哈希的筛选与日期）。
  const previousRoute = useRef<Route | null>(null);
  const key = navKey(route);
  const info = useAsyncData<AppInfo>(() => api.get<AppInfo>('/api/app'), 'app');
  const overview = useAsyncData<Overview>(() => api.get<Overview>('/api/overview'), `${key}:${revision}`);
  const environment = useAsyncData<EnvironmentState>(() => api.get<EnvironmentState>('/api/environment'), `env:${key}`);
  const envFailCount = environment.data?.report.items.filter((item) => item.status === 'fail').length ?? 0;

  useEffect(() => {
    const onHash = (event: HashChangeEvent) => {
      const next = currentRoute();
      const from = parseHash(new URL(event.oldURL).hash);
      if (next.name === 'detail' && from && from.name !== 'detail') previousRoute.current = from;
      setRoute(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (info.data) document.title = info.data.name;
  }, [info.data]);

  const navigate = (target: Route) => {
    window.location.hash = buildHash(target);
    window.scrollTo({ top: 0 });
  };
  const openRecording = (id: number) => navigate({ name: 'detail', id });
  const changed = useCallback(() => setRevision((value) => value + 1), []);

  const back = previousRoute.current ?? DEFAULT_ROUTE;
  const backNav = NAV.find((item) => item.key === navKey(back));
  // 徽标只数「在录音笔中」（pending）；overview.pendingCount 还包含待转录。
  const pending = overview.data?.byStatus.find((item) => item.status === 'pending')?.count ?? 0;

  return (
    <ToastProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <AudioLines size={18} />
            </span>
            <span className="brand__text">
              <strong>{info.data?.name ?? '录音笔工作台'}</strong>
              <span className="brand__sub">录音笔 → 转录 → 归类</span>
            </span>
          </div>
          <nav className="nav" aria-label="主导航">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = key === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nav__item${active ? ' nav__item--active' : ''}`}
                  onClick={() => navigate({ name: item.key } as Route)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.key === 'device' && pending > 0 ? (
                    <span className="nav__badge" aria-label={`${pending} 条在录音笔中`}>
                      {pending}
                    </span>
                  ) : null}
                  {item.key === 'settings' && envFailCount > 0 ? <span className="nav__dot" aria-label="本机环境有待处理项" /> : null}
                </button>
              );
            })}
          </nav>
          <div className="sidebar__foot">
            <span>本机数据</span>
            <span className="sidebar__version">v{info.data?.version ?? '0.1.0'}</span>
          </div>
        </aside>

        <main className="main">
          {route.name === 'library' ? (
            <LibraryPage stage={route.stage} overview={overview.data} envFailCount={envFailCount} onOpen={openRecording} onChanged={changed} />
          ) : null}
          {route.name === 'today' ? <TodayPage day={route.day} /> : null}
          {route.name === 'device' ? <DevicePage envFailCount={envFailCount} onChanged={changed} /> : null}
          {route.name === 'live' ? <LivePage onOpen={openRecording} /> : null}
          {route.name === 'calendar' ? <CalendarPage day={route.day} rec={route.rec} /> : null}
          {route.name === 'categories' ? <CategoriesPage overview={overview.data} onChanged={changed} /> : null}
          {route.name === 'settings' ? <SettingsPage section={route.section} /> : null}
          {route.name === 'detail' ? (
            <DetailPage
              id={route.id}
              backLabel={`返回${backNav?.label ?? '录音'}`}
              onBack={() => navigate(back)}
              onRemoved={() => {
                changed();
                navigate(DEFAULT_ROUTE);
              }}
            />
          ) : null}
        </main>
      </div>
    </ToastProvider>
  );
}
