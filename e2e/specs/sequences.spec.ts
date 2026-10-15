// e2e/specs/sequences.spec.ts
// Covers: sequence create / edit / enroll / cancel / delete via the UI.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { createTemplate, createSequence } from "../support/seed";
import { BASE_URL } from "../support/login";
import { request } from "@playwright/test";

test.describe.serial("sequences CRUD", () => {
  // Sequence ID created via API (reused across enroll / cancel / delete tests)
  let apiSequenceId: string;

  test.beforeAll(async () => {
    truncateAndReseed();

    // Create templates needed for steps (API-driven setup for speed).
    const api = await request.newContext({
      baseURL: BASE_URL,
      storageState: "e2e/.auth/admin.json",
      extraHTTPHeaders: { origin: BASE_URL },
    });

    await createTemplate(api, {
      slug: "welcome",
      name: "Welcome",
      subject: "Welcome",
      bodyHtml: "<p>Hello {{name}}</p>",
      fromAddress: "marketing@e2e.test",
    });
    await createTemplate(api, {
      slug: "followup",
      name: "Follow-up",
      subject: "Following up",
      bodyHtml: "<p>Checking in {{name}}</p>",
      fromAddress: "marketing@e2e.test",
    });
    await createTemplate(api, {
      slug: "closing",
      name: "Closing",
      subject: "Last note",
      bodyHtml: "<p>Final note {{name}}</p>",
      fromAddress: "marketing@e2e.test",
    });

    await api.dispose();
  });

  // ── 1. Create a 3-step sequence via UI ──────────────────────────────────────

  test("create 3-step sequence appears in list", async ({ page }) => {
    await page.goto("/sequences");

    await page.getByRole("button", { name: /new sequence/i }).click();
    await expect(page).toHaveURL(/\/sequences\/new/);

    // Fill in name.
    await page.getByLabel("Sequence name").fill("E2E Test Sequence");

    // Step 1 is pre-populated — set template + delay. Playwright's
    // selectOption({label: ...}) only accepts strings, not regex, so
    // we select by the option's `value` attribute (the template slug)
    // which is unambiguous and immune to label-format tweaks like the
    // recent "<name> · <slug>" change.
    const step1 = page.getByTestId(TEST_IDS.sequenceStepRow).nth(0);
    await step1.locator("select").selectOption("welcome");
    await step1.locator("input[type=number]").fill("0");

    // Add step 2. The button reads "Add step" (no leading "+").
    await page.getByRole("button", { name: "Add step" }).click();
    const step2 = page.getByTestId(TEST_IDS.sequenceStepRow).nth(1);
    await step2.locator("select").selectOption("followup");
    await step2.locator("input[type=number]").fill("24");

    // Add step 3
    await page.getByRole("button", { name: "Add step" }).click();
    const step3 = page.getByTestId(TEST_IDS.sequenceStepRow).nth(2);
    await step3.locator("select").selectOption("closing");
    await step3.locator("input[type=number]").fill("48");

    // Save (button reads "Create sequence" in new mode).
    await page.getByRole("button", { name: "Create sequence" }).click();

    // Should redirect back to sequences list
    await expect(page).toHaveURL(/\/sequences$/);

    // Row should be present
    const row = page
      .getByTestId(TEST_IDS.sequenceRow)
      .filter({ hasText: "E2E Test Sequence" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("3 steps");
  });

  // ── 2. Edit a step (change delay, remove a step) ────────────────────────────

  test("edit sequence — change delay and remove step", async ({ page }) => {
    await page.goto("/sequences");

    // Click Edit on the E2E Test Sequence row
    const row = page
      .getByTestId(TEST_IDS.sequenceRow)
      .filter({ hasText: "E2E Test Sequence" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    await expect(page).toHaveURL(/\/sequences\/.+\/edit/);

    // Change the delay of step 2 (index 1) from 24 → 48
    const step2 = page.getByTestId(TEST_IDS.sequenceStepRow).nth(1);
    const delayInput = step2.locator("input[type=number]");
    await delayInput.fill("48");

    // Remove step 3
    const step3 = page.getByTestId(TEST_IDS.sequenceStepRow).nth(2);
    await step3.getByRole("button", { name: "Remove" }).click();

    // Only 2 steps should remain
    await expect(page.getByTestId(TEST_IDS.sequenceStepRow)).toHaveCount(2);

    // Save (button reads "Save changes" in edit mode).
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(/\/sequences$/);

    // Row now shows 2 steps
    const updatedRow = page
      .getByTestId(TEST_IDS.sequenceRow)
      .filter({ hasText: "E2E Test Sequence" });
    await expect(updatedRow).toContainText("2 steps");
  });

  // ── 3. Enroll a seeded contact — row appears with status active ──────────────

  test("enroll contact — row appears with active status", async ({
    page,
    api,
  }) => {
    // Create a fresh sequence via API (avoids coupling to the edited sequence)
    const seq = (await createSequence(api, {
      name: "Enroll Test Seq",
      steps: [
        { order: 1, templateSlug: "welcome", delayHours: 0 },
        { order: 2, templateSlug: "followup", delayHours: 24 },
      ],
    })) as { id: string };
    apiSequenceId = seq.id;

    // Enroll alice via API (POST /api/sequences/:id/enroll)
    const enrollRes = await api.post(
      `${BASE_URL}/api/sequences/${apiSequenceId}/enroll`,
      {
        data: {
          personEmail: "alice@customers.test",
          fromAddress: "marketing@e2e.test",
          variables: { name: "Alice" },
        },
      },
    );
    expect(enrollRes.ok()).toBeTruthy();

    // Visit the sequence detail page
    await page.goto(`/sequences/${apiSequenceId}`);

    // Enrollment row for alice should be present and show "In progress".
    const enrollmentRow = page
      .getByTestId(TEST_IDS.enrollmentRow)
      .filter({ hasText: "alice@customers.test" });
    await expect(enrollmentRow).toBeVisible();
    await expect(enrollmentRow).toContainText(/in progress/i);
  });

  // ── 4. Cancel enrollment — status flips to cancelled ────────────────────────

  test("cancel enrollment — status flips to cancelled", async ({ page }) => {
    // apiSequenceId was set by the previous test (serial)
    await page.goto(`/sequences/${apiSequenceId}`);

    const enrollmentRow = page
      .getByTestId(TEST_IDS.enrollmentRow)
      .filter({ hasText: "alice@customers.test" });
    await expect(enrollmentRow).toBeVisible();
    await expect(enrollmentRow).toContainText(/in progress/i);

    // Click Cancel and accept the confirm dialog
    page.once("dialog", (dialog) => dialog.accept());
    await enrollmentRow.getByRole("button", { name: "Cancel" }).click();

    // Status badge should flip to "Cancelled" (case-insensitive match —
    // the redesign capitalizes status labels).
    await expect(enrollmentRow).toContainText(/cancelled/i);
    // The Cancel button should no longer be visible (only shown for active)
    await expect(
      enrollmentRow.getByRole("button", { name: "Cancel" }),
    ).not.toBeVisible();
  });

  // ── 5. Delete the sequence ───────────────────────────────────────────────────

  test("delete sequence removes it from list", async ({ page, api }) => {
    // Create a sequence via API specifically for deletion (clean state)
    const seq = (await createSequence(api, {
      name: "Delete Me Sequence",
      steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }],
    })) as { id: string };
    const deleteSeqId = seq.id;

    await page.goto("/sequences");

    const row = page
      .getByTestId(TEST_IDS.sequenceRow)
      .filter({ hasText: "Delete Me Sequence" });
    await expect(row).toBeVisible();

    // Accept the confirm dialog and click Delete
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete" }).click();

    // Row should be gone
    await expect(row).not.toBeVisible();

    // Confirm via API: GET /api/sequences/:id should 404
    const checkRes = await api.get(`${BASE_URL}/api/sequences/${deleteSeqId}`);
    expect(checkRes.status()).toBe(404);
  });
});
