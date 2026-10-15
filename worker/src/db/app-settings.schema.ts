import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * App-wide admin-configurable settings, stored as a key-value table.
 * See migration 0024_app_settings.sql for rationale.
 *
 * Known keys (so far):
 *   - "brand_name": display name shown in the top nav + auth screens.
 *     Falls back to "OpenMail Serverless" if NULL or unset.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});
