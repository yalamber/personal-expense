import { eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { AppEnv } from "../env";
import { base64url } from "../lib/crypto";

const KEY = "auth_secret";
let cached: string | null = null;

/**
 * The secret that signs session cookies.
 *
 * Uses the AUTH_SECRET Worker secret when it is set. Otherwise a 256-bit random secret is
 * generated on first use and stored in app_settings, so a fresh deploy works with no manual
 * secret step. INSERT OR IGNORE plus a re-read means concurrent first requests agree on one value.
 */
export async function getAuthSecret(db: Db, env: AppEnv): Promise<string> {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (cached) return cached;

  const existing = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, KEY) });
  if (existing) return (cached = existing.value);

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  await db.insert(schema.appSettings).values({ key: KEY, value: base64url(bytes) }).onConflictDoNothing();
  const row = await db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, KEY) });
  if (!row) throw new Error("could not create the session secret");
  return (cached = row.value);
}
