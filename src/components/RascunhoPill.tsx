import { FileText } from "lucide-react";

import { tx } from "@/lib/i18n";
/**
 * Marca "Rascunho" — a mesma em bolha, linha da caixa e conversa em grupo, para
 * o usuário achar onde parou. Só aparece quando o servidor tem um rascunho do
 * usuário para aquela mensagem (ver `useRascunhos`).
 */
export default function RascunhoPill() {
  return (
    <span
      data-testid="rascunho-pill"
      className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning-text"
      title={tx("Você tem uma resposta em rascunho aqui")}
    >
      <FileText size={9} />
      {tx("Rascunho")}
    </span>
  );
}
