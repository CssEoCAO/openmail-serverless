import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertInboxAllowed, isInboxAllowed } from "../lib/inbox-permissions";
import { emailTemplates } from "../db/email-templates.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { analyzeTemplate, TemplateParseError } from "../lib/interpolate";
import { sendTemplate } from "../lib/send-template";
import type { Variables } from "../variables";
import { bearerSecurity } from "../lib/openapi-auth";
import {
  ErrorSchema,
  inboxForbiddenResponse,
  SendPathErrorSchema,
} from "../lib/openapi-send-errors";
import { templateVariablesSchema } from "../lib/template-variables-schema";
import { canModifyTemplate, canReadTemplate } from "../lib/template-access";
import {
  EMAIL_CONTENT_TOO_LARGE_MESSAGE,
  fitsD1EmailTextBudget,
  MAX_D1_EMAIL_TEXT_BYTES,
} from "../lib/email-limits";

export const emailTemplatesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// The variables schema and its depth guard are shared with the reply,
// sequence-enrollment, and MCP paths — see lib/template-variables-schema.ts.

/**
 * Reject a template whose tags do not parse, at write time.
 *
 * Without this, an unbalanced section or unknown filter stores happily and
 * only fails much later: every send and every `/variables` call returns 400,
 * and `sequence-processor` marks each affected step `failed` — terminal,
 * since the poller only ever re-selects `pending` rows. Enrolled recipients
 * silently never receive the email and the only trace is a worker log.
 * Failing the write puts the diagnostic in front of the person who typed it.
 *
 * Returns the parse error message, or null when the template is fine.
 */
function templateParseError(subject: string, bodyHtml: string): string | null {
  try {
    analyzeTemplate(subject, bodyHtml);
    return null;
  } catch (err) {
    if (err instanceof TemplateParseError) return err.message;
    throw err;
  }
}

const EmailTemplateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  fromAddress: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const MAX_TEMPLATE_NAME_CHARS = 200;
const MAX_TEMPLATE_SUBJECT_CHARS = 998;
const MAX_TEMPLATE_SLUG_CHARS = 200;

function templateFitsStorage(params: {
  id?: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  fromAddress?: string | null;
}): boolean {
  return fitsD1EmailTextBudget(
    params.id,
    params.slug,
    params.name,
    params.subject,
    params.bodyHtml,
    params.fromAddress,
  );
}

const createTemplateRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Email Templates"],
  description: "Create a new email template.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            slug: z
              .string()
              .max(MAX_TEMPLATE_SLUG_CHARS)
              .regex(/^[a-z0-9-]+$/),
            name: z.string().max(MAX_TEMPLATE_NAME_CHARS),
            subject: z.string().max(MAX_TEMPLATE_SUBJECT_CHARS),
            bodyHtml: z.string().max(MAX_D1_EMAIL_TEXT_BYTES),
            fromAddress: z.string().email().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(EmailTemplateSchema, "Created email template"),
    400: {
      description:
        "Template has an unbalanced section or an unknown filter — see the parse diagnostic.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(createTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug, name, subject, bodyHtml, fromAddress } = c.req.valid("json");
  const canonicalFromAddress =
    fromAddress == null ? null : fromAddress.trim().toLowerCase();

  const parseError = templateParseError(subject, bodyHtml);
  if (parseError) {
    return c.json({ error: parseError }, 400);
  }

  const allowed = c.get("allowedInboxes")!;
  if (canonicalFromAddress != null) {
    assertInboxAllowed(allowed, canonicalFromAddress);
  } else if (!allowed.isAdmin) {
    // Members cannot create global (null) templates.
    return c.json({ error: "from_address is required for members" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const template = {
    id: nanoid(),
    slug,
    name,
    subject,
    bodyHtml,
    fromAddress: canonicalFromAddress,
    createdAt: now,
    updatedAt: now,
  };
  if (!templateFitsStorage(template)) {
    return c.json({ error: EMAIL_CONTENT_TOO_LARGE_MESSAGE }, 400);
  }
  await db.insert(emailTemplates).values(template);
  return c.json(template, 201);
});

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Email Templates"],
  description: "List all email templates.",
  responses: {
    ...json200Response(z.array(EmailTemplateSchema), "List of email templates"),
  },
});

