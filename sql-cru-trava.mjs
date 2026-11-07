// Trava de SQL cru (item 224, trava 4): catraca por arquivo contra uma linha de base.
// Copiar para a raiz do repo do produto e chamar no teste:
//   node sql-cru-trava.mjs                 prova os padroes e confere: sai 1 se algum arquivo passou da base
//   node sql-cru-trava.mjs --gravar        grava/abaixa a base (sql-cru.base.json)
//   node sql-cru-trava.mjs --auto-teste    so prova os padroes deste arquivo
// So conta codigo de app: migrations, testes e scripts ficam fora. A base so desce:
// --gravar recusa subir um arquivo (subir = SQL cru novo, que e justamente o que a trava barra).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const CODIGO = /\.(m?[jt]sx?|cjs|rs|py|go|astro|svelte|vue)$/;
export const FORA = /(^|\/)(node_modules|vendor|dist|build|\.next|\.wrangler|\.svelte-kit|target|coverage|\.open-next|docs|\.claude|\.agents|\.pi)\/|\.d\.ts$/;
// Deste repo: o que nao roda em producao e nao e pego pelas pastas acima.
export const FORA_REPO = /(?!)/;
export const MIGRATION = /(^|\/)(migrations?|drizzle|supabase\/migrations|db\/migrate)\//;
export const TESTE = /(^|\/)(tests?|__tests__|e2e|spec|fixtures?)\/|\.(test|spec|check)\.[a-z]+$|_test\.(rs|py|go)$|(^|\/)test_[^/]+\.py$/;
export const AUX = /(^|\/)(scripts?|tools?|bin|bench|ops|seed|seeds|backfill)\//;

