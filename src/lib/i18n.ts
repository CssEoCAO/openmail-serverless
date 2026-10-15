// Idioma da interface. O texto-fonte é o português; `en.ts` traz o inglês.
// O idioma vale para a página inteira: trocar grava a escolha e recarrega,
// então tudo que é avaliado na importação (rótulos em constantes) já sai certo.
import { EN } from "./en";

export type Lang = "pt" | "en";

const CHAVE = "openmail.lang";

function detectar(): Lang {
  try {
    const salvo = localStorage.getItem(CHAVE);
    if (salvo === "pt" || salvo === "en") return salvo;
  } catch {
    // Storage bloqueado: segue o navegador.
  }
  const nav = typeof navigator === "undefined" ? "pt" : navigator.language;
  return nav.toLowerCase().startsWith("pt") ? "pt" : "en";
}

export const LANG: Lang = detectar();
export const LOCALE = LANG === "pt" ? "pt-BR" : "en-US";

if (typeof document !== "undefined") document.documentElement.lang = LOCALE;

/** Traduz um texto da interface; `{0}`, `{1}`… recebem os argumentos. */
export function tx(texto: string, ...args: unknown[]): string {
  const base = LANG === "en" ? (EN[texto] ?? texto) : texto;
  return args.length
    ? base.replace(/\{(\d+)\}/g, (m, i) =>
        Number(i) < args.length ? String(args[Number(i)]) : m,
      )
    : base;
}

export function trocarIdioma(lang: Lang): void {
  try {
    localStorage.setItem(CHAVE, lang);
  } catch {
    // Sem storage a escolha vale só até recarregar.
  }
  location.reload();
}
