import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { invitations } from "../db/invitations.schema";
import { users } from "../db/auth.schema";
import { publicAuthFailure } from "../lib/public-error";
import { createAuth } from "../auth";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const invitesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InviteInfoSchema = z.object({
  valid: z.boolean(),
  role: z.string().optional(),
  email: z.string().nullable().optional(),
});

const AcceptInviteSchema = z.object({
  token: z.string().min(1).max(128),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const ErrorSchema = z.object({
  error: z.string(),
});

function asDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value * 1000);
}

const validateInviteRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Invites"],
  description: "Check if an invitation token is valid.",
  request: {
    params: z.object({ token: z.string().min(1).max(128) }),
  },
  responses: {
    ...json200Response(InviteInfoSchema, "Invite status"),
  },
});

invitesRouter.openapi(validateInviteRoute, async (c) => {
  const db = c.get("db");
  const { token } = c.req.valid("param");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ valid: false }, 200);
  }

  const now = new Date();
  const expiresAt = asDate(invite.expiresAt);
  if (invite.usedBy || invite.usedAt || expiresAt < now) {
    return c.json({ valid: false }, 200);
  }

  return c.json({ valid: true, role: invite.role, email: invite.email }, 200);
});

const acceptInviteRoute = createRoute({
  method: "post",
  path: "/accept",
  tags: ["Invites"],
  description: "Accept an invitation and create a user account.",
  request: {
    body: {
      content: { "application/json": { schema: AcceptInviteSchema } },
    },
  },
  responses: {
    ...json200Response(
      z.object({ success: z.boolean(), userId: z.string() }),
      "Account created",
    ),
    400: {
      description: "Invalid or expired invite",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

invitesRouter.openapi(acceptInviteRoute, async (c) => {
  const db = c.get("db");
  const { token, name, email, password } = c.req.valid("json");

  const invite = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .get();

  if (!invite) {
    return c.json({ error: "Invalid invitation token" }, 400);
  }

  const now = new Date();
  const expiresAt = asDate(invite.expiresAt);
  if (expiresAt < now) {
    return c.json({ error: "Invitation has expired" }, 400);
  }

  if (invite.usedBy || invite.usedAt) {
    return c.json({ error: "Invitation has already been used" }, 400);
  }

  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
    return c.json({ error: "Email does not match the invitation" }, 400);
  }

  // Claim the token before creating the account. A read-then-create flow lets
  // two concurrent requests both observe an unused invitation and create two
  // accounts. `usedAt` doubles as a permanent claim marker. It is deliberately
  // fail-closed: after createUser crosses its D1 side-effect boundary there is
  // no safe timeout that can prove a crashed request did not create a user.
  // An operator can issue a fresh invitation for a genuinely wedged claim.
  const claimAt = now;
  const claimed = await db
    .update(invitations)
    .set({ usedAt: claimAt })
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.usedBy),
        gt(invitations.expiresAt, claimAt),
        isNull(invitations.usedAt),
      ),
    )
    .returning({ token: invitations.token });

  if (claimed.length === 0) {
    return c.json(
      { error: "Invitation has already been used or expired" },
      400,
    );
  }

  const auth = createAuth(c.env);

  let newUser;
  try {
    newUser = await auth.api.createUser({
      body: { email, password, name, role: invite.role },
    });
  } catch (err) {
    // Better Auth can throw after an ambiguous D1 response. Release the claim
    // only when a follow-up read proves no account with this email exists.
    const created = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    if (created.length === 0) {
      await db
        .update(invitations)
        .set({ usedAt: null })
        .where(
          and(
            eq(invitations.token, token),
            isNull(invitations.usedBy),
            eq(invitations.usedAt, claimAt),
          ),
        );
    }
    // This route is public — the visitor is not signed in — so only
    // better-auth's own form-facing text may be forwarded. See
    // lib/public-error.ts for what that means and why.
    const failure = publicAuthFailure(
      err,
      "Account creation failed. Please try again.",
    );
    if (failure.internal !== null) {
      console.error(`[invites] account creation failed: ${failure.internal}`);
    }
    return c.json({ error: failure.body }, 400);
  }

  const finalized = await db
    .update(invitations)
    .set({ usedBy: newUser.user.id })
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.usedBy),
        eq(invitations.usedAt, claimAt),
      ),
    )
    .returning({ token: invitations.token });

  if (finalized.length === 0) {
    return c.json({ error: "Invitation finalization failed" }, 400);
  }

  return c.json({ success: true, userId: newUser.user.id }, 200);
});
