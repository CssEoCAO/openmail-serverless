import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { appSettings } from "../db/app-settings.schema";
import { createAuth } from "../auth";
import { json200Response } from "../lib/helpers";
import { hashKey } from "../lib/crypto";
import type { Variables } from "../variables";

export const setupRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatusSchema = z.object({
  setupRequired: z.boolean(),
});

const MigrationRequiredSchema = z.object({
  error: z.string(),
  code: z.literal("DATABASE_MIGRATION_REQUIRED"),
  command: z.literal("yarn db:migrate:prod"),
});

const MIGRATION_REQUIRED_RESPONSE = {
  error:
    "Database migrations have not been applied yet. Run `yarn db:migrate:prod` to create the production D1 tables, or run `/saasmail-onboarding` to walk through setup, then reload saasmail.",
  code: "DATABASE_MIGRATION_REQUIRED",
  command: "yarn db:migrate:prod",
} as const;

function isMissingUsersTableError(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current.message.includes("no such table: users")) return true;
    current = current.cause;
  }
  return String(current).includes("no such table: users");
}

const SetupRequestSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  bootstrapToken: z.string().max(128).optional(),
});

const SetupResponseSchema = z.object({
  success: z.boolean(),
});

const ErrorSchema = z.object({
  error: z.string(),
});

async function countUsers(db: Variables["db"]): Promise<number> {
  const result = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
  return result[0]?.count ?? 0;
}

const SETUP_CLAIM_KEY = "__setup_claim";

async function claimSetup(
  db: Variables["db"],
  token: string,
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const claim = `claim:${now}:${crypto.randomUUID()}`;
  const tokenHash = await hashKey(token);
  // Authorization and winner selection share one atomic statement. Only an
  // operator with D1 access can provision this short-lived authorization.
  const inserted = await db.all<{ key: string }>(sql`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    SELECT ${SETUP_CLAIM_KEY}, ${claim}, ${now}, NULL
    WHERE EXISTS (SELECT 1 FROM app_settings
      WHERE key = '__setup_authorization' AND value = ${tokenHash}
        AND updated_at > ${now})
      AND NOT EXISTS (SELECT 1 FROM users)
    ON CONFLICT(key) DO NOTHING RETURNING key
  `);
  if (inserted.length > 0) return claim;
  // Never recover this claim by age. createUser is a separate durable side
  // effect, so an expired lease cannot prove a previous Worker did not create
  // an administrator before it died. A stale claim requires operator review.
  return null;
}

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Setup"],
  description: "Check whether initial setup is required (no users exist).",
  responses: {
    ...json200Response(StatusSchema, "Setup status"),
    503: {
      description: "Database migrations have not been applied",
      content: { "application/json": { schema: MigrationRequiredSchema } },
    },
  },
});

setupRouter.openapi(statusRoute, async (c) => {
  const db = c.get("db");
  try {
    const count = await countUsers(db);
    return c.json({ setupRequired: count === 0 }, 200);
  } catch (err) {
    if (isMissingUsersTableError(err)) {
      return c.json(MIGRATION_REQUIRED_RESPONSE, 503);
    }
    throw err;
  }
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Setup"],
  description:
    "Create the first administrator user. Only available when no users exist.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SetupRequestSchema,
        },
      },
    },
  },
  responses: {
    ...json200Response(SetupResponseSchema, "First user created"),
    403: {
      description: "Setup has already been completed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Database migrations have not been applied",
      content: { "application/json": { schema: MigrationRequiredSchema } },
    },
  },
});

setupRouter.openapi(createRouteDef, async (c) => {
  const db = c.get("db");

  // Guard: reject if any users already exist.
  let count: number;
  try {
    count = await countUsers(db);
  } catch (err) {
    if (isMissingUsersTableError(err)) {
      return c.json(MIGRATION_REQUIRED_RESPONSE, 503);
    }
    throw err;
  }
  if (count > 0) {
    return c.json({ error: "Setup has already been completed" }, 403);
  }

  let setupClaim: string | null;
  try {
    setupClaim = await claimSetup(db, c.req.valid("json").bootstrapToken ?? "");
  } catch (err) {
    if (String(err).includes("no such table: app_settings")) {
      return c.json(MIGRATION_REQUIRED_RESPONSE, 503);
    }
    throw err;
  }
  if (!setupClaim) {
    return c.json(
      {
        error:
          "A valid operator bootstrap token is required, or setup is already in progress",
      },
      403,
    );
  }

  const { name, email, password } = c.req.valid("json");

  const auth = createAuth(c.env);

  let newUser;
  try {
    newUser = await auth.api.createUser({
      body: { name, email, password, role: "admin" },
    });
  } catch (err) {
    // Better Auth and the claim use separate D1 statements. If account
    // creation failed before writing a user, release only this request's claim
    // so an operator can retry. If a user exists, keep the claim fail-closed.
    if ((await countUsers(db)) === 0) {
      await db
        .delete(appSettings)
        .where(
          and(
            eq(appSettings.key, SETUP_CLAIM_KEY),
            eq(appSettings.value, setupClaim),
          ),
        );
    }
    const message = err instanceof Error ? err.message : "Signup failed";
    return c.json({ error: message }, 400);
  }
  const finalized = await db
    .update(appSettings)
    .set({
      value: "complete",
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: newUser.user.id,
    })
    .where(
      and(
        eq(appSettings.key, SETUP_CLAIM_KEY),
        eq(appSettings.value, setupClaim),
      ),
    )
    .returning({ key: appSettings.key });

  if (finalized.length === 0) {
    throw new Error("Setup claim was lost after administrator creation");
  }
  await db
    .delete(appSettings)
    .where(eq(appSettings.key, "__setup_authorization"));

  return c.json({ success: true }, 200);
});
