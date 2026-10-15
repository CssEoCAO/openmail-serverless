#!/usr/bin/env node
// Blocks secrets and deployment config from reaching this public repository.
//
//   node scripts/check-leaks.mjs            scan every tracked file (CI)
//   node scripts/check-leaks.mjs --staged   scan what is about to be committed (pre-commit)
//   node scripts/check-leaks.mjs --message <file>   scan a commit message (commit-msg)
//
// The patterns below are generic. Terms specific to one deployment (company
// registration numbers, phone numbers, personal addresses, account IDs) go in
// `.leaks.local`, which is gitignored, one JavaScript regex per line. Lines
// starting with `#` are comments; a line starting with `readme-ok:` does not
// apply to README.md (for links the README is meant to carry).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const FORBIDDEN_FILES = [
  /(^|\/)wrangler\.jsonc$/,
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.env(\.[\w-]+)?$/,
  /\.(pem|p12|pfx|key)$/,
  /(^|\/)\.leaks\.local$/,
];
const ALLOWED_FILES = [/\.example$/, /\.ci$/];

const PATTERNS = [
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{12,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  [
    "GitHub token",
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/,
  ],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Cloudflare API token", /\bcf(at|ut)_[A-Za-z0-9_-]{20,}/],
  // All-zero IDs are the placeholders the CI config uses.
  ["Cloudflare account_id", /"account_id"\s*:\s*"(?!0{32}")[0-9a-f]{32}"/],
  [
    "D1 database_id",
    /"database_id"\s*:\s*"(?!0{8}-0{4}-0{4}-0{4}-0{12}")[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/,
  ],
];

function localPatterns() {
  if (!existsSync(".leaks.local")) return [];
  return readFileSync(".leaks.local", "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const readmeOk = l.startsWith("readme-ok:");
      const src = readmeOk ? l.slice("readme-ok:".length).trim() : l;
      return ["local term", new RegExp(src, "i"), readmeOk];
    });
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

function sources(mode, arg) {
  if (mode === "message")
    return [[`commit message`, readFileSync(arg, "utf8")]];
  const names =
    mode === "staged"
      ? git(
          "diff",
          "--cached",
          "--name-only",
          "--diff-filter=ACMR",
          "-z",
        ).split("\0")
      : git("ls-files", "-z").split("\0");
  return names
    .filter(Boolean)
    .map((name) => [name, mode === "staged" ? `:${name}` : null]);
}

function read(name, ref) {
  try {
    const buf = ref
      ? execFileSync("git", ["show", ref], { maxBuffer: 1 << 28 })
      : readFileSync(name);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const mode = args.includes("--staged")
  ? "staged"
  : args.includes("--message")
    ? "message"
    : "all";
const patterns = [
  ...PATTERNS.map(([n, r]) => [n, r, false]),
  ...localPatterns(),
];
const problems = [];

for (const [name, ref] of sources(mode, args[args.indexOf("--message") + 1])) {
  if (
    mode !== "message" &&
    FORBIDDEN_FILES.some((r) => r.test(name)) &&
    !ALLOWED_FILES.some((r) => r.test(name))
  ) {
    problems.push(`${name}: file must not be committed`);
    continue;
  }
  const text = mode === "message" ? ref : read(name, ref);
  if (text == null) continue;
  const isReadme = /(^|\/)README\.md$/i.test(name);
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, re, readmeOk] of patterns) {
      if (readmeOk && isReadme) continue;
      if (re.test(line))
        problems.push(`${name}:${i + 1}: ${label} (${re.source.slice(0, 40)})`);
    }
  });
}

if (problems.length) {
  console.error("check-leaks: refusing, found:\n  " + problems.join("\n  "));
  console.error(
    "Remove it, or move deployment-specific values to a gitignored file.",
  );
  process.exit(1);
}
console.log(`check-leaks: ok (${mode}, ${patterns.length} patterns)`);
