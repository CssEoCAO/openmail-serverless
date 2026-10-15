// e2e/specs/reply-drafts.spec.ts
// Covers: o botão Responder visível nos três modos (chat, thread, modal HTML)
// e o rascunho de resposta guardado no servidor pelo botão "Salvar rascunho":
// marcado na caixa, listado em /rascunhos, retomado sem localStorage, isolado
// por usuário (A não vê o de B nem o backup local de B no mesmo navegador),
// preservado quando o PUT falha, guardado ao fechar antes do debounce, e
// apagado só depois do 201 do envio. Caixa sem identidade de envio salva mas
// não envia.
// Seed: Alice tem e_s_a1/e_s_a2 em support@ (chat) e e_m_a1/e_m_a2 em
// marketing@ (thread). Bob tem e_s_b1/e_s_b2 em support@.
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { BASE_URL, MEMBER, loginViaApi } from "../support/login";

const TEXTO = "Resposta em rascunho pelo e2e";

// Este arquivo confere a interface em português (o resto da suíte roda em inglês).
test.use({ locale: "pt-BR" });

/** O composer grava o rascunho de resposta pelo router único: PUT /api/drafts com
 *  contextKey "reply:<emailId>" no corpo, GET e DELETE por ?contextKey=. */
function rascunhoDe(
  req: { url(): string; method(): string; postDataJSON(): unknown },
  metodo: "PUT" | "DELETE",
  emailId?: string,
) {
  const url = new URL(req.url());
  if (url.pathname !== "/api/drafts" || req.method() !== metodo) return false;
  const chave =
    metodo === "PUT"
      ? (req.postDataJSON() as { contextKey?: string } | null)?.contextKey
      : url.searchParams.get("contextKey");
  return emailId ? chave === `reply:${emailId}` : !!chave?.startsWith("reply:");
}

async function abrirPessoa(page: Page, nome: string, tab: string) {
  await page.goto("/inbox/todas");
  await expect(page.getByText(nome)).toBeVisible();
  await page.getByText(nome).click();
  await expect(
    page.getByRole("heading", { name: nome, level: 2 }),
  ).toBeVisible();
  // As abas só aparecem quando a pessoa tem mensagens em mais de uma caixa,
  // e só depois que as mensagens carregam.
  await expect(page.getByTestId("message-reply").first()).toBeVisible();
  const abas = page.locator(`[data-testid="inbox-tab"]`);
  if ((await abas.count()) > 0) await abas.filter({ hasText: tab }).click();
}

/** Abre o composer numa bolha e espera o GET do rascunho terminar. */
async function abrirComposer(page: Page, bubble: ReturnType<Page["locator"]>) {
  await bubble.getByTestId("message-reply").click();
  const composer = page.getByTestId(TEST_IDS.replyComposer);
  await expect(composer).toBeVisible();
  await expect(composer.locator(".ProseMirror")).toBeVisible();
  return composer;
}

