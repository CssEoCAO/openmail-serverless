import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { suppressions } from "../db/suppressions.schema";
import {
  MAX_UNSUBSCRIBE_TOKEN_LENGTH,
  verifyToken,
  signUndoToken,
  verifyUndoToken,
} from "../lib/unsubscribe-token";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const unsubscribeRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// --- Schemas ---

const UnsubscribeResponseSchema = z.object({
  email: z.string(),
  status: z.enum(["suppressed", "subscribed"]),
  undoToken: z.string().optional(),
});

const ErrorSchema = z.object({ error: z.string() });

// --- POST /api/unsubscribe ---
//
// Public, token-authenticated endpoint. Records a suppression row for the
// email encoded in the HMAC token. Used for both List-Unsubscribe one-click
// POSTs (RFC 8058) and user-driven links in transactional/marketing emails.
// Idempotent: replaying with the same token does not duplicate the row or
// overwrite the original `source`.

const unsubscribeRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Unsubscribe"],
  description:
    "Record a suppression from a signed unsubscribe token. Idempotent.",
  request: {
    query: z.object({
      token: z.string().min(1).max(MAX_UNSUBSCRIBE_TOKEN_LENGTH),
      source: z.enum(["one-click", "user-link"]).optional(),
    }),
  },
  responses: {
    ...json200Response(
      UnsubscribeResponseSchema,
      "Suppression recorded (or already present)",
    ),
    401: {
      description: "Invalid or tampered token",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

unsubscribeRouter.openapi(unsubscribeRoute, async (c) => {
  const { token, source } = c.req.valid("query");

  const result = await verifyToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!result) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const email = result.email.toLowerCase();
  const db = c.get("db");

  const existing = await db
    .select()
    .from(suppressions)
    .where(eq(suppressions.email, email))
    .limit(1);

  if (existing.length > 0) {
    // Idempotent — do not overwrite the original source/note.
    return c.json({ email, status: "suppressed" as const }, 200);
  }

  const inserted = await db
    .insert(suppressions)
    .values({
      id: nanoid(),
      email,
      reason: "unsubscribe",
      source: source ?? "one-click",
      note: null,
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoNothing({ target: suppressions.email })
    .returning({ id: suppressions.id });

  const undoToken =
    source === "user-link" && inserted[0]
      ? await signUndoToken(email, inserted[0].id, c.env.UNSUBSCRIBE_SECRET)
      : undefined;
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      email,
      status: "suppressed" as const,
      ...(undoToken ? { undoToken } : {}),
    },
    200,
  );
});

// --- POST /api/unsubscribe/undo ---
//
// Public, token-authenticated endpoint. Removes the suppression row for the
// email encoded in the HMAC token. Idempotent — deleting an already-absent
// row succeeds.

const undoRoute = createRoute({
  method: "post",
  path: "/undo",
  tags: ["Unsubscribe"],
  description:
    "Undo a newly created unsubscribe within five minutes using its separate, single-use token.",
  request: {
    query: z.object({
      token: z.string().min(1).max(MAX_UNSUBSCRIBE_TOKEN_LENGTH),
    }),
  },
  responses: {
    ...json200Response(
      UnsubscribeResponseSchema,
      "Suppression removed (or already absent)",
    ),
    401: {
      description: "Invalid or tampered token",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

unsubscribeRouter.openapi(undoRoute, async (c) => {
  const { token } = c.req.valid("query");

  const result = await verifyUndoToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!result) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const email = result.email.toLowerCase();
  const db = c.get("db");

  const deleted = await db
    .delete(suppressions)
    .where(
      and(
        eq(suppressions.email, email),
        eq(suppressions.id, result.suppressionId),
        eq(suppressions.reason, "unsubscribe"),
      ),
    )
    .returning({ id: suppressions.id });
  if (deleted.length === 0) {
    return c.json({ error: "Invalid or already used token" }, 401);
  }
  return c.json({ email, status: "subscribed" as const }, 200);
});
