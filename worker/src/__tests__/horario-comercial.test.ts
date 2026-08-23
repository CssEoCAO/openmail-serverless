import { describe, it, expect } from "vitest";
import {
  dentroDoExpediente,
  feriadosNacionais,
  proximoHorarioComercial,
  rotuloBrasilia,
} from "../lib/horario-comercial";

/** Um instante em horário de Brasília, expresso em epoch ms. BRT = UTC-3. */
const brt = (a: number, m: number, d: number, h: number, min = 0) =>
  Date.UTC(a, m - 1, d, h + 3, min);

/** Espera que o agendamento caia exatamente nesse dia/hora de Brasília. */
function esperaSlot(
  got: number,
  a: number,
  m: number,
  d: number,
  h: number,
): void {
  expect(rotuloBrasilia(got)).toBe(
    rotuloBrasilia(Math.floor(brt(a, m, d, h) / 1000)),
  );
  expect(got).toBe(Math.floor(brt(a, m, d, h) / 1000));
}

describe("horário comercial", () => {
  it("calcula os feriados móveis a partir da Páscoa", () => {
    // Páscoa 2026 cai em 5 de abril.
    const f = feriadosNacionais(2026);
    expect(f.has("2026-02-16")).toBe(true); // Carnaval (segunda)
    expect(f.has("2026-02-17")).toBe(true); // Carnaval (terça)
    expect(f.has("2026-04-03")).toBe(true); // Sexta-feira Santa
    expect(f.has("2026-06-04")).toBe(true); // Corpus Christi
    expect(f.has("2026-11-20")).toBe(true); // Consciência Negra
    // O domingo de Páscoa em si não é feriado nacional — e já é domingo de todo jeito.
    expect(f.has("2026-04-05")).toBe(false);
  });

  it("dentro do expediente sobe às 9 e cai às 18", () => {
    expect(dentroDoExpediente(brt(2026, 8, 25, 8, 59))).toBe(false);
    expect(dentroDoExpediente(brt(2026, 8, 25, 9, 0))).toBe(true);
    expect(dentroDoExpediente(brt(2026, 8, 25, 17, 59))).toBe(true);
    expect(dentroDoExpediente(brt(2026, 8, 25, 18, 0))).toBe(false);
  });

  it("agenda para a próxima hora cheia quando já é expediente", () => {
    esperaSlot(
      proximoHorarioComercial(brt(2026, 8, 25, 14, 20)),
      2026,
      8,
      25,
      15,
    );
  });

  it("nunca agenda para o próprio instante", () => {
    // Em hora cheia exata o cron daquele minuto já pode ter rodado; agendar para agora
    // prometeria uma hora que na prática já passou.
    esperaSlot(
      proximoHorarioComercial(brt(2026, 8, 25, 14, 0)),
      2026,
      8,
      25,
      15,
    );
  });

  it("passa do fim do expediente para o dia seguinte", () => {
    esperaSlot(
      proximoHorarioComercial(brt(2026, 8, 25, 17, 10)),
      2026,
      8,
      26,
      9,
    );
  });

  it("atravessa o fim de semana", () => {
    // Sábado 22h e sexta 18h30 caem os dois na segunda de manhã.
    esperaSlot(
      proximoHorarioComercial(brt(2026, 8, 22, 22, 0)),
      2026,
      8,
      24,
      9,
    );
    esperaSlot(
      proximoHorarioComercial(brt(2026, 8, 21, 18, 30)),
      2026,
      8,
      24,
      9,
    );
  });

  it("madrugada de dia útil abre no mesmo dia", () => {
    esperaSlot(proximoHorarioComercial(brt(2026, 8, 25, 3, 5)), 2026, 8, 25, 9);
  });

  it("pula feriado nacional emendado com o fim de semana", () => {
    // 06/09/2026 é domingo e 07/09 (Independência) é segunda.
    esperaSlot(proximoHorarioComercial(brt(2026, 9, 6, 10, 0)), 2026, 9, 8, 9);
  });

  it("atravessa o Carnaval inteiro", () => {
    // 15/02/2026 é domingo; segunda e terça são Carnaval.
    esperaSlot(
      proximoHorarioComercial(brt(2026, 2, 15, 12, 0)),
      2026,
      2,
      18,
      9,
    );
  });

  it("atravessa a virada do ano", () => {
    // 31/12/2026 é quinta, 01/01/2027 é feriado numa sexta.
    esperaSlot(
      proximoHorarioComercial(brt(2026, 12, 31, 19, 0)),
      2027,
      1,
      4,
      9,
    );
  });

  it("mantém os invariantes em qualquer hora de qualquer dia da semana", () => {
    // A varredura é o que pega erro de fronteira que um caso pontual não vê:
    // agendar no passado, cair em minuto quebrado (o cron é horário), ou escapar
    // do expediente.
    for (const dia of [21, 22, 23, 24, 25]) {
      for (let h = 0; h < 24; h++) {
        const agora = brt(2026, 8, dia, h, 37);
        const alvo = proximoHorarioComercial(agora) * 1000;
        expect(alvo).toBeGreaterThan(agora);
        expect(alvo % 3_600_000).toBe(0);
        expect(dentroDoExpediente(alvo)).toBe(true);
      }
    }
  });
});
