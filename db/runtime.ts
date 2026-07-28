let ready: Promise<void> | null = null;

/**
 * Schema changes are applied explicitly with `npm run db:migrate`.
 * Keeping this shared guard preserves the store API without running DDL during
 * every serverless cold start.
 */
export function ensureDatabase(): Promise<void> {
  ready ??= Promise.resolve();
  return ready;
}
