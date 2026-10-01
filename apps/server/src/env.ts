import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Public HTTPS origin of this server, e.g. https://event.example.org */
    PUBLIC_BASE_URL: z.url().default('http://localhost:8080'),
    /** Extra allowed origins for the admin site (comma separated), e.g. the Vite dev server. */
    ADMIN_ORIGINS: z.string().default(''),
    TRUST_PROXY: bool(false),
    DATABASE_URL: z.string().default('file:./dev.db'),
    DATA_DIR: z.string().default('./data'),
    ADMIN_STATIC_DIR: z.string().default('../admin/dist'),

    EVENT_SLUG: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('flutter-event'),
    EVENT_NAME: z.string().default('Flutter Build Day'),
    EVENT_TIMEZONE: z.string().default('UTC'),

    MANIFEST_SIGNING_KEY: z.string().optional(),
    MANIFEST_ALLOW_PLACEHOLDER: bool(true),
    MANIFEST_TTL_HOURS: z.coerce.number().positive().default(72),
    MIN_APP_VERSION: z.string().default('0.1.0'),

    /** Google OAuth "Web application" client used for attendee sign-in. */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    CONTACT_HINT: z.string().default('Not on the list? Contact the organizers at the help desk.'),

    SUPERADMIN_EMAIL: z.string().optional(),
    SUPERADMIN_PASSWORD: z.string().optional(),

    GITHUB_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production',
      });
    }
    if (!env.MANIFEST_SIGNING_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['MANIFEST_SIGNING_KEY'],
        message: 'required in production',
      });
    }
    if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'must be https in production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const env = parsed.data;
  return {
    ...env,
    MANIFEST_ALLOW_PLACEHOLDER:
      env.NODE_ENV === 'production' ? false : env.MANIFEST_ALLOW_PLACEHOLDER,
  };
}

export const isProd = (env: Env) => env.NODE_ENV === 'production';
