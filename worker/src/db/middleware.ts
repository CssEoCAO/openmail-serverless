import { drizzle } from "drizzle-orm/d1";
import type { Context, Next } from "hono";
import { schema } from "./schema";

export async function injectDb(c: Context, next: Next) {
  const db = drizzle(c.env.DB, { schema });
  c.set("db", db);
  return await next();
}
