/**
 * "Send this during business hours" — Brazilian business hours, computed in UTC.
 *
 * The Worker has no timezone: everything is epoch seconds. Brazil abolished DST in 2019
 * (Decreto 9.772/2019), so America/Sao_Paulo is a fixed UTC-3 with no transition to model.
 * That is the only reason a fixed offset is honest here; anywhere with DST this would have
 * to go through Intl.
 *
 * The slot is always on the hour because the drainer is an hourly cron (`0 * * * *`).
 * Scheduling for 09:37 would sit in the outbox until 10:00 and quietly arrive 23 minutes
 * late — so the arithmetic rounds up to the hour instead of pretending minute precision.
 */

/** UTC-3, fixed. See the note above about DST. */
const OFFSET_MS = -3 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

export const ABRE_HORA = 9;
/** Exclusive: 18 means the last slot that still counts as business hours is 17:00. */
export const FECHA_HORA = 18;

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), como [mes, dia] no ano dado. */
function domingoDePascoa(ano: number): [number, number] {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return [mes, dia];
}

const dois = (n: number) => String(n).padStart(2, "0");
const marca = (ano: number, mes: number, dia: number) =>
  `${ano}-${dois(mes)}-${dois(dia)}`;

/**
 * Feriados nacionais brasileiros do ano, como "YYYY-MM-DD" em horário de Brasília.
 *
 * Só os NACIONAIS: feriado municipal varia por cidade e não há como saber a de cada
 * destinatário. Errar para menos aqui manda um e-mail num feriado local; errar para mais
 * seguraria mail em dia útil de todo mundo por causa de uma cidade.
 *
 * Carnaval (terça) e Corpus Christi não são feriados nacionais por lei, mas param o país
 * na prática, então entram — a pergunta que este módulo responde é "tem gente lendo
 * e-mail?", não "o banco abriu?".
 */
export function feriadosNacionais(ano: number): Set<string> {
  const [mp, dp] = domingoDePascoa(ano);
  const pascoa = Date.UTC(ano, mp - 1, dp);
  const desloca = (dias: number) => {
    const d = new Date(pascoa + dias * DIA_MS);
    return marca(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };
  return new Set([
    marca(ano, 1, 1), // Confraternização Universal
    desloca(-48), // Carnaval (segunda)
    desloca(-47), // Carnaval (terça)
    desloca(-2), // Sexta-feira Santa
    marca(ano, 4, 21), // Tiradentes
    marca(ano, 5, 1), // Dia do Trabalho
    desloca(60), // Corpus Christi
    marca(ano, 9, 7), // Independência
    marca(ano, 10, 12), // Nossa Senhora Aparecida
    marca(ano, 11, 2), // Finados
    marca(ano, 11, 15), // Proclamação da República
    marca(ano, 11, 20), // Consciência Negra (nacional desde a Lei 14.759/2023)
    marca(ano, 12, 25), // Natal
  ]);
}

/** Campos do instante já em horário de Brasília. */
function emBrasilia(ms: number) {
  const d = new Date(ms + OFFSET_MS);
  return {
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate(),
    hora: d.getUTCHours(),
    minuto: d.getUTCMinutes(),
    diaDaSemana: d.getUTCDay(), // 0 = domingo
  };
}

export function ehDiaUtil(ms: number): boolean {
  const { ano, mes, dia, diaDaSemana } = emBrasilia(ms);
  if (diaDaSemana === 0 || diaDaSemana === 6) return false;
  return !feriadosNacionais(ano).has(marca(ano, mes, dia));
}

/** True quando `ms` cai dentro do expediente (dia útil e ABRE <= hora < FECHA). */
export function dentroDoExpediente(ms: number): boolean {
  if (!ehDiaUtil(ms)) return false;
  const { hora } = emBrasilia(ms);
  return hora >= ABRE_HORA && hora < FECHA_HORA;
}

/**
 * Próximo instante de horário comercial, em EPOCH SECONDS, estritamente depois de `agoraMs`
 * e sempre em hora cheia.
 *
 * "Estritamente depois" é de propósito: agendar para o próprio instante entregaria na
 * rodada seguinte do cron de qualquer jeito, e o botão prometeria uma hora que já passou.
 */
export function proximoHorarioComercial(agoraMs: number): number {
  // Sobe para a próxima hora cheia. Se já estamos exatamente em hora cheia, avança uma:
  // o cron daquele minuto pode já ter rodado.
  let alvo = Math.floor(agoraMs / HORA_MS) * HORA_MS + HORA_MS;

  // Anda de hora em hora até cair no expediente. O teto de 24*400 iterações é folga
  // enorme (o maior salto real é um feriado emendado) e existe só para que um bug de
  // calendário vire erro em vez de laço infinito dentro de um request.
  for (let i = 0; i < 24 * 400; i++) {
    if (dentroDoExpediente(alvo)) return Math.floor(alvo / 1000);
    const { hora } = emBrasilia(alvo);
    // Antes de abrir: pula direto para a abertura do mesmo dia. Depois de fechar ou fora
    // de dia útil: pula para a abertura do dia seguinte. Evita 24 iterações por noite.
    if (ehDiaUtil(alvo) && hora < ABRE_HORA) {
      alvo += (ABRE_HORA - hora) * HORA_MS;
    } else {
      const { hora: h } = emBrasilia(alvo);
      alvo += (24 - h + ABRE_HORA) * HORA_MS;
    }
  }
  throw new Error(
    "proximoHorarioComercial: não achou slot — calendário quebrado?",
  );
}

/** Rótulo curto em horário de Brasília, para o botão dizer o que vai fazer. */
export function rotuloBrasilia(epochSegundos: number): string {
  const { dia, mes, hora } = emBrasilia(epochSegundos * 1000);
  return `${dois(dia)}/${dois(mes)} às ${dois(hora)}:00`;
}
