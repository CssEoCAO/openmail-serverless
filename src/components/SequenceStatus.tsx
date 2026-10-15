import { useState } from "react";
import { ListOrdered, X } from "lucide-react";
import { cancelEnrollment, type PersonEnrollmentInfo } from "@/lib/api";
import { dataHora } from "@/lib/datas";

import { tx } from "@/lib/i18n";
interface SequenceStatusProps {
  /** Inscrição já carregada pelo PersonDetail (uma chamada só por conversa). */
  info: PersonEnrollmentInfo;
  onStatusChange: () => void;
}

/** Sequência em andamento para a pessoa: nome, progresso e cancelar. */
export default function SequenceStatus({
  info,
  onStatusChange,
}: SequenceStatusProps) {
  const [cancelando, setCancelando] = useState(false);
  if (!info.enrollment) return null;

  // "suppressed" é fim sem entrega: conta como feito, senão a inscrição parece travada.
  const feitos = info.scheduledEmails.filter(
    (e) => e.status === "sent" || e.status === "suppressed",
  ).length;
  const total = info.scheduledEmails.length;
  const proximo = info.scheduledEmails.find(
    (e) => e.status === "pending" || e.status === "queued",
  );

  async function cancelar() {
    if (!info.enrollment) return;
    if (
      !confirm(
        tx('Cancelar a sequência "{0}" para esta pessoa?', info.sequenceName),
      )
    )
      return;
    setCancelando(true);
    try {
      await cancelEnrollment(info.enrollment.id);
      onStatusChange();
    } finally {
      setCancelando(false);
    }
  }

  return (
    <span
      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-success/30 bg-success-subtle pl-2.5 pr-1 text-xs text-success"
      title={
        proximo
          ? tx("Próximo envio: {0}", dataHora(proximo.scheduledAt))
          : tx("Todos os envios já saíram")
      }
    >
      <ListOrdered size={14} />
      <span className="max-w-[140px] truncate font-medium">
        {info.sequenceName}
      </span>
      <span className="tabular-nums opacity-80">
        {feitos}/{total}
      </span>
      <button
        type="button"
        onClick={cancelar}
        disabled={cancelando}
        aria-label={tx("Cancelar sequência")}
        title={tx("Cancelar sequência")}
        className="flex h-6 w-6 items-center justify-center rounded-[4px] hover:bg-success/15 disabled:opacity-50"
      >
        <X size={13} />
      </button>
    </span>
  );
}
