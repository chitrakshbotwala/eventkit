import { useEffect, useState } from 'react';
import { Badge } from './components/ui';
import { UpdateBar } from './components/UpdateBar';
import { useAppInfo, useAuth, useSetup, useUpdates } from './lib/hooks';
import { Login } from './screens/Login';
import { Phase2 } from './screens/Phase2';
import { Profile } from './screens/Profile';
import { Settings } from './screens/Settings';
import { Setup } from './screens/Setup';

type Tab = 'setup' | 'profile' | 'phase2' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'setup', label: 'Setup' },
  { id: 'profile', label: 'Profile & QR' },
  { id: 'phase2', label: 'Offline phase' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const info = useAppInfo();
  const [auth, setAuth] = useAuth();
  const setup = useSetup();
  const update = useUpdates();
  const [tab, setTab] = useState<Tab>('setup');
  const [autoRouted, setAutoRouted] = useState(false);

  // Once setup is complete, land on the profile (QR) screen.
  useEffect(() => {
    if (!autoRouted && setup?.complete) {
      setTab('profile');
      setAutoRouted(true);
    }
  }, [setup?.complete, autoRouted]);

  if (!auth) return null;
  // Shown on the sign-in screen too: an update may be the fix for a sign-in problem.
  if (!auth.signedIn)
    return (
      <div className="flex h-full flex-col">
        <UpdateBar update={update} />
        <div className="min-h-0 flex-1">
          <Login onSignedIn={setAuth} notice={auth.error} simulate={info?.simulate} />
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <UpdateBar update={update} />
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            EK
          </div>
          <div>
            <div className="text-sm font-semibold">EventKit</div>
            <div className="text-xs text-slate-500">{auth.profile?.name}</div>
          </div>
          {info?.simulate && <Badge tone="amber">SIMULATE</Badge>}
        </div>
        <nav className="flex gap-1" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === t.id
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'setup' && <Setup snap={setup} onDone={() => setTab('profile')} />}
        {tab === 'profile' && (
          <Profile auth={auth} setup={setup} info={info} onGoSetup={() => setTab('setup')} />
        )}
        {tab === 'phase2' && <Phase2 />}
        {tab === 'settings' && (
          <Settings info={info} setup={setup} update={update} onGoSetup={() => setTab('setup')} />
        )}
      </main>
    </div>
  );
}
