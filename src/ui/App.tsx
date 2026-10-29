// ABOUTME: 工作台外壳：侧边导航、哈希路由与页面装配。

import { useEffect, useState } from 'react';
import { AudioLines, CalendarDays, Captions, FolderTree, HardDriveDownload, LayoutDashboard, LibraryBig, Settings2 } from 'lucide-react';
import { api } from './api';
import type { AppInfo, Overview } from '../contracts/app';
import { useAsyncData } from './useApi';
import { ToastProvider } from './components/ui';
import { OverviewPage } from './pages/Overview';
import { LibraryPage } from './pages/Library';
import { DetailPage } from './pages/Detail';
import { DevicePage } from './pages/Device';
import { LivePage } from './pages/Live';
import { CategoriesPage } from './pages/Categories';
import { SettingsPage } from './pages/Settings';
import { CalendarPage } from './pages/Calendar';
import './calendar.css';

type Route =
  | { name: 'overview' }
  | { name: 'library' }
  | { name: 'device' }
  | { name: 'categories' }
  | { name: 'settings' }
  | { name: 'live' }
  | { name: 'calendar' }
  | { name: 'detail'; id: number };

const NAV = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
  { key: 'library', label: '录音库', icon: LibraryBig },
  { key: 'calendar', label: '日历视图', icon: CalendarDays },
  { key: 'live', label: '实时字幕', icon: Captions },
  { key: 'device', label: '设备接入', icon: HardDriveDownload },
  { key: 'categories', label: '分类', icon: FolderTree },
  { key: 'settings', label: '设置', icon: Settings2 },
] as const;

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('rec/')) {
    const id = Number(raw.slice(4));
    if (Number.isInteger(id) && id > 0) return { name: 'detail', id };
    return { name: 'library' };
  }
  if (raw === 'library' || raw === 'device' || raw === 'categories' || raw === 'settings' || raw === 'live' || raw === 'calendar') {
    return { name: raw };
  }
  return { name: 'overview' };
}

function routeKey(route: Route): string {
  return route.name === 'detail' ? 'library' : route.name;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const info = useAsyncData<AppInfo>(() => api.get<AppInfo>('/api/app'), 'app');
  const overview = useAsyncData<Overview>(() => api.get<Overview>('/api/overview'), routeKey(route));

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (info.data) document.title = info.data.name;
  }, [info.data]);

  const navigate = (target: string) => {
    window.location.hash = `#/${target}`;
    window.scrollTo({ top: 0 });
  };
  const openRecording = (id: number) => {
    window.location.hash = `#/rec/${id}`;
    window.scrollTo({ top: 0 });
  };

  const pending = overview.data?.pendingCount ?? 0;

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
              <span className="brand__sub">录音 → 转录 → 归类</span>
            </span>
          </div>
          <nav className="nav" aria-label="主导航">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = routeKey(route) === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nav__item${active ? ' nav__item--active' : ''}`}
                  onClick={() => navigate(item.key)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.key === 'library' && pending > 0 ? <span className="nav__badge">{pending}</span> : null}
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
          {route.name === 'overview' ? <OverviewPage onOpen={openRecording} onNavigate={navigate} /> : null}
          {route.name === 'library' ? <LibraryPage onOpen={openRecording} onNavigate={navigate} /> : null}
          {route.name === 'calendar' ? <CalendarPage /> : null}
          {route.name === 'detail' ? (
            <DetailPage id={route.id} onBack={() => navigate('library')} onRemoved={() => navigate('library')} />
          ) : null}
          {route.name === 'live' ? <LivePage onOpen={openRecording} onNavigate={navigate} /> : null}
          {route.name === 'device' ? <DevicePage onNavigate={navigate} /> : null}
          {route.name === 'categories' ? <CategoriesPage /> : null}
          {route.name === 'settings' ? <SettingsPage /> : null}
        </main>
      </div>
    </ToastProvider>
  );
}
