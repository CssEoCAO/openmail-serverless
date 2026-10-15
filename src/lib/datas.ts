/** Datas para lista e leitura, no idioma da interface. Recebem epoch em segundos, como a API. */
import { LANG, LOCALE, tx } from "@/lib/i18n";
import { rotuloBrasilia } from "@worker/lib/horario-comercial";

const hora = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
});
const diaSemanaCurto = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });
const diaSemanaLongo = new Intl.DateTimeFormat(LOCALE, { weekday: "long" });
const diaMes = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
});
const diaMesAno = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const diaMesLongo = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "long",
});
const diaMesAnoLongo = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const semPonto = (s: string) => s.replace(/\./g, "");

function inicioDoDia(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function diasAtras(d: Date, agora: Date): number {
  return Math.round((inicioDoDia(agora) - inicioDoDia(d)) / 86_400_000);
}

/** Para a lista: "agora", "12 min", "10:42", "ontem", "ter", "4 out", "4 out 2025". */
export function quandoCurto(ts: number, agora = new Date()): string {
  const d = new Date(ts * 1000);
  const minutos = Math.floor((agora.getTime() - d.getTime()) / 60_000);
  if (minutos < 1) return tx("agora");
  if (minutos < 60) return `${minutos} min`;
  const dias = diasAtras(d, agora);
  if (dias === 0) return hora.format(d);
  if (dias === 1) return tx("ontem");
  if (dias < 7) return semPonto(diaSemanaCurto.format(d));
  if (d.getFullYear() === agora.getFullYear())
    return semPonto(diaMes.format(d));
  return semPonto(diaMesAno.format(d));
}

/** Para a mensagem aberta: "hoje, 10:42", "ontem, 18:02", "7 out, 16:20". */
export function dataHora(ts: number, agora = new Date()): string {
  const d = new Date(ts * 1000);
  const dias = diasAtras(d, agora);
  const h = hora.format(d);
  if (dias === 0) return tx("hoje, {0}", h);
  if (dias === 1) return tx("ontem, {0}", h);
  const dia =
    d.getFullYear() === agora.getFullYear()
      ? diaMes.format(d)
      : diaMesAno.format(d);
  return `${semPonto(dia)}, ${h}`;
}

/** Separador de dia na conversa: "Hoje", "Ontem", "Terça-feira", "7 de outubro". */
export function rotuloDia(ts: number, agora = new Date()): string {
  const d = new Date(ts * 1000);
  const dias = diasAtras(d, agora);
  if (dias === 0) return "Hoje";
  if (dias === 1) return "Ontem";
  if (dias < 7) {
    const s = diaSemanaLongo.format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return d.getFullYear() === agora.getFullYear()
    ? diaMesLongo.format(d)
    : diaMesAnoLongo.format(d);
}

/** Só a hora: "10:42". */
export function soHora(ts: number): string {
  return hora.format(new Date(ts * 1000));
}

/** "1 mensagem" / "3 mensagens". As palavras passam pela tradução. */
export function plural(n: number, um: string, varios: string): string {
  return `${n} ${tx(n === 1 ? um : varios)}`;
}

/** Rótulo do próximo horário comercial (sempre em Brasília, como o envio). */
export function rotuloHorario(epochSegundos: number): string {
  if (LANG === "pt") return rotuloBrasilia(epochSegundos);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: "America/Sao_Paulo",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochSegundos * 1000));
}
