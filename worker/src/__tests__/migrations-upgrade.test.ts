import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";

/**
 * Runs the real `migrations/*.sql` files, in order, against an empty D1 — not
 * the hand-written `CREATE TABLE` fixtures the other tests use.
 *
 * What it pins: an installation that already applied 0001..0037 (so it holds
 * `reply_drafts`) upgrades through 0038..0042 and ends with its reply drafts in
 * the one `drafts` table, the old table gone, and both the per-sender outbound
 * provider and the Gmail source columns on `sender_identities`.
 */

const files = import.meta.glob("../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Split one migration file into statements. drizzle files separate them with
 * `--> statement-breakpoint`; hand-written ones (FTS, triggers) may hold several
 * statements, so those are split on `;` outside a BEGIN … END (CASE … END too).
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  for (const block of sql.split("--> statement-breakpoint")) {
    let depth = 0;
    let current = "";
    for (const line of block.split("\n")) {
      current += line + "\n";
      const code = line.replace(/--.*$/, "");
      for (const word of code.match(/\b[A-Za-z_]+\b/g) ?? []) {
        const w = word.toUpperCase();
        if (w === "BEGIN" || w === "CASE") depth++;
        else if (w === "END") depth--;
      }
      if (depth <= 0 && code.trim().endsWith(";")) {
        if (current.replace(/--.*$/gm, "").trim() !== "") out.push(current);
        current = "";
        depth = 0;
      }
    }
    if (current.replace(/--.*$/gm, "").trim() !== "") out.push(current);
  }
  return out;
}

async function apply(list: { name: string; sql: string }[]) {
  for (const m of list) {
    for (const stmt of statements(m.sql)) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (err) {
        throw new Error(
          `${m.name} failed on:\n${stmt}\n${(err as Error).message}`,
        );
      }
    }
  }
}

describe("migrations 0001 → 0043 on an existing installation", () => {
  beforeAll(async () => {
    // Start from nothing, whatever an earlier file in this worker left behind.
    const { results } = await env.DB.prepare(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view')",
    ).all<{ name: string; type: string }>();
    await env.DB.prepare("PRAGMA foreign_keys = OFF").run();
    for (const r of results) {
      await env.DB.prepare(
        `DROP ${r.type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${r.name}"`,
      ).run();
    }
  });

  it("has one numbered file per journal entry, 0000 to 0043", () => {
    const names = migrations.map((m) => m.name);
    expect(names[0]).toBe("0000_skinny_agent_zero.sql");
    expect(names.at(-1)).toMatch(/^0043_/);
    const nums = names.map((n) => n.slice(0, 4));
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums).toEqual(
      Array.from({ length: nums.length }, (_, i) => String(i).padStart(4, "0")),
    );
  });

  it("copies reply_drafts into drafts, then drops reply_drafts", async () => {
    const before = migrations.filter((m) => m.name < "0038");
    const after = migrations.filter((m) => m.name >= "0038");
    expect(before.at(-1)!.name).toMatch(/^0037_reply_drafts/);

    await apply(before);

    // An installation as it stands at 0037: a user with two reply drafts, one
    // with a CC list and one without.
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.com', 1, 'admin', 1, 1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO reply_drafts (user_id, email_id, from_address, cc, body_html, body_text, updated_at) VALUES ('u1', 'email-a', 'support@example.com', '[{\"email\":\"cc@example.com\",\"name\":\"Cee\"}]', '<p>a</p>', 'a', 1700000100)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO reply_drafts (user_id, email_id, from_address, cc, body_html, body_text, updated_at) VALUES ('u1', 'email-b', 'support@example.com', NULL, '<p>b</p>', 'b', 1700000200)",
    ).run();

    await apply(after);

    const { results } = await env.DB.prepare(
      "SELECT context_key, user_id, from_address, to_address, cc, subject, body_html, body_text, reply_to_email_id, created_at, updated_at FROM drafts ORDER BY context_key",
    ).all<Record<string, unknown>>();
    expect(results).toEqual([
      {
        context_key: "reply:email-a",
        user_id: "u1",
        from_address: "support@example.com",
        to_address: null,
        cc: '[{"email":"cc@example.com","name":"Cee"}]',
        subject: null,
        body_html: "<p>a</p>",
        body_text: "a",
        reply_to_email_id: "email-a",
        created_at: 1700000100,
        updated_at: 1700000100,
      },
      {
        context_key: "reply:email-b",
        user_id: "u1",
        from_address: "support@example.com",
        to_address: null,
        cc: null,
        subject: null,
        body_html: "<p>b</p>",
        body_text: "b",
        reply_to_email_id: "email-b",
        created_at: 1700000200,
        updated_at: 1700000200,
      },
    ]);

    // Every copied draft got its own id.
    const ids = await env.DB.prepare("SELECT DISTINCT id FROM drafts").all();
    expect(ids.results).toHaveLength(2);

    // The old table is gone; the Gmail tables and columns are there.
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    const names = tables.results.map((t) => t.name);
    expect(names).not.toContain("reply_drafts");
    expect(names).toContain("drafts");
    expect(names).toContain("gmail_accounts");

    const cols = await env.DB.prepare(
      "PRAGMA table_info(sender_identities)",
    ).all<{ name: string }>();
    const identityCols = cols.results.map((c) => c.name);
    expect(identityCols).toEqual(
      expect.arrayContaining([
        "outbound_provider",
        "source",
        "gmail_account_id",
        "gmail_group_address",
      ]),
    );
  });

  it("running the copy again leaves a draft the new UI already saved alone", async () => {
    await env.DB.prepare(
      "UPDATE drafts SET body_text = 'edited in the new UI' WHERE context_key = 'reply:email-a'",
    ).run();
    const copy = migrations.find((m) => m.name.startsWith("0041_"))!;
    // reply_drafts no longer exists here; recreate it to replay the backfill.
    await env.DB.prepare(
      "CREATE TABLE reply_drafts (user_id TEXT NOT NULL, email_id TEXT NOT NULL, from_address TEXT NOT NULL, cc TEXT, body_html TEXT NOT NULL, body_text TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, email_id))",
    ).run();
    await env.DB.prepare(
      "INSERT INTO reply_drafts VALUES ('u1', 'email-a', 'support@example.com', NULL, '<p>old</p>', 'old', 1700000100)",
    ).run();
    await apply([copy]);

    const row = await env.DB.prepare(
      "SELECT body_text FROM drafts WHERE context_key = 'reply:email-a'",
    ).first<{ body_text: string }>();
    expect(row!.body_text).toBe("edited in the new UI");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM drafts",
    ).first<{ n: number }>();
    expect(count!.n).toBe(2);
  });
});
