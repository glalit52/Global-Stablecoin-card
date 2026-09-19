/** Runtime configuration. Everything overridable by environment. */
export interface Config {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly corsOrigins: string[];
  readonly sessionTtlHours: number;
  readonly stepUpTtlMinutes: number;
  /** Seconds an approved authorization hold survives before it is released. */
  readonly authHoldTtlSeconds: number;
  readonly riskTickSeconds: number;
  readonly marketTickSeconds: number;
  /** Optional Anthropic key. Absent means the agent runs deterministic-only. */
  readonly anthropicApiKey: string | null;
  readonly anthropicModel: string;
  readonly nodeEnv: string;
  readonly logLevel: string;
}

const int = (v: string | undefined, fallback: number): number => {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
  port: int(env.PORT, 4000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://wealth:wealth@127.0.0.1:5432/wealthcard',
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()),
  sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
  stepUpTtlMinutes: int(env.STEP_UP_TTL_MINUTES, 5),
  authHoldTtlSeconds: int(env.AUTH_HOLD_TTL_SECONDS, 7 * 24 * 3600),
  riskTickSeconds: int(env.RISK_TICK_SECONDS, 20),
  marketTickSeconds: int(env.MARKET_TICK_SECONDS, 10),
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
  nodeEnv: env.NODE_ENV ?? 'development',
  logLevel: env.LOG_LEVEL ?? 'info',
});
