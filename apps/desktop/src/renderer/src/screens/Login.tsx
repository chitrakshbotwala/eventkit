import { useState } from 'react';
import type { AuthState } from '@common/ipc';
import { Banner, Button, Card, Spinner } from '../components/ui';
import { ek } from '../lib/hooks';

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function Login({
  onSignedIn,
  notice,
  simulate,
}: {
  onSignedIn: (s: AuthState) => void;
  notice?: string;
  simulate?: boolean;
}) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  async function signIn() {
    setError(null);
    setWaiting(true);
    try {
      onSignedIn(await ek.auth.signInWithGoogle());
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code !== 'cancelled') setError({ code: e.code, message: e.message });
    } finally {
      setWaiting(false);
    }
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
            Sign in with the Google account you RSVP&apos;d with.
          </p>
        </div>
        <Card>
          <div className="space-y-4">
            {notice && <Banner tone="warn">{notice}</Banner>}
            {error && (
              <Banner tone="error">
                {error.message}
                {error.code === 'not_registered' && (
                  <span className="mt-1 block">
                    If you RSVP&apos;d with a different email, sign in with that Google account, or
                    ask the help desk to update your RSVP email.
                  </span>
                )}
              </Banner>
            )}
            {waiting ? (
              <div className="space-y-4 text-center">
                <div className="flex items-center justify-center gap-2 text-sm">
                  <Spinner /> Finish signing in in your browser…
                </div>
                <div className="flex justify-center gap-2">
                  <Button onClick={() => void ek.auth.reopenSignIn()}>Open browser again</Button>
                  <Button onClick={() => void ek.auth.cancelSignIn()}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" className="w-full" onClick={() => void signIn()}>
                <GoogleMark /> Continue with Google
              </Button>
            )}
          </div>
        </Card>
        <p className="mt-4 text-center text-xs text-slate-500">
          Your browser opens Google&apos;s sign-in page. EventKit only learns your name and email.
          {simulate && ' (Development server: the browser shows a test page instead of Google.)'}
        </p>
      </div>
    </div>
  );
}
