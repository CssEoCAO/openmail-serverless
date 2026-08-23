/**
 * Auto-saved reply drafts, in localStorage.
 *
 * Deliberately client-side: the whole point is to survive a closed tab or an accidental
 * navigation, and that is a browser-lifetime problem. A server-side drafts table would
 * also sync across devices, but it costs a migration, routes, inbox scoping and a
 * cleanup job — none of which the "I lost what I typed" complaint is actually about.
 * If cross-device drafts are ever wanted, this module is the seam to swap.
 *
 * What is NOT saved: attachments. `File` objects do not serialise, and re-reading them
 * later would need the File System Access API. The composer says so out loud rather than
 * letting the user assume a restored draft still carries the PDF they picked.
 */

const PREFIXO = "saasmail.rascunho.";
/** Drafts older than this are dropped on read. A reply you abandoned a month ago
 *  reappearing under a new message is worse than losing it. */
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

export interface Rascunho {
  fromAddress: string;
  cc: unknown[];
  bodyHtml: string;
  bodyText: string;
  /** epoch ms, used for expiry */
  em: number;
}

const chave = (emailId: string) => `${PREFIXO}${emailId}`;

/** True when there is nothing worth keeping — avoids writing a row per opened reply. */
export function rascunhoVazio(r: Omit<Rascunho, "em">): boolean {
  const texto = (r.bodyText || "").replace(/\s| /g, "");
  return texto === "" && (r.cc?.length ?? 0) === 0;
}

export function lerRascunho(emailId: string): Rascunho | null {
  try {
    const cru = window.localStorage?.getItem(chave(emailId));
    if (!cru) return null;
    const r = JSON.parse(cru) as Rascunho;
    if (typeof r?.bodyHtml !== "string" || typeof r?.em !== "number")
      return null;
    if (Date.now() - r.em > VALIDADE_MS) {
      apagarRascunho(emailId);
      return null;
    }
    return r;
  } catch {
    // Corrupted JSON, private mode, disabled storage. A draft is a convenience —
    // it must never be the reason the composer fails to open.
    return null;
  }
}

export function salvarRascunho(emailId: string, r: Omit<Rascunho, "em">): void {
  try {
    if (rascunhoVazio(r)) {
      apagarRascunho(emailId);
      return;
    }
    window.localStorage?.setItem(
      chave(emailId),
      JSON.stringify({ ...r, em: Date.now() }),
    );
  } catch {
    // Quota exceeded is the realistic failure here. Losing the draft silently is bad,
    // but throwing inside an onChange handler would break typing itself.
  }
}

export function apagarRascunho(emailId: string): void {
  try {
    window.localStorage?.removeItem(chave(emailId));
  } catch {
    /* nothing to do */
  }
}