emailTemplatesRouter.openapi(listTemplatesRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  let rows;
  if (allowed.isAdmin) {
    rows = await db.select().from(emailTemplates);
  } else if (allowed.inboxes.length === 0) {
    rows = await db
      .select()
      .from(emailTemplates)
      .where(isNull(emailTemplates.fromAddress));
  } else {
    rows = await db
      .select()
      .from(emailTemplates)
      .where(
        or(
          isNull(emailTemplates.fromAddress),
          inArray(emailTemplates.fromAddress, allowed.inboxes),
        ),
      );
  }
  return c.json(rows, 200);
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Get an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    ...json200Response(EmailTemplateSchema, "Email template"),
  },
});

emailTemplatesRouter.openapi(getTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (rows.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }
  const allowed = c.get("allowedInboxes")!;
  if (!canReadTemplate(allowed, rows[0].fromAddress)) {
    return c.json({ error: "Template not found" }, 404);
  }
  return c.json(rows[0], 200);
});

const updateTemplateRoute = createRoute({
  method: "put",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Update an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().max(MAX_TEMPLATE_NAME_CHARS).optional(),
            subject: z.string().max(MAX_TEMPLATE_SUBJECT_CHARS).optional(),
            bodyHtml: z.string().max(MAX_D1_EMAIL_TEXT_BYTES).optional(),
            fromAddress: z.string().email().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(EmailTemplateSchema, "Updated email template"),
    400: {
      description:
        "Template has an unbalanced section or an unknown filter — see the parse diagnostic.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(updateTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const updates = c.req.valid("json");
  const canonicalUpdates = {
    ...updates,
    ...(updates.fromAddress === undefined
      ? {}
      : {
          fromAddress:
            updates.fromAddress === null
              ? null
              : updates.fromAddress.trim().toLowerCase(),
        }),
  };
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (!canReadTemplate(allowed, existing[0].fromAddress)) {
    return c.json({ error: "Template not found" }, 404);
  }
  if (!canModifyTemplate(allowed, existing[0].fromAddress)) {
    return c.json({ error: "Global templates are admin-managed" }, 403);
  }
  if (!allowed.isAdmin && canonicalUpdates.fromAddress === null) {
    return c.json({ error: "Members cannot create global templates" }, 403);
  }
  if (
    canonicalUpdates.fromAddress !== undefined &&
    canonicalUpdates.fromAddress !== null
  ) {
    assertInboxAllowed(allowed, canonicalUpdates.fromAddress);
  }

  // Both fields are optional on this route, so validate the template as it
  // will exist AFTER the merge — editing only the subject can still leave a
  // section unbalanced across the pair.
  const parseError = templateParseError(
    canonicalUpdates.subject ?? existing[0].subject,
    canonicalUpdates.bodyHtml ?? existing[0].bodyHtml,
  );
  if (parseError) {
    return c.json({ error: parseError }, 400);
  }

  if (
    !templateFitsStorage({
      id: existing[0].id,
      slug,
      name: canonicalUpdates.name ?? existing[0].name,
      subject: canonicalUpdates.subject ?? existing[0].subject,
      bodyHtml: canonicalUpdates.bodyHtml ?? existing[0].bodyHtml,
      fromAddress:
        canonicalUpdates.fromAddress === undefined
          ? existing[0].fromAddress
          : canonicalUpdates.fromAddress,
    })
  ) {
    return c.json({ error: EMAIL_CONTENT_TOO_LARGE_MESSAGE }, 400);
  }

  const ownerFence =
    existing[0].fromAddress === null
      ? isNull(emailTemplates.fromAddress)
      : eq(emailTemplates.fromAddress, existing[0].fromAddress);
  const updated = await db
    .update(emailTemplates)
    .set({ ...canonicalUpdates, updatedAt: now })
    .where(and(eq(emailTemplates.slug, slug), ownerFence))
    .returning();
  if (updated.length === 0) {
    return c.json({ error: "Template ownership changed" }, 404);
  }
  return c.json(updated[0], 200);
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/{slug}",
  tags: ["Email Templates"],
  description: "Delete an email template by slug.",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deletion result"),
  },
});

