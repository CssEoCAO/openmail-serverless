// e2e/specs/unread-count-sync.spec.ts
// Covers: sidebar PersonList unread badge updates immediately when an email
// is marked read in PersonDetail, without requiring a page reload.
//
// Seed (seeds/e2e.sql) gives Alice 4 received emails, all is_read=0:
//   - 2 thread-mode (marketing@e2e.test)
//   - 2 chat-mode   (support@e2e.test)
// The list endpoint computes unreadCount from `SUM(is_read = 0)`, so Alice's
// badge starts at 4. Opening the chat-mode tab marks its two messages read and
// should drop the badge to 2 via the onEmailRead callback wired through InboxPage.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("sidebar unread count stays in sync", () => {
  test.beforeAll(() => truncateAndReseed());

  test("opening the chat view marks its messages read and updates the badge", async ({
    page,
  }) => {
    await page.goto("/inbox/todas");

    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    await expect(aliceRow).toBeVisible();

    const aliceBadge = aliceRow.getByTestId(TEST_IDS.personUnreadBadge);
    await expect(aliceBadge).toHaveText("4");

    // Select Alice — opens PersonDetail with tabbed inbox sections.
    await aliceRow.click();

    // Switch to the support@ tab (chat mode) so chat bubbles are rendered.
    await page
      .locator(`[data-testid="inbox-tab"]`, { hasText: "support" })
      .click();

    // Opening the chat view marks what it shows as read: both support@
    // messages are on screen, so the badge drops from 4 to 2 with no click and
    // no reload. The two thread-mode messages stay unread until opened.
    await expect(page.getByTestId(TEST_IDS.chatBubble)).toHaveCount(2);
    await expect(aliceBadge).toHaveText("2");

    // Also verify the backend persisted the change: a full reload should
    // keep the badge at 2 (not spring back to 4).
    await page.reload();
    const aliceRowReloaded = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    await expect(
      aliceRowReloaded.getByTestId(TEST_IDS.personUnreadBadge),
    ).toHaveText("2");
  });
});
