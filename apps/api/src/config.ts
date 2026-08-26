import { z } from 'zod';

/**
 * Configuration is validated once at boot and never read from process.env again.
 *
 * A payment system that starts up with a missing signing key and only discovers it when
 * the first agent session tries to act has chosen the worst possible time to fail.
 */
const schema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgres://warrant_app:warrant_app@localhost:5433/warrant'),
  /**
   * Owner connection. Used only by migrations and by the demo reset, which deletes rows
   * from the append-only ledger and audit tables that the application role is -- by
   * design -- not permitted to touch.
   */
  DATABASE_ADMIN_URL: z.string().default('postgres://warrant:warrant@localhost:5433/warrant'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  CAPABILITY_PRIVATE_KEY: z.string().min(1),
  CAPABILITY_PUBLIC_KEY: z.string().min(1),

  MODEL_PROVIDER: z.enum(['fixture', 'anthropic']).default('fixture'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  SIMULATOR_SEED: z.string().default('warrant-dev'),

  /** How long a human approval stays valid before the plan must be re-approved. */
  APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Worker poll interval for the outbox drain. */
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(250),
});

export type Config = z.infer<typeof schema> & {
  capabilityPrivateKey: string;
  capabilityPublicKey: string;
};

/** PEM blocks arrive from .env with literal backslash-n sequences. */
const unescapePem = (value: string): string => value.replace(/\\n/g, '\n');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${issues}`);
  }

  const cfg = parsed.data;

  if (cfg.MODEL_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    throw new Error('MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }

  return {
    ...cfg,
    capabilityPrivateKey: unescapePem(cfg.CAPABILITY_PRIVATE_KEY),
    capabilityPublicKey: unescapePem(cfg.CAPABILITY_PUBLIC_KEY),
  };
}
