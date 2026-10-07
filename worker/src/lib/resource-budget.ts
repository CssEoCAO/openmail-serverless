import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { HTTPException } from "hono/http-exception";

/** Fixed keys are reused across windows: requests cannot create one row per
 * attempt. D1 atomically resets or increments only while budget remains. */
export async function reserveBudget(
  db: DrizzleD1Database<any>,
  key: string,
  amount: number,
  limit: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > limit)
    throw new HTTPException(429, { message: "Operation budget exceeded" });
  const start = Math.floor(now / windowSeconds) * windowSeconds;
  const rows = await db.all<{ key: string }>(sql`
    INSERT INTO app_settings (key,value,updated_at,updated_by)
    VALUES (${`__budget:${key}:${windowSeconds}`}, ${String(amount)}, ${start}, NULL)
    ON CONFLICT(key) DO UPDATE SET
      value = CASE WHEN app_settings.updated_at < ${start} THEN ${String(amount)} ELSE CAST(app_settings.value AS INTEGER) + ${amount} END,
      updated_at = ${start}
    WHERE app_settings.updated_at < ${start} OR CAST(app_settings.value AS INTEGER) + ${amount} <= ${limit}
    RETURNING key
  `);
  if (!rows.length)
    throw new HTTPException(429, {
      message: "Operation budget exceeded; retry later",
    });
}

export async function reserveSendBudget(
  db: DrizzleD1Database<any>,
  inbox: string,
  recipients: number,
): Promise<void> {
  for (const [key, minute, daily] of [
    ["send:all", 120, 2000],
    [`send:${inbox}`, 60, 1000],
  ] as const) {
    await reserveBudget(db, key, recipients, minute, 60);
    await reserveBudget(db, key, recipients, daily, 86400);
  }
}
