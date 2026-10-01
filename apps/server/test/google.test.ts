import { describe, expect, it } from 'vitest';
import { googleProvider, validateIdToken } from '../src/services/google';

const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);
const CLIENT = 'cid.apps.googleusercontent.com';

const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');

const good = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  exp: NOW / 1000 + 3600,
  nonce: 'n1',
  sub: '1234',
  email: 'Asha@Example.com',
  email_verified: true,
  name: 'Asha Rao',
};

describe('Google ID token validation', () => {
  it('accepts a valid token and normalises the email', () => {
    expect(validateIdToken(jwt(good), { clientId: CLIENT, nonce: 'n1', now: NOW })).toEqual({
      sub: '1234',
      email: 'asha@example.com',
      emailVerified: true,
      name: 'Asha Rao',
    });
    const strVerified = validateIdToken(jwt({ ...good, email_verified: 'true' }), {
      clientId: CLIENT,
      nonce: 'n1',
      now: NOW,
    });
    expect(strVerified.emailVerified).toBe(true);
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }, /issuer/],
    ['audience', { aud: 'other-client' }, /audience/],
    ['expiry', { exp: NOW / 1000 - 3600 }, /expired/],
    ['nonce', { nonce: 'replayed' }, /nonce/],
    ['email', { email: undefined }, /email/],
  ])('rejects a wrong %s', (_name, over, msg) => {
    expect(() =>
      validateIdToken(jwt({ ...good, ...over }), { clientId: CLIENT, nonce: 'n1', now: NOW }),
    ).toThrow(msg);
  });

  it('exchanges the code at Google with the secret and PKCE verifier', async () => {
    let sent: URLSearchParams | null = null;
    const provider = googleProvider(
      {
        clientId: CLIENT,
        clientSecret: 's3cret',
        redirectUri: 'https://event.test/cb',
        now: () => NOW,
      },
      async (url, init) => {
        expect(url).toBe('https://oauth2.googleapis.com/token');
        sent = new URLSearchParams(String(init.body));
        return new Response(JSON.stringify({ id_token: jwt(good) }), { status: 200 });
      },
    );
    const id = await provider.exchange({ code: 'abc', codeVerifier: 'v'.repeat(43), nonce: 'n1' });
    expect(id.email).toBe('asha@example.com');
    expect(Object.fromEntries(sent!)).toMatchObject({
      code: 'abc',
      client_id: CLIENT,
      client_secret: 's3cret',
      redirect_uri: 'https://event.test/cb',
      grant_type: 'authorization_code',
      code_verifier: 'v'.repeat(43),
    });
  });

  it('surfaces token endpoint failures', async () => {
    const provider = googleProvider(
      { clientId: CLIENT, clientSecret: 's', redirectUri: 'https://e/cb', now: () => NOW },
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await expect(provider.exchange({ code: 'x', codeVerifier: 'v', nonce: 'n' })).rejects.toThrow(
      /400/,
    );
  });
});