emailTemplatesRouter.openapi(deleteTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");

  const existing = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (!canReadTemplate(allowed, existing[0].fromAddress)) {
    return c.json({ error: "Template not found" }, 404);
  }
  if (!canModifyTemplate(allowed, existing[0].fromAddress)) {
    return c.json({ error: "Global templates are admin-managed" }, 403);
  }

  const ownerFence =
    existing[0].fromAddress === null
      ? isNull(emailTemplates.fromAddress)
      : eq(emailTemplates.fromAddress, existing[0].fromAddress);
  const deleted = await db
    .delete(emailTemplates)
    .where(and(eq(emailTemplates.slug, slug), ownerFence))
    .returning({ id: emailTemplates.id });
  if (deleted.length === 0) {
    return c.json({ error: "Template ownership changed" }, 404);
  }
  return c.json({ success: true }, 200);
});

// --- VARIABLES ---
const getTemplateVariablesRoute = createRoute({
  method: "get",
  path: "/{slug}/variables",
  tags: ["Email Templates"],
  description: "Get all template variables required for sending.",
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({
        variables: z.array(z.string()).openapi({
          description: "Variables the caller must supply, or the send fails.",
        }),
        optional: z.array(z.string()).openapi({
          description:
            "Variables that render empty when absent — `{{key?}}` tags and inverted sections.",
        }),
        sections: z
          .array(
            z.object({
              name: z.string(),
              inverted: z.boolean(),
              variables: z.array(z.string()),
            }),
          )
          .openapi({
            description:
              "Sections and the names their bodies reference. Those names resolve per-item and are not required at the top level.",
          }),
      }),
      "Template variables",
    ),
    400: {
      description: "Template has an unbalanced section",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(getTemplateVariablesRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");

  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  if (!canReadTemplate(c.get("allowedInboxes")!, rows[0].fromAddress)) {
    return c.json({ error: "Template not found" }, 404);
  }

  const template = rows[0];
  let analysis;
  try {
    analysis = analyzeTemplate(template.subject, template.bodyHtml);
  } catch (err) {
    if (err instanceof TemplateParseError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  return c.json(
    {
      variables: analysis.required,
      optional: analysis.optional,
      sections: analysis.sections,
    },
    200,
  );
});

// --- SEND ---
const sendTemplateRoute = createRoute({
  method: "post",
  path: "/{slug}/send",
  tags: ["Email Templates"],
  security: bearerSecurity,
  description: "Send an email using a template.",
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to: z.string().email(),
            fromAddress: z.string().email(),
            variables: templateVariablesSchema.optional().default({}),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        id: z.string().nullable(),
        resendId: z.string().nullable(),
        status: z.string().openapi({
          description:
            'Delivery status. "sent" = delivered; "retrying" = transient provider failure — saasmail queues this in the outbox and retries automatically; "failed" = provider permanently rejected; "suppressed" = every recipient was on the suppression list.',
        }),
        delivered: z.array(z.string()),
        suppressed: z.array(z.string()),
      }),
      "Email sent",
    ),
    400: {
      description:
        "Missing required template variables, or the template has an unbalanced section.",
      content: {
        "application/json": { schema: SendPathErrorSchema },
      },
    },
    ...inboxForbiddenResponse,
    404: {
      description: "Template slug not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

emailTemplatesRouter.openapi(sendTemplateRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const { to, fromAddress, variables } = c.req.valid("json");

  const result = await sendTemplate({
    db,
    env: c.env,
    slug,
    to,
    fromAddress,
    variables,
    allowed: c.get("allowedInboxes")!,
  });

  if (!result.ok) {
    if (result.code === "TEMPLATE_NOT_FOUND") {
      return c.json({ error: result.message }, 404);
    }
    if (
      result.code === "TEMPLATE_PARSE_ERROR" ||
      result.code === "CONTENT_TOO_LARGE"
    ) {
      return c.json({ error: result.message }, 400);
    }
    return c.json(
      {
        error: result.message,
        missingVariables: result.missingVariables,
        requiredVariables: result.requiredVariables,
      },
      400,
    );
  }

  return c.json(
    {
      id: result.id,
      resendId: result.resendId,
      status: result.status,
      delivered: result.delivered,
      suppressed: result.suppressed,
    },
    201,
  );
});
