import { Paperclip, Users } from "lucide-react";
import RascunhoPill from "@/components/RascunhoPill";
import { useRascunhos } from "@/lib/rascunho";
import { cn } from "@/lib/utils";
import { quandoCurto, plural } from "@/lib/datas";
import type { GroupedConversation } from "@/lib/api";
import { NaoLidasBadge, Selecao, useIntencao } from "@/components/LinhaLista";

/** "Ana, Bruno, Carla" ou "Ana, Bruno +3". */
export function nomesDoGrupo(
  participants: GroupedConversation["participants"],
): string {
  if (participants.length === 0) return "Conversa em grupo";
  const nomes = participants.map((p) =>
    p.name?.trim() ? p.name.trim().split(/\s+/)[0] : p.email.split("@")[0],
  );
  if (nomes.length <= 3) return nomes.join(", ");
  return `${nomes.slice(0, 2).join(", ")} +${nomes.length - 2}`;
}

interface GroupRowProps {
  group: GroupedConversation;
  isSelected: boolean;
  marcada: boolean;
  algumaMarcada: boolean;
  mostrarCaixa: boolean;
  rotuloCaixa: (email: string) => string;
  onSelect: () => void;
  onToggle: () => void;
  onMarkRead: () => void;
  onIntencao: () => void;
}

/**
 * Linha de uma conversa com 2+ participantes de fora. Os CCs internos não aparecem:
 * fazem parte do fio, mas não definem de quem é a conversa.
 */
export default function GroupRow({
  group,
  isSelected,
  marcada,
  algumaMarcada,
  mostrarCaixa,
  rotuloCaixa,
  onSelect,
  onToggle,
  onMarkRead,
  onIntencao,
}: GroupRowProps) {
  const { porPessoa } = useRascunhos();
  const temRascunho = group.participants.some((p) => porPessoa.has(p.id));
  const intencao = useIntencao(onIntencao);
  const naoLida = group.unreadCount > 0;
  const assunto = group.latestSubject?.trim() || "(sem assunto)";
  const nomes = nomesDoGrupo(group.participants);

  return (
    <li
      className={cn(
        "group relative border-b border-border-subtle",
        isSelected
          ? "bg-primary-soft"
          : marcada
            ? "bg-primary-soft/60"
            : "hover:bg-bg-subtle",
      )}
    >
      {isSelected && (
        <span
          className="absolute inset-y-0 left-0 w-[3px] bg-primary"
          aria-hidden
        />
      )}
      <button
        type="button"
        data-testid="group-row"
        data-conversation-id={group.id}
        onClick={onSelect}
        {...intencao}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 py-2.5 pl-2.5 pr-3 text-left focus:outline-none focus-visible:bg-bg-subtle"
      >
        <span className="flex h-4 items-center justify-center self-center">
          {marcada || algumaMarcada ? (
            <Selecao
              marcado={marcada}
              visivel
              rotulo={`Selecionar conversa com ${nomes}`}
              onAlternar={onToggle}
            />
          ) : (
            <>
              <span
                className={cn(
                  "h-2 w-2 rounded-full bg-primary group-hover:hidden",
                  !naoLida && "invisible",
                )}
                aria-hidden
              />
              <span className="hidden group-hover:flex">
                <Selecao
                  marcado={false}
                  visivel
                  rotulo={`Selecionar conversa com ${nomes}`}
                  onAlternar={onToggle}
                />
              </span>
            </>
          )}
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-[13px] text-text-primary",
            naoLida ? "font-semibold" : "font-medium",
          )}
          title={group.participants.map((p) => p.email).join(", ")}
        >
          <Users
            size={13}
            className="shrink-0 text-text-tertiary"
            aria-label="Grupo"
          />
          <span className="truncate">{nomes}</span>
        </span>
        <span
          className={cn(
            "text-xs tabular-nums",
            naoLida ? "font-semibold text-primary-ink" : "text-text-tertiary",
          )}
        >
          {quandoCurto(group.lastEmailAt)}
        </span>

        <span
          className={cn(
            "col-start-2 col-end-4 truncate text-[13px]",
            naoLida ? "text-text-primary" : "text-text-secondary",
          )}
          title={assunto}
        >
          {assunto}
        </span>

        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary">
          {mostrarCaixa && (
            <span
              className="max-w-[150px] truncate rounded-[4px] border border-border px-1.5 text-[11px] leading-[18px]"
              title={group.inbox}
            >
              {rotuloCaixa(group.inbox)}
            </span>
          )}
          <span className="tabular-nums">
            {plural(group.totalCount, "mensagem", "mensagens")}
          </span>
          {group.hasAttachment === 1 && (
            <Paperclip size={12} aria-label="Tem anexo" />
          )}
          {temRascunho && <RascunhoPill />}
          {naoLida && (
            <NaoLidasBadge n={group.unreadCount} onMarcar={onMarkRead} />
          )}
        </span>
      </button>
    </li>
  );
}
