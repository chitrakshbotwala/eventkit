import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Banner, Button, Field, Input, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';

export function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password, needTotp ? totp.trim() : undefined);
      if (res.status === 'totp_required') {
        setNeedTotp(true);
      } else {
        qc.setQueryData(['me'], res.admin);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center bg-gradient-to-b from-brand-50 to-slate-50 p-6 dark:from-slate-900 dark:to-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-brand-600 text-lg font-bold text-white shadow">EK</div>
          <h1 className="text-xl font-semibold">EventKit Admin</h1>
          <p className="mt-1 text-sm text-slate-500">Organizers and door volunteers</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          {!needTotp ? (
            <>
              <Field label="Email">
                {(id) => <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
              <Field label="Password">
                {(id) => (
                  <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                )}
              </Field>
            </>
          ) : (
            <Field label="Authenticator code" hint="Enter the 6-digit code from your authenticator app.">
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                  className="text-center text-lg tracking-[0.4em]"
                />
              )}
            </Field>
          )}
          {error && <Banner tone="error">{error}</Banner>}
          <Button variant="primary" type="submit" className="w-full" disabled={busy}>
            {busy && <Spinner />} {needTotp ? 'Verify' : 'Sign in'}
          </Button>
          {needTotp && (
            <button type="button" className="w-full text-center text-xs text-slate-500 hover:underline" onClick={() => setNeedTotp(false)}>
              Back
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
