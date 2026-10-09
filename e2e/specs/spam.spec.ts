import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

// Textos da interface em português, como no reply-drafts.
test.use({ locale: "pt-BR" });

function sql(command: string) {
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "saasmail-db",
      "--local",
      "--command",
      command,
    ],
    { stdio: "pipe" },
  );
}

test.describe.serial("Spam recuperável", () => {
  test.beforeEach(() => {
    truncateAndReseed();
    sql("DELETE FROM blocklist WHERE id = 'spam-domain'");
  });

  test("restaura remetente de domínio bloqueado além da primeira página", async ({
    page,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    sql(`INSERT INTO blocklist (id,type,value,created_at) VALUES ('spam-domain','domain','cliente.test',${now});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<31)
      INSERT INTO spam_emails (id,recipient,from_address,from_name,subject,body_text,category,received_at,created_at)
      SELECT 'recuperar-'||i,'support@e2e.test','pessoa@cliente.test','Pessoa de exemplo','Pedido de ajuda','Preciso de ajuda.','bloqueio',${now},${now} FROM n;
      INSERT INTO spam_emails (id,recipient,from_address,subject,body_text,category,received_at,created_at)
      VALUES ('restante','support@e2e.test','oferta@exemplo.test','Oferta genérica','Texto de exemplo','prospeccao',${now - 1},${now - 1});`);
    await page.goto("/spam");
    await expect(page.getByTestId("spam-row")).toHaveCount(30);
    await page
      .getByRole("button", { name: "Não é spam", exact: true })
      .first()
      .click();
    await expect(page.getByRole("status")).toContainText("31 mensagens");
    await expect(page.getByTestId("spam-row")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Carregar mais" }),
    ).toHaveCount(0);
    await page.goto("/inbox/todas");
    await expect(
      page.getByTestId("person-row").filter({ hasText: "Pessoa de exemplo" }),
    ).toBeVisible();
  });

  test("resposta atrasada de outra mensagem não troca o corpo aberto", async ({
    page,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    sql(`INSERT INTO spam_emails (id,recipient,from_address,subject,body_text,category,received_at,created_at) VALUES
      ('lenta','support@e2e.test','a@exemplo.test','Mensagem A','Corpo A','prospeccao',${now},${now}),
      ('rapida','support@e2e.test','b@exemplo.test','Mensagem B','Corpo B','golpe',${now},${now});`);
    let liberar: () => void = () => {};
    const aguardar = new Promise<void>((r) => (liberar = r));
    let recebeu: () => void = () => {};
    const requisitada = new Promise<void>((r) => (recebeu = r));
    await page.route("**/api/spam/lenta", async (route) => {
      const resposta = await route.fetch();
      recebeu();
      await aguardar;
      await route.fulfill({ response: resposta });
    });
    await page.goto("/spam");
    await page.getByRole("button", { name: /Mensagem A/ }).click();
    await requisitada;
    await page.getByRole("button", { name: /Mensagem B/ }).click();
    await expect(page.getByText("Corpo B", { exact: true })).toBeVisible();
    liberar();
    await expect(page.getByText("Corpo A", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Corpo B", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "test-results/spam-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(
      page.getByRole("button", { name: "Não é spam", exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/spam-mobile-escuro.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Esvaziar spam", exact: true })
      .click();
    await page.getByRole("button", { name: "Esvaziar", exact: true }).click();
    await expect(page.getByText("Spam vazio", { exact: true })).toBeVisible();
  });
});
