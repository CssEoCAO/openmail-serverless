// e2e/specs/thread-display.spec.ts
// Covers: thread-mode rendering for marketing@e2e.test (display_mode = 'thread').
// Alice has 2 emails in the marketing inbox:
//   e_m_a1 — "Welcome to our product"        (older)
//   e_m_a2 — "Re: Welcome to our product"    (latest, rendered with HTML)
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("thread-mode display (marketing@)", () => {
  test.beforeAll(() => truncateAndReseed());

  test("renders both messages, the latest HTML body, and reply button", async ({
    page,
  }) => {
    // Navigate to the inbox page and select Alice
    await page.goto("/inbox/todas");

    await expect(page.getByText("Alice Anderson")).toBeVisible();
    await page.getByText("Alice Anderson").click();

    // The redesign tabs each inbox per person. Switch to the marketing@ tab
    // (thread mode) so thread messages are rendered.
    await page
      .locator(`[data-testid="inbox-tab"]`, { hasText: "marketing" })
      .click();

    // The latest email (e_m_a2) subject should be visible in the thread
    await expect(page.getByText("Re: Welcome to our product")).toBeVisible();

    // Both messages render expanded, oldest first, each body as the original
    // HTML in a sandboxed iframe (EmailHtmlFrame).
    const messages = page.getByTestId(TEST_IDS.threadMessage);
    await expect(messages).toHaveCount(2);
    await expect(
      messages.first().getByText("Welcome to our product", { exact: true }),
    ).toBeVisible();

    // The latest email body HTML is rendered: "Thanks for signing up!" from
    // <p>Thanks for signing up!</p><blockquote>...</blockquote>
    await expect(
      messages.last().locator("iframe").contentFrame().locator("body"),
    ).toContainText(/Thanks for signing up/i);

    // Reply button: hover the latest message container to reveal actions
    const latestMessage = messages.last();
    await latestMessage.hover();

    const replyButton = latestMessage.getByRole("button", { name: "Reply" });
    await expect(replyButton).toBeVisible();

    // Click reply to open ReplyComposer
    await replyButton.click();

    // ReplyComposer should appear — check for a Send button
    await expect(page.getByTestId(TEST_IDS.replySendButton)).toBeVisible();
  });
});
