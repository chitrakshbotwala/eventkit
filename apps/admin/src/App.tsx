import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { Loading } from './components/ui';
import { useAuth } from './lib/auth';
import { useStreamStatus } from './lib/sse';
import { AttendancePage } from './pages/Attendance';
import { AttendeesPage } from './pages/Attendees';
import { LoginPage } from './pages/Login';
import { MonitoringPage } from './pages/Monitoring';
import { OverviewPage } from './pages/Overview';
import { Phase2Page } from './pages/Phase2';
import { SettingsPage } from './pages/Settings';

// The scanner pulls in zxing (large); load it on demand.
const ScannerPage = lazy(() => import('./pages/Scanner').then((m) => ({ default: m.ScannerPage })));

interface NavItem {
  to: string;
  label: string;
  icon: string;
  superadmin: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: '◎', superadmin: true },
  { to: '/attendees', label: 'Attendees', icon: '👥', superadmin: true },
  { to: '/scanner', label: 'Scanner', icon: '⌗', superadmin: false },
  { to: '/attendance', label: 'Attendance', icon: '✓', superadmin: true },
  { to: '/phase2', label: 'Phase 2 control', icon: '⏱', superadmin: true },
  { to: '/monitoring', label: 'Monitoring', icon: '📡', superadmin: true },
  { to: '/settings', label: 'Settings', icon: '⚙', superadmin: true },
];

function Shell({ children }: { children: ReactNode }) {
  const { admin, isSuperadmin, logout } = useAuth();
  const live = useStreamStatus();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => isSuperadmin || !n.superadmin);
  const location = useLocation();

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-20 w-60 transform border-r border-slate-200 bg-white transition-transform md:static md:translate-x-0 dark:border-slate-800 dark:bg-slate-900 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 px-5 py-5">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              EK
            </div>
            <div>
              <div className="text-sm font-semibold">EventKit Admin</div>
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-400'}`}
                />
                {live ? 'Live' : 'Connecting…'}
              </div>
            </div>
          </div>
          <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/25 dark:text-brand-100'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`
                }
              >
                <span className="w-5 text-center" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-slate-200 p-4 text-sm dark:border-slate-800">
            <div className="truncate font-medium">{admin?.name}</div>
            <div className="truncate text-xs text-slate-500">
              {admin?.email} · {admin?.role}
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="mt-2 text-xs font-medium text-brand-600 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      {open && (
        <div
          className="fixed inset-0 z-10 bg-slate-950/30 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded p-1 text-lg"
            aria-label="Open menu"
          >
            ☰
          </button>
          <span className="text-sm font-semibold">
            {items.find((i) => i.to === location.pathname)?.label ?? 'EventKit'}
          </span>
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

function RequireSuperadmin({ children }: { children: ReactNode }) {
  const { isSuperadmin } = useAuth();
  return isSuperadmin ? <>{children}</> : <Navigate to="/scanner" replace />;
}

export function App() {
  const { admin, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="Loading admin…" />;
  if (!admin) {
    if (location.pathname !== '/login')
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return <LoginPage />;
  }
  if (location.pathname === '/login')
    return <Navigate to={admin.role === 'superadmin' ? '/' : '/scanner'} replace />;

  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireSuperadmin>
                <OverviewPage />
              </RequireSuperadmin>
            }
          />
          <Route
            path="/attendees"
            element={
              <RequireSuperadmin>
                <AttendeesPage />
              </RequireSuperadmin>
            }
          />
          <Route path="/scanner" element={<ScannerPage />} />
          <Route
            path="/attendance"
            element={
              <RequireSuperadmin>
                <AttendancePage />
              </RequireSuperadmin>
            }
          />
          <Route
            path="/phase2"
            element={
              <RequireSuperadmin>
                <Phase2Page />
              </RequireSuperadmin>
            }
          />
          <Route
            path="/monitoring"
            element={
              <RequireSuperadmin>
                <MonitoringPage />
              </RequireSuperadmin>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireSuperadmin>
                <SettingsPage />
              </RequireSuperadmin>
            }
          />
          <Route
            path="*"
            element={<Navigate to={admin.role === 'superadmin' ? '/' : '/scanner'} replace />}
          />
        </Routes>
      </Suspense>
    </Shell>
  );
}