test.describe.serial("reply drafts", () => {
  test.beforeAll(() => truncateAndReseed());

  test("chat mode: Responder is visible without hover; Salvar rascunho persists on the server and marks the inbox", async ({
    page,
    api,
  }) => {
    await abrirPessoa(page, "Alice Anderson", "support");

    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    await expect(bubbles).toHaveCount(2);
    // Sem mover o mouse: o botão tem que estar visível e opaco.
    const reply = bubbles.first().getByTestId("message-reply");
    await expect(reply).toBeVisible();
    await expect(reply).toHaveText(/Responder/);
    expect(await reply.evaluate((el) => getComputedStyle(el).opacity)).toBe(
      "1",
    );

    const composer = await abrirComposer(page, bubbles.first());
    const salvar = composer.getByTestId("reply-save-draft");
    // Nada digitado: nada a salvar.
    await expect(salvar).toBeDisabled();

    await composer.locator(".ProseMirror").click();
    await page.keyboard.type(TEXTO);
    await expect(page.getByTestId("reply-draft-hint")).toHaveAttribute(
      "data-estado",
      "alterado",
    );
    await expect(salvar).toBeEnabled();

    const put = page.waitForResponse((r) =>
      rascunhoDe(r.request(), "PUT", "e_s_a1"),
    );
    await salvar.click();
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId("reply-draft-hint")).toHaveText(
      /Rascunho salvo/,
    );
    await expect(salvar).toBeDisabled();

    // O servidor tem o rascunho, com pessoa e assunto para a listagem.
    const lista = await (await api.get("/api/drafts")).json();
    expect(lista.drafts).toHaveLength(1);
    expect(lista.drafts[0]).toMatchObject({
      emailId: "e_s_a1",
      personId: "p_alice",
      personEmail: "alice@customers.test",
      subject: "Help with login",
      fromAddress: "support@e2e.test",
    });
    expect(lista.drafts[0].bodyText).toContain(TEXTO);

    await composer.getByRole("button", { name: "Cancelar" }).click();
    await expect(composer).not.toBeVisible();

    // Marcado na bolha e na linha da caixa.
    await expect(bubbles.first().getByTestId("rascunho-pill")).toBeVisible();
    await expect(bubbles.first().getByTestId("message-reply")).toHaveText(
      /Continuar rascunho/,
    );
    await expect(page.getByTestId("rascunho-pill").first()).toBeVisible();
  });

  test("resumes the draft from the server on a fresh browser state, and /rascunhos lists it", async ({
    page,
  }) => {
    // Sem cache local: o que voltar veio do servidor.
    await page.goto("/inbox/todas");
    await page.evaluate(() => window.localStorage.clear());

    // A página de rascunhos acha a mensagem sem lembrar o contato.
    await page.goto("/rascunhos");
    const linhas = page.getByTestId("rascunhos-lista").locator("li");
    await expect(linhas).toHaveCount(1);
    await expect(linhas.first()).toContainText("Alice Anderson");
    await expect(linhas.first()).toContainText("Help with login");
    await linhas.first().getByRole("button").click();
    // /m/:emailId leva pra caixa e pessoa certas.
    await expect(page).toHaveURL(/\/inbox\/support%40e2e\.test\/p_alice/);

    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    const reply = bubbles.first().getByTestId("message-reply");
    await expect(reply).toHaveText(/Continuar rascunho/);
    const composer = await abrirComposer(page, bubbles.first());
    await expect(composer.locator(".ProseMirror")).toContainText(TEXTO);
    await expect(page.getByTestId("reply-draft-hint")).toHaveText(
      /Rascunho salvo/,
    );
    await composer.getByRole("button", { name: "Cancelar" }).click();
  });

  test("closing before the backup debounce keeps the text; a failed PUT keeps it too and never says saved", async ({
    page,
  }) => {
    await abrirPessoa(page, "Bob Brown", "support");
    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    let composer = await abrirComposer(page, bubbles.first());
    await composer.locator(".ProseMirror").click();
    await page.keyboard.type("texto do Bob");
    // Fecha na hora (bem antes dos 600 ms do backup).
    await composer.getByRole("button", { name: "Cancelar" }).click();
    await expect(composer).not.toBeVisible();

    composer = await abrirComposer(page, bubbles.first());
    await expect(composer.locator(".ProseMirror")).toContainText(
      "texto do Bob",
    );
    await expect(page.getByTestId("reply-draft-hint")).toHaveAttribute(
      "data-estado",
      "alterado",
    );

    // Servidor recusa: o texto fica, o selo diz que falhou, nada de "salvo".
    await page.route("**/api/drafts", (route) =>
      rascunhoDe(route.request(), "PUT", "e_s_b1")
        ? route.fulfill({ status: 500, body: "{}" })
        : route.continue(),
    );
    await composer.getByTestId("reply-save-draft").click();
    await expect(page.getByTestId("reply-draft-hint")).toHaveAttribute(
      "data-estado",
      "falhou",
    );
    await expect(composer.locator(".ProseMirror")).toContainText(
      "texto do Bob",
    );
    await expect(composer).toBeVisible();
    await page.unroute("**/api/drafts");
    await composer.getByRole("button", { name: "Cancelar" }).click();
  });

  test("another user with the same inbox sees neither the server draft nor the local backup", async ({
    page,
    api,
    playwright,
  }) => {
    // Dá ao membro acesso a support@ e troca a sessão no MESMO navegador
    // (mesmo localStorage) — o backup local do admin para Bob e o rascunho
    // remoto de Alice não podem aparecer.
    const users = await (await api.get("/api/admin/users")).json();
    const member = users.find(
      (u: { email: string }) => u.email === MEMBER.email,
    );
    expect(member).toBeTruthy();
    const grant = await api.put(
      "/api/admin/inboxes/support%40e2e.test/assignments",
      { data: { userIds: [member.id] }, headers: { origin: BASE_URL } },
    );
    expect(grant.ok()).toBeTruthy();

    // O convite aceito nao deixa sessao: loga o membro pela API e usa os
    // cookies dele nesta MESMA pagina.
    const memberCtx = await playwright.request.newContext({
      baseURL: BASE_URL,
    });
    await loginViaApi(memberCtx, MEMBER.email, MEMBER.password);
    const memberState = await memberCtx.storageState();
    await memberCtx.dispose();
    await page.context().clearCookies();
    await page.context().addCookies(memberState.cookies);

    await abrirPessoa(page, "Alice Anderson", "support");
    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    await expect(bubbles.first().getByTestId("message-reply")).toHaveText(
      /^Responder$/,
    );
    await expect(page.getByTestId("rascunho-pill")).toHaveCount(0);
    let composer = await abrirComposer(page, bubbles.first());
    await expect(composer.locator(".ProseMirror")).not.toContainText(TEXTO);
    await composer.getByRole("button", { name: "Cancelar" }).click();

    await abrirPessoa(page, "Bob Brown", "support");
    composer = await abrirComposer(
      page,
      page.getByTestId(TEST_IDS.chatBubble).first(),
    );
    await expect(composer.locator(".ProseMirror")).not.toContainText(
      "texto do Bob",
    );
    await composer.getByRole("button", { name: "Cancelar" }).click();

    // Volta pro admin.
    const adminState = JSON.parse(
      readFileSync("e2e/.auth/admin.json", "utf-8"),
    ) as Awaited<ReturnType<typeof memberCtx.storageState>>;
    await page.context().clearCookies();
    await page.context().addCookies(adminState.cookies);
  });

  test("thread mode and the HTML modal both expose Reply", async ({ page }) => {
    await abrirPessoa(page, "Alice Anderson", "marketing");

    // Thread: botão sempre visível (sem hover).
    const reply = page.getByTestId("message-reply").first();
    await expect(reply).toBeVisible();
    expect(await reply.evaluate((el) => getComputedStyle(el).opacity)).toBe(
      "1",
    );
    await reply.click();
    const composer = page.getByTestId(TEST_IDS.replyComposer);
    await expect(composer).toBeVisible();
    await composer.getByRole("button", { name: "Cancelar" }).click();
    await expect(composer).not.toBeVisible();

    // Modal HTML: "Ver original" abre o modal, "Responder" fecha o modal e abre o composer.
    await page
      .getByRole("button", { name: "Ver original", exact: true })
      .first()
      .click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByTestId("modal-reply")).toBeVisible();
    await modal.getByTestId("modal-reply").click();
    await expect(composer).toBeVisible();
    await composer.getByRole("button", { name: "Cancelar" }).click();
  });

  test("an inbox that receives but has no sender identity can save a draft and cannot send", async ({
    page,
    api,
  }) => {
    // Tira a identidade de envio de marketing@ (a caixa continua recebendo e
    // permitida). Nenhuma identidade é criada.
    const del = await api.delete("/api/admin/inboxes/marketing%40e2e.test", {
      headers: { origin: BASE_URL },
    });
    expect(del.ok()).toBeTruthy();

    await abrirPessoa(page, "Alice Anderson", "marketing");
    await page.getByTestId("message-reply").first().click();
    const composer = page.getByTestId(TEST_IDS.replyComposer);
    await expect(composer.locator(".ProseMirror")).toBeVisible();
    await expect(composer.getByTestId("reply-send-unavailable")).toContainText(
      "marketing@e2e.test",
    );
    await expect(composer.getByTestId(TEST_IDS.replySendButton)).toBeDisabled();
    // O remetente segue sendo a caixa que recebeu, não outra.
    await expect(composer.locator("select")).toHaveValue("marketing@e2e.test");

    await composer.locator(".ProseMirror").click();
    await page.keyboard.type("rascunho em caixa sem identidade");
    const put = page.waitForResponse((r) => rascunhoDe(r.request(), "PUT"));
    await composer.getByTestId("reply-save-draft").click();
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId("reply-draft-hint")).toHaveText(
      /Rascunho salvo/,
    );
    await composer.getByRole("button", { name: "Cancelar" }).click();
    const { draft } = await (await put).json();
    await api.delete(
      `/api/drafts?contextKey=${encodeURIComponent(draft.contextKey)}`,
      { headers: { origin: BASE_URL } },
    );
  });

  test("preserves a divergent backup, locks actions during save and fits on mobile", async ({
    page,
    api,
  }) => {
    await abrirPessoa(page, "Bob Brown", "support");
    const session = await (
      await page.request.get("/api/auth/get-session")
    ).json();
    const key = `saasmail.rascunho.${session.user.id}.e_s_b2`;
    const content = {
      fromAddress: "support@e2e.test",
      cc: [],
      bodyHtml: "<p>servidor</p>",
      bodyText: "servidor",
    };
    expect(
      (
        await api.put("/api/drafts/e_s_b2", {
          data: content,
          headers: { origin: BASE_URL },
        })
      ).ok(),
    ).toBeTruthy();
    await page.evaluate(
      ({ key, content }) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            ...content,
            bodyHtml: "<p>backup pendente</p>",
            bodyText: "backup pendente",
            em: Date.now(),
          }),
        ),
      { key, content },
    );
    const bubble = page.getByTestId(TEST_IDS.chatBubble).last();
    let composer = await abrirComposer(page, bubble);
    await expect(composer.locator(".ProseMirror")).toContainText("servidor");
    await expect(composer.getByTestId("reply-backup-pending")).toBeVisible();
    // Regressão: o antigo debounce apagava este backup após 600 ms.
    await page.waitForTimeout(750);
    await composer.getByRole("button", { name: "Cancelar" }).click();
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).bodyText,
        key,
      ),
    ).toBe("backup pendente");

    composer = await abrirComposer(page, bubble);
    await composer.getByTestId("reply-backup-use").click();
    await expect(composer.locator(".ProseMirror")).toContainText(
      "backup pendente",
    );
    await page.setViewportSize({ width: 375, height: 812 });
    for (const id of [
      "reply-save-draft",
      "reply-send-button",
      "reply-schedule-button",
    ]) {
      await expect(async () => {
        const box = await composer.getByTestId(id).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      }).toPass({ timeout: 3000 });
    }
    await page.screenshot({
      path: "../../operacao/email-rascunhos-20260919/ui/reply-mobile.png",
    });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route("**/api/drafts", async (route) => {
      if (rascunhoDe(route.request(), "PUT", "e_s_b2")) {
        entered();
        await held;
      }
      await route.continue();
    });
    await composer.getByTestId("reply-save-draft").click();
    await intercepted;
    try {
      await expect(composer.getByTestId("reply-send-button")).toBeDisabled();
      await expect(
        composer.getByTestId("reply-schedule-button"),
      ).toBeDisabled();
      await expect(
        composer.getByRole("button", { name: "Cancelar" }),
      ).toBeDisabled();
      await expect(
        composer.getByRole("button", { name: "Fechar", exact: true }),
      ).toBeDisabled();
      expect(
        await composer
          .locator(".ProseMirror")
          .evaluate((el) => !!el.closest("[inert]")),
      ).toBe(true);
    } finally {
      release();
    }
    await expect(composer.getByTestId("reply-draft-hint")).toHaveAttribute(
      "data-estado",
      "salvo",
    );
    await composer.getByRole("button", { name: "Cancelar" }).click();
    await page.unroute("**/api/drafts");
    await api.delete("/api/drafts/e_s_b2", { headers: { origin: BASE_URL } });
    await page.evaluate(() => localStorage.clear());
    await page.route("**/api/drafts", (route) =>
      route.fulfill({ status: 500, body: "{}" }),
    );
    await page.goto("/rascunhos");
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível carregar os rascunhos",
    );
    await expect(page.getByTestId("rascunhos-vazio")).toHaveCount(0);
  });

  test("the draft is discarded only after the send is confirmed", async ({
    page,
    api,
  }) => {
    await abrirPessoa(page, "Alice Anderson", "support");
    const bubbles = page.getByTestId(TEST_IDS.chatBubble);
    const composer = await abrirComposer(page, bubbles.first());
    await expect(composer.locator(".ProseMirror")).toContainText(TEXTO);

    const sent = page.waitForResponse(
      (r) =>
        r.url().includes("/api/send/reply/e_s_a1") &&
        r.request().method() === "POST",
    );
    const del = page.waitForResponse((r) =>
      rascunhoDe(r.request(), "DELETE", "e_s_a1"),
    );
    await composer.getByTestId(TEST_IDS.replySendButton).click();
    expect((await sent).status()).toBe(201);
    expect((await del).status()).toBe(200);
    await expect(composer).not.toBeVisible();

    const lista = await (await api.get(`${BASE_URL}/api/drafts`)).json();
    expect(lista.drafts).toHaveLength(0);
    await expect(page.getByTestId("rascunho-pill")).toHaveCount(0);
  });
});
