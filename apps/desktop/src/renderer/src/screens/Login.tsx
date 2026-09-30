import { useState, type FormEvent } from 'react';
import type { AuthState } from '@common/ipc';
import { Banner, Button, Card, Spinner } from '../components/ui';
import { ek, useAction } from '../lib/hooks';

export function Login({
  onSignedIn,
  notice,
  simulate,
}: {
  onSignedIn: (s: AuthState) => void;
  notice?: string;
  simulate?: boolean;
}) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const request = useAction(ek.auth.requestOtp);
  const verify = useAction(ek.auth.verifyOtp);

  async function submitEmail(e: FormEvent) {
    e.preventDefault();
    const res = await request.run(email.trim());
    if (res) {
      setMessage(res.message);
      setStep('code');
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    const res = await verify.run(email.trim(), code.trim());
    if (res) onSignedIn(res);
  }

  return (
    <div className="grid h-full place-items-center bg-gradient-to-b from-brand-50 to-slate-50 p-6 dark:from-slate-900 dark:to-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-xl font-bold text-white shadow-lg">
            EK
          </div>
          <h1 className="text-2xl font-semibold">Welcome to the event</h1>
          <p className="mt-1 text-sm text-slate-500">
            Sign in with the email you RSVP&apos;d with.
          </p>
        </div>
        <Card>
          {notice && (
            <div className="mb-4">
              <Banner tone="warn">{notice}</Banner>
            </div>
          )}
          {step === 'email' ? (
            <form onSubmit={submitEmail} className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium">Email</span>
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
                  placeholder="you@example.com"
                />
              </label>
              {request.error && <Banner tone="error">{request.error}</Banner>}
              <Button
                variant="primary"
                type="submit"
                className="w-full"
                disabled={request.busy || !email}
              >
                {request.busy && <Spinner />} Send me a code
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4">
              {message && <Banner tone="info">{message}</Banner>}
              <label className="block">
                <span className="text-sm font-medium">6-digit code</span>
                <input
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-2xl tracking-[0.5em] outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
                  placeholder="••••••"
                />
              </label>
              {verify.error && <Banner tone="error">{verify.error}</Banner>}
              <Button
                variant="primary"
                type="submit"
                className="w-full"
                disabled={verify.busy || code.length !== 6}
              >
                {verify.busy && <Spinner />} Sign in
              </Button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  className="text-slate-500 hover:underline"
                  onClick={() => setStep('email')}
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  className="text-brand-600 hover:underline disabled:opacity-50"
                  disabled={request.busy}
                  onClick={() =>
                    void request.run(email.trim()).then((r) => r && setMessage(r.message))
                  }
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </Card>
        <p className="mt-4 text-center text-xs text-slate-500">
          Not on the list? Contact the organizers at the help desk.
          {simulate && ' (Simulate mode: codes are printed in the server console.)'}
        </p>
      </div>
    </div>
  );
}
