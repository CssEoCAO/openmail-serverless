# Security changes — September 2026

A hardening pass over setup, sending limits, OAuth client registration, timelines, email HTML and logging. Migration `0038_security_oauth_client_cap.sql` adds the OAuth client cap trigger; apply migrations with the normal workflow before serving this version. No environment variables or secrets are added or changed.

## First administrator

A new installation no longer grants admin to the first anonymous caller. After the database migrations, an operator with existing Wrangler/D1 access explicitly runs `node scripts/prepare-bootstrap.mjs --local` for a local installation, or `node scripts/prepare-bootstrap.mjs --remote` for the selected production database. The latter is an operator instruction, not part of the tests or an automatically executed command.

The CLI prints a one-time token; paste it into the onboarding form within 15 minutes. Only its hash is stored in the existing `app_settings` table. The setup claim is atomic; the authorization is removed after successful creation. The command refuses an already initialized installation. Do not save the printed token in logs, a file, an environment variable or source control. Existing accounts and passkeys need no bootstrap action.

## Limits and public behavior

- Outbound admissions share a global recipient budget (120/minute and 2,000/day) and a sender-inbox budget (60/minute and 1,000/day), including CC recipients. Compose/reply/template requests reserve before writing attachments or cancelling active sequences; the outbox consumes a request-local, envelope-bound ticket once instead of charging admission again. Sequence enrollment reserves at most 2,000 steps/day globally. A rejected later reservation can conservatively consume an earlier budget; retry after the window. The shared outbox path covers UI, REST, templates, replies, MCP and sequence sends. These limits bound new admissions, not an infrastructure billing guarantee.
- Public OAuth client registration accepts at most 16 KiB, 100 attempts/day globally and 5/minute per bounded origin shard. An atomic database trigger caps all client insertions at 500. Anonymous clients older than seven days are reclaimed only if they have no owner, consent, access token or refresh token. Managed clients are retained even before their first authorization. Existing connected clients remain usable. Consent labels names/websites as unverified and displays the actual normalized authorization destination.
- Person and conversation timelines return at most 10 messages per page, selecting IDs before bodies. Use `page` and the Newer/Older controls; MCP `list_emails` has the same maximum. Inbox permissions apply before pagination.
- Email HTML has two paths. HTML inlined into the authenticated app (signatures, compose and reply previews) keeps basic text, tables, emphasis and links; CSS, images, forms, active elements and styling hooks are removed. The reading pane shows the original email (CSS, tables, images) inside a sandboxed iframe with no scripts and its own CSP; scripts, forms, embeds and event handlers are still removed, and remote images stay blocked until you load them.
- Password failures retain Better Auth's response, including for passkey accounts. A successful password check for a passkey account does not release a session. Bulk mark-read never turns a denied inbox into unrestricted access.
- Old unsubscribe links remain valid for opting out only. Undo is a separate five-minute, one-use capability tied to the newly created suppression. It cannot clear an existing or later opt-out. No undo capability is issued by one-click unsubscribe.
- Normal SQL parameter logging is disabled in all three database constructors. Request logs contain method/status only, not query-string credentials. Logs written before this change may still hold credentials: review their access and retention, and rotate what they exposed. This change does not erase or rotate them.

## Local verification

Run `yarn test --maxWorkers=4`, `yarn tsc --noEmit`, `yarn build`, and `node scripts/security-browser-check.mjs`. Focused runtime regressions live in `worker/src/__tests__/security-remediation.test.ts`. The browser check mounts the actual sanitizer and consent page with only network/auth display boundaries stubbed; it makes no remote service changes. The full E2E runner (`yarn test:e2e`) wipes and reseeds the local D1 database, so do not point it at local data you want to keep.
