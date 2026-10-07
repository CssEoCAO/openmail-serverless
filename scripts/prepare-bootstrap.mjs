import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Run explicitly by the operator after migrations. No environment variable or
// Worker Secret is changed; only the hash enters D1, for fifteen minutes.
const target = process.argv[2];
if (!["--local", "--remote"].includes(target) || process.argv.length !== 3) {
  console.error("Usage: node scripts/prepare-bootstrap.mjs --local|--remote");
  process.exit(1);
}
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const expires = Math.floor(Date.now() / 1000) + 900;
const sql = `INSERT INTO app_settings (key,value,updated_at,updated_by)
 SELECT '__setup_authorization','${hash}',${expires},NULL
 WHERE NOT EXISTS (SELECT 1 FROM users)
 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key='__setup_claim')
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`;
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "saasmail-db",
    target,
    "--command",
    sql,
    "--json",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0) {
  console.error(
    "Bootstrap authorization was not provisioned. Check migrations and D1 access.",
  );
  process.exit(1);
}
let changed = false;
try {
  changed = JSON.parse(result.stdout).some((r) => r.meta?.changes > 0);
} catch {}
if (!changed) {
  console.error(
    "Setup is already claimed/completed, or D1 did not confirm the write.",
  );
  process.exit(1);
}
console.log(`Operator bootstrap token (expires in 15 minutes): ${token}`);