const VERBO = "\\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|PRAGMA|REPLACE|UPSERT)\\b";
const CHAVE = "\\b(?:FROM|INTO|SET|TABLE|INDEX|VALUES|WHERE)\\b";
const TIPO = "(?:<[^>]*>)?"; // db.prepare<Linha>(, sql.exec<Linha>(
// literal (aspas, crase, tagged template do postgres.js, r#"" do Rust, """ do Python) que comeca
// com verbo SQL e tem FROM/INTO/SET... antes de fechar; o que ja esta dentro das chamadas abaixo conta la
const lit = (q) => `${q}${VERBO}[^${q}]{0,800}?${CHAVE}`;
export const PADROES = {
  prepare: new RegExp(`\\.prepare(?:_cached)?\\s*${TIPO}\\s*\\(`, "g"), // D1, better-sqlite3, rusqlite, tokio-postgres
  createRawDb: /\bcreateRawDb\s*\(/g, // HP
  sqlRaw: /\bsql\.raw\s*\(/g,
  unsafe: /\.unsafe\s*\(/g, // postgres.js
  sqlExec: new RegExp(`\\bsql\\s*\\.exec\\s*${TIPO}\\s*\\(`, "g"), // SQLite de Durable Object
  // sqlx com texto montado; o literal direto conta em `literal` e query!/query_as! e o alvo da trava 2
  sqlxTexto: /\bsqlx::query(?:_as|_scalar|_with|_as_with)?(?:::<[^>]*>)?\s*\(\s*(?!r?#*")/g,
  // literal dentro de query!/query_as!/query_scalar! do sqlx nao conta: e o alvo da trava 2
  literal: new RegExp(`(?<!(?:\\.prepare(?:_cached)?\\s*${TIPO}|\\.unsafe|\\bsql\\s*\\.exec\\s*${TIPO})\\s*\\(\\s*(?:r#*)?|\\bquery(?:_as|_scalar)?!\\s*\\(\\s*(?:[\\w:<>]+\\s*,\\s*)?(?:r#*)?)(?:${lit('"')}|${lit("'")}|${lit("\\x60")})`, "gi"),
};

const conta = (re, t) => { re.lastIndex = 0; let n = 0; while (re.exec(t)) n++; return n; };
export function contaSqlCru(texto) {
  const det = {}; let n = 0;
  for (const [k, re] of Object.entries(PADROES)) { const c = conta(re, texto); if (c) { det[k] = c; n += c; } }
  return { n, det };
}
export const classe = (f) => MIGRATION.test(f) ? "migration" : TESTE.test(f) ? "teste" : AUX.test(f) ? "aux" : "app";

function medir(raiz = ".") {
  // -z: nome com acento sai cru; --others: arquivo novo ainda sem git add tambem conta
  const nomes = execFileSync("git", ["-C", raiz, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter((f) => f && CODIGO.test(f) && !FORA.test(f) && !FORA_REPO.test(f) && classe(f) === "app" && !f.endsWith("sql-cru-trava.mjs"));
  const por = {};
  for (const f of nomes) {
    if (!existsSync(`${raiz}/${f}`)) continue;
    // CRLF do checkout no Windows nao pode mudar a conta (o literal tem teto de 800 caracteres)
    const { n } = contaSqlCru(readFileSync(`${raiz}/${f}`, "utf8").replace(/\r\n/g, "\n"));
    if (n) por[f] = n;
  }
  return por;
}

function autoTeste() {
  const casos = [
    ["db.prepare('SELECT 1')", 1], ["env.DB.prepare(`UPDATE x SET a=?`).bind(1)", 1],
    ["await sql`select * from offer where id = ${id}`", 1], ["db.select().from(t).where(eq(t.id, 1))", 0],
    ["cur.execute(\"INSERT INTO nota VALUES (?)\", x)", 1], ["db.QueryRow(\"SELECT id FROM t\")", 1],
    ["/\\d+/.exec(texto)", 0], ["client.query(r#\"select 1 from t\"#, &[])", 1],
    ["db.run(sql`DELETE FROM t`)", 1], ["sql`coalesce(${a}, 0)`", 0], ["sql.raw(q)", 1],
    ["map.get('/x')", 0], ["createRawDb({ databaseUrl })", 1],
    ["await tx`delete from a where id = ${x}`", 1], ["first(db, \"SELECT n FROM t WHERE a = ?\", x)", 1],
    ["const q = `\n  SELECT a\n  FROM t`; pool.query(q)", 1], ["texto = \"Atualizar\"", 0],
    ["cur.execute(\"\"\"\n UPDATE nota SET x = 1\"\"\")", 1], ["msg(\"Delete o post\"); x = 'from'", 0],
    ["sqlx::query!(\"SELECT id FROM t WHERE a = $1\", a)", 0], ["sqlx::query_as!(Linha, r#\"select a from t\"#)", 0],
    ["sqlx::query(\"SELECT id FROM t\")", 1],
    // postgres.js dinamico (HP, Rastreio)
    ["sql.unsafe(q)", 1], ["tx.unsafe(\"select 1 from t\")", 1], ["await sql.unsafe('set lock_timeout = 1')", 1],
    // SQLite de Durable Object (MeuCanalOfertas)
    ["this.ctx.storage.sql.exec('DELETE FROM a WHERE b < ?', 1)", 1], ["ctx.storage.sql.exec(q)", 1],
    ["this.ctx.storage.sql\n  .exec<Linha>(`SELECT * FROM t`)", 1], ["db.prepare<Linha>('SELECT 1')", 1],
    // sqlx com texto montado e sea-query (Painel, HP)
    ["sqlx::query_with(sqlx::AssertSqlSafe(q.0), q.1)", 1], ["sqlx::query(&texto)", 1],
    ["sqlx::query_as::<_, Linha>(\"select a from t\")", 1], ["Query::select().columns([\"a\"]).from(\"offer\")", 0],
    ["CommonTableExpression::new().query(s1)", 0], ["c.req.query('q')", 0],
  ];
  for (const [t, esperado] of casos) {
    const { n } = contaSqlCru(t);
    if (n !== esperado) { console.error(`auto-teste: ${JSON.stringify(t)} deu ${n}, esperado ${esperado}`); process.exit(1); }
  }
  for (const [f, c] of [["drizzle/0001.sql.ts", "migration"], ["src/x.test.ts", "teste"], ["scripts/a.mjs", "aux"], ["src/index.ts", "app"]])
    if (classe(f) !== c) { console.error(`auto-teste: classe(${f}) = ${classe(f)}, esperado ${c}`); process.exit(1); }
  const cr = "`SELECT a\r\nFROM t`";
  if (contaSqlCru(cr).n !== contaSqlCru(cr.replace(/\r\n/g, "\n")).n) { console.error("auto-teste: CRLF mudou a conta"); process.exit(1); }
  return casos.length + 5;
}

if (process.argv[1]?.endsWith("sql-cru-trava.mjs")) {
  const arg = process.argv.slice(2);
  const nCasos = autoTeste();
  if (arg.includes("--auto-teste")) { console.log(`auto-teste: ${nCasos} casos ok`); process.exit(0); }
  const BASE = "sql-cru.base.json";
  const agora = medir();
  const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, "utf8")) : null;
  const subiu = Object.entries(agora).filter(([f, n]) => n > (base?.[f] ?? 0));
  if (arg.includes("--gravar")) {
    if (base && subiu.length) { console.error("recusado: a base so desce. Subiu:\n" + subiu.map(([f, n]) => `  ${f}: ${base[f] ?? 0} -> ${n}`).join("\n")); process.exit(1); }
    writeFileSync(BASE, JSON.stringify(Object.fromEntries(Object.entries(agora).sort()), null, 1) + "\n");
    console.log(`base gravada: ${Object.values(agora).reduce((a, b) => a + b, 0)} pontos em ${Object.keys(agora).length} arquivos`);
    process.exit(0);
  }
  if (!base) { console.error(`sem ${BASE}: rode --gravar uma vez`); process.exit(1); }
  if (subiu.length) {
    console.error("SQL cru novo fora das migrations (use o Drizzle; Rust: sqlx):\n" + subiu.map(([f, n]) => `  ${f}: base ${base[f] ?? 0}, agora ${n}`).join("\n"));
    process.exit(1);
  }
  const desceu = Object.keys(base).filter((f) => (agora[f] ?? 0) < base[f]);
  console.log(`sql-cru ok: ${Object.values(agora).reduce((a, b) => a + b, 0)} pontos${desceu.length ? `; ${desceu.length} arquivo(s) desceram, rode --gravar para abaixar a base` : ""}`);
}
