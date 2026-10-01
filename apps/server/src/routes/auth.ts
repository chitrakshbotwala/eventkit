import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { EmailSchema, SignInExchangeBodySchema, SignInStartQuerySchema } from '@eventkit/shared';
import { parse } from '../lib/errors';
import { requireAttendee } from '../plugins/auth';
import { callbackPath } from '../services/google';
import { exchangeSignIn, finishSignIn, startSignIn } from '../services/signin';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function page(reply: FastifyReply, title: string, body: string, csp?: string) {
  if (csp) reply.header('content-security-policy', csp);
  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f5f9;color:#0f172a}
  main{max-width:28rem;margin:1rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 10px 30px #0f172a1a}
  h1{font-size:1.25rem;margin:0 0 .5rem} p{color:#475569} input{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #cbd5e1;border-radius:.5rem;font:inherit}
  button{margin-top:.75rem;width:100%;padding:.6rem;border:0;border-radius:.5rem;background:#2563eb;color:#fff;font:inherit;cursor:pointer}
  ul{padding:0;list-style:none} li a{display:block;padding:.4rem .6rem;border-radius:.4rem;color:#1d4ed8;text-decoration:none} li a:hover{background:#eff6ff}
  .tag{display:inline-block;font-size:.75rem;padding:.1rem .5rem;border-radius:1rem;background:#fef3c7;color:#92400e}
</style></head><body><main>${body}</main></body></html>`);
}

const CallbackQuerySchema = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

export async function attendeeAuthRoutes(app: FastifyInstance) {
  const { ctx } = app;

  // Step 1: the desktop app opens this in the system browser.
  app.get(
    '/auth/google/start',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = SignInStartQuerySchema.safeParse(req.query);
      if (!q.success) {
        return page(
          reply.status(400),
          'Invalid sign-in link',
          '<h1>Invalid sign-in link</h1><p>Open EventKit and click <b>Continue with Google</b>.</p>',
        );
      }
      return reply.redirect(await startSignIn(ctx, q.data, req.ip), 302);
    },
  );

  // Step 2: Google sends the browser back here; we hand off to the app's listener.
  app.get(
    callbackPath,
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = CallbackQuerySchema.safeParse(req.query);
      const result = q.success
        ? await finishSignIn(ctx, q.data, req.ip)
        : { page: 'invalid' as const };
      if ('redirect' in result) return reply.redirect(result.redirect, 302);
      return page(
        reply.status(400),
        'Sign-in link expired',
        '<h1>This sign-in link has expired</h1><p>It was already used or is too old. Go back to EventKit and click <b>Continue with Google</b> again.</p>',
      );
    },
  );

  // Step 3: the app redeems the one-time code with its PKCE verifier.
  app.post(
    '/auth/google/exchange',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(SignInExchangeBodySchema, req.body);
      return exchangeSignIn(ctx, body, req.ip);
    },
  );

  app.post('/auth/logout', { preHandler: requireAttendee }, async (req) => {
    await ctx.prisma.session.update({
      where: { id: req.sessionId! },
      data: { revokedAt: new Date(ctx.now()) },
    });
    return { ok: true };
  });

  // Development stand-in for Google's account picker (never registered in production).
  if (ctx.identity.kind !== 'dev') return;

  const devCsp =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";

  app.get('/auth/google/dev', async (req, reply) => {
    const state = z.object({ state: z.string().max(256) }).safeParse(req.query);
    if (!state.success) return page(reply.status(400), 'Invalid', '<h1>Invalid request</h1>');
    const event = await ctx.event();
    const attendees = await ctx.prisma.attendee.findMany({
      where: { eventId: event.id },
      orderBy: { name: 'asc' },
      take: 30,
      select: { email: true, name: true },
    });
    const link = (email: string) =>
      `/auth/google/dev/continue?${new URLSearchParams({ state: state.data.state, email }).toString()}`;
    return page(
      reply,
      'Development sign-in',
      `<span class="tag">development only</span>
<h1>Choose an account</h1>
<p>Google sign-in is not configured on this server, so any email is accepted here.</p>
<form method="get" action="/auth/google/dev/continue">
  <input type="hidden" name="state" value="${esc(state.data.state)}">
  <input type="email" name="email" placeholder="you@example.com" required autofocus>
  <button type="submit">Continue</button>
</form>
<ul>${attendees.map((a) => `<li><a href="${esc(link(a.email))}">${esc(a.name)} &lt;${esc(a.email)}&gt;</a></li>`).join('')}</ul>`,
      devCsp,
    );
  });

  app.get('/auth/google/dev/continue', async (req, reply) => {
    const q = z.object({ state: z.string().max(256), email: EmailSchema }).safeParse(req.query);
    if (!q.success) return page(reply.status(400), 'Invalid', '<h1>Enter a valid email</h1>');
    const code = `dev.${Buffer.from(q.data.email).toString('base64url')}`;
    return reply.redirect(
      `${callbackPath}?${new URLSearchParams({ state: q.data.state, code }).toString()}`,
      302,
    );
  });
}
