import { expect, it } from "vitest";
import {
  montarArvore,
  rotuloCaixa,
  type CaixaResumo,
} from "../../../src/lib/arvore-caixas";

const AGORA = 1_800_000_000;
const DIA = 86_400;
const caixa = (
  email: string,
  extra: Partial<CaixaResumo> = {},
): CaixaResumo => ({
  email,
  displayName: null,
  podeEnviar: false,
  total: 1,
  naoLidas: 0,
  ultima: AGORA - 90 * DIA,
  ...extra,
});

it("domínio com não lidas sobe; caixa parada vai para 'sem movimento'", () => {
  const arvore = montarArvore(
    [
      caixa("conta1@a.com"),
      caixa("contato@a.com", { podeEnviar: true }),
      caixa("suporte@b.com", { naoLidas: 3 }),
      caixa("novidade@b.com", { ultima: AGORA - 2 * DIA }),
    ],
    AGORA,
  );
  expect(arvore.map((n) => n.dominio)).toEqual(["b.com", "a.com"]);
  expect(arvore[0].ativas.map((c) => c.email)).toEqual([
    "suporte@b.com",
    "novidade@b.com",
  ]);
  // Envia (identidade configurada) fica à vista mesmo parada; conta1 recolhe.
  expect(arvore[1].ativas.map((c) => c.email)).toEqual(["contato@a.com"]);
  expect(arvore[1].paradas.map((c) => c.email)).toEqual(["conta1@a.com"]);
});

it("filtro acha por endereço ou nome e mostra tudo que casou", () => {
  const arvore = montarArvore(
    [
      caixa("conta1@a.com"),
      caixa("financeiro@a.com", { displayName: "Contas a pagar" }),
      caixa("contato@b.com"),
    ],
    AGORA,
    "CONTA",
  );
  const achadas = arvore.flatMap((n) => n.ativas.map((c) => c.email));
  expect(achadas.sort()).toEqual([
    "conta1@a.com",
    "contato@b.com",
    "financeiro@a.com",
  ]);
  expect(arvore.every((n) => n.paradas.length === 0)).toBe(true);
});

it("rótulo usa o nome de exibição e cai na parte antes do @", () => {
  expect(
    rotuloCaixa({ email: "contato@a.com", displayName: " Contato " }),
  ).toBe("Contato");
  expect(rotuloCaixa({ email: "conta1@a.com", displayName: null })).toBe(
    "conta1",
  );
});
