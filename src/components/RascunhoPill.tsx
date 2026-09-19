import { FileText } from "lucide-react";

/**
 * Marca "Rascunho" — a mesma em bolha, linha da caixa e conversa em grupo, para
 * o usuário achar onde parou. Só aparece quando o servidor tem um rascunho do
 * usuário para aquela mensagem (ver `useRascunhos`).
 */
export default function RascunhoPill() {
  return (
    <span
      data-testid="rascunho-pill"
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
      title="Você tem uma resposta em rascunho aqui"
    >
      <FileText size={9} />
      Rascunho
    </span>
  );
}
