import type { Env } from '../env';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** The parts of "Sign in with Google" the server needs; swappable for dev and tests. */
export interface IdentityProvider {
  readonly kind: 'google' | 'dev';
  /** Where to send the browser to start the sign-in. */
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string }): string;
  /** Exchange the authorization code from the callback for a verified identity. */
  exchange(p: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

export const callbackPath = '/auth/google/callback';
export const callbackUrl = (env: Env) =>
  `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${callbackPath}`;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Google OpenID Connect, authorization-code flow with PKCE. The client secret
 * never leaves the server. The ID token comes straight from Google's token
 * endpoint over TLS, so (per OIDC Core 3.1.3.7) its claims are validated here
 * without fetching Google's signing keys.
 */
export function googleProvider(
  opts: { clientId: string; clientSecret: string; redirectUri: string; now: () => number },
  fetchImpl: FetchLike = fetch,
): IdentityProvider {
  return {
    kind: 'google',
    authorizeUrl({ state, nonce, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        access_type: 'online',
      });
      return `${AUTH_URL}?${q.toString()}`;
    },
    async exchange({ code, codeVerifier, nonce }) {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          redirect_uri: opts.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}`);
      const body = (await res.json()) as { id_token?: string };
      if (!body.id_token) throw new Error('Google returned no ID token');
      return validateIdToken(body.id_token, { clientId: opts.clientId, nonce, now: opts.now() });
    },
  };
}

export function validateIdToken(
  idToken: string,
  expect: { clientId: string; nonce: string; now: number },
): GoogleIdentity {
  const part = idToken.split('.')[1];
  if (!part) throw new Error('malformed ID token');
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nonce?: string;
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
  };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!claims.iss || !ISSUERS.has(claims.iss)) throw new Error('ID token issuer mismatch');
  if (!aud.includes(expect.clientId)) throw new Error('ID token audience mismatch');
  if (!claims.exp || claims.exp * 1000 < expect.now - 60_000) throw new Error('ID token expired');
  if (claims.nonce !== expect.nonce) throw new Error('ID token nonce mismatch');
  if (!claims.sub || !claims.email) throw new Error('ID token has no email');
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name,
  };
}

/**
 * Development stand-in for Google: a local page where you type any email.
 * Only used when NODE_ENV is not production and no Google client is configured.
 */
export function devProvider(): IdentityProvider {
  return {
    kind: 'dev',
    authorizeUrl({ state }) {
      return `/auth/google/dev?${new URLSearchParams({ state }).toString()}`;
    },
    async exchange({ code }) {
      if (!code.startsWith('dev.')) throw new Error('not a development sign-in code');
      const email = Buffer.from(code.slice(4), 'base64url').toString('utf8').trim().toLowerCase();
      return { sub: `dev:${email}`, email, emailVerified: true };
    },
  };
}

export function createIdentityProvider(env: Env, now: () => number): IdentityProvider {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return googleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: callbackUrl(env),
      now,
    });
  }
  if (env.NODE_ENV === 'production') throw new Error('Google sign-in is not configured');
  return devProvider();
}
