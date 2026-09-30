import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env';

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
  /** True when a real SMTP transport is configured. */
  readonly configured: boolean;
  verify(): Promise<void>;
}

export function createMailer(env: Env, log: FastifyBaseLogger): Mailer {
  let transport: Transporter | null = null;
  if (env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  } else if (env.NODE_ENV === 'production') {
    log.warn('SMTP_HOST is not set: OTP emails cannot be delivered');
  }

  return {
    configured: Boolean(transport),
    async send(to, subject, text, html) {
      if (!transport) {
        if (env.NODE_ENV === 'production') throw new Error('SMTP not configured');
        // Development only: print the message instead of sending it.
        log.info({ to, subject }, `[dev mail] ${text}`);
        return;
      }
      await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    },
    async verify() {
      if (!transport) throw new Error('SMTP not configured');
      await transport.verify();
    },
  };
}
