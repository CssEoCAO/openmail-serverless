import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Check,
  Copy,
  Fingerprint,
  Mail,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  fetchUsers,
  fetchInvites,
  createInvite,
  updateUserRole,
  deleteUser,
  revokeInvite,
} from "@/lib/api";
import type { User, Invite } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { SectionHeader } from "@/components/PageForm";
import { cn } from "@/lib/utils";
import Monograma from "@/components/Monograma";

import { LOCALE, tx } from "@/lib/i18n";
import { plural } from "@/lib/datas";
function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(LOCALE);
}

function relativeTime(ts: number): string {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 3600)
    return diff < 0 ? tx("agora há pouco") : tx("em menos de 1 h");
  if (abs < 86400)
    return diff < 0
      ? tx("há {0} h", Math.floor(abs / 3600))
      : tx("em {0} h", Math.floor(abs / 3600));
  const days = Math.floor(abs / 86400);
  return diff < 0 ? tx("há {0} d", days) : tx("em {0} d", days);
}

type InviteStatus = "pending" | "used" | "expired";
function inviteStatus(invite: Invite): InviteStatus {
  if (invite.usedBy) return "used";
  if (invite.expiresAt * 1000 < Date.now()) return "expired";
  return "pending";
}

const INVITE_STATUS_META: Record<
  InviteStatus,
  { label: string; chipClass: string }
> = {
  pending: {
    label: tx("Aberto"),
    chipClass: "bg-success-subtle text-success ring-success/30",
  },
  used: {
    label: tx("Aceito"),
    chipClass: "bg-primary-soft text-primary-ink ring-primary/20",
  },
  expired: {
    label: tx("Expirado"),
    chipClass: "bg-bg-muted text-text-tertiary ring-border",
  },
};

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("7");
  const [generatedLink, setGeneratedLink] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const [u, i] = await Promise.all([fetchUsers(), fetchInvites()]);
      setUsers(u);
      setInvites(i);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session?.user?.role === "admin") loadData();
  }, [session]);

  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  async function handleCreateInvite() {
    setInviteLoading(true);
    try {
      const invite = await createInvite({
        role: inviteRole,
        email: inviteEmail || undefined,
        expiresInDays: parseInt(inviteExpiry) || 7,
      });
      setGeneratedLink(`${window.location.origin}/invite/${invite.token}`);
      setCopied(false);
      await loadData();
    } catch {
      // ignore
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
  }

  async function handleRoleChange(userId: string, role: "admin" | "member") {
    await updateUserRole(userId, role);
    await loadData();
  }

  async function handleDelete(userId: string) {
    if (!confirm(tx("Excluir este usuário? Não dá para desfazer."))) return;
    await deleteUser(userId);
    await loadData();
  }

  async function handleRevoke(inviteId: string) {
    if (!confirm(tx("Revogar este convite? Não dá para desfazer."))) return;
    await revokeInvite(inviteId);
    await loadData();
  }

  return (
    <PageContainer>
      <PageHeader
        title={tx("Usuários")}
        subtitle={tx(
          "Convide pessoas, defina o papel de cada uma e veja quem já tem passkey.",
        )}
        action={
          <Dialog
            open={inviteDialogOpen}
            onOpenChange={(open) => {
              setInviteDialogOpen(open);
              if (!open) {
                setGeneratedLink("");
                setInviteEmail("");
                setInviteRole("member");
                setInviteExpiry("7");
              }
            }}
          >
            <DialogTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
                <Plus size={14} />
                {tx("Convidar")}
              </button>
            </DialogTrigger>
            <DialogContent className="border-border bg-card text-text-primary ring-1 ring-border">
              <DialogHeader>
                <DialogTitle className="text-text-primary">
                  {generatedLink ? tx("Convite pronto") : tx("Novo convite")}
                </DialogTitle>
              </DialogHeader>
              {!generatedLink ? (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-text-secondary">
                      {tx("Papel")}
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <RoleButton
                        active={inviteRole === "member"}
                        onClick={() => setInviteRole("member")}
                        label={tx("Membro")}
                        hint={tx("Só as caixas liberadas")}
                      />
                      <RoleButton
                        active={inviteRole === "admin"}
                        onClick={() => setInviteRole("admin")}
                        label={tx("Administrador")}
                        hint={tx("Acesso total")}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-email"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      {tx("E-mail")}{" "}
                      <span className="text-text-tertiary">
                        {tx("(opcional)")}
                      </span>
                    </label>
                    <input
                      id="invite-email"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder={tx("pessoa@exemplo.com")}
                      className="h-10 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
                    />
                    <p className="text-[11px] font-light text-text-tertiary">
                      {tx(
                        "Prende o convite a um endereço; em branco, qualquer pessoa com o link aceita.",
                      )}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-expiry"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      {tx("Vale por (dias)")}
                    </label>
                    <input
                      id="invite-expiry"
                      type="number"
                      min="1"
                      max="30"
                      value={inviteExpiry}
                      onChange={(e) => setInviteExpiry(e.target.value)}
                      className="h-10 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:border-primary focus:outline-none"
                    />
                  </div>

                  <button
                    onClick={handleCreateInvite}
                    disabled={inviteLoading}
                    className="w-full rounded-[6px] bg-primary py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {inviteLoading ? tx("Criando…") : tx("Criar convite")}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-light text-text-secondary">
                    {tx("Mande este link. Ele vale por")}{" "}
                    {plural(Number(inviteExpiry), "dia", "dias")}.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={generatedLink}
                      readOnly
                      className="h-10 flex-1 rounded-[6px] border border-border bg-bg-subtle px-3 text-xs text-text-primary focus:outline-none"
                    />
                    <button
                      onClick={handleCopy}
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      {copied ? tx("Copiado") : tx("Copiar")}
                    </button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        }
      />

      <div className="max-w-4xl space-y-6">
        {/* --- Members --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Users}
              title={tx("Pessoas ({0})", users.length)}
              subtitle={tx("Todo mundo com login nesta caixa.")}
            />
          </div>

          {loading ? (
            <p className="px-5 py-6 text-xs font-light text-text-tertiary">
              {tx("Carregando…")}
            </p>
          ) : users.length === 0 ? (
            <EmptyState
              icon={Users}
              title={tx("Ninguém ainda")}
              hint={tx("Convide a primeira pessoa pelo botão acima.")}
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {users.map((user) => {
                const isMe = user.id === session?.user?.id;
                const isAdmin = user.role === "admin";
                return (
                  <li
                    key={user.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <Monograma nome={user.name} email={user.email} />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {user.name || user.email}
                        </p>
                        {isMe && (
                          <span className="inline-flex items-center rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
                            {tx("você")}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        {user.email} {tx("· desde")}{" "}
                        {formatDate(user.createdAt)}
                      </p>
                    </div>

                    <div className="hidden shrink-0 items-center gap-2 sm:flex">
                      <UserBadge
                        active={user.hasPasskey}
                        icon={Fingerprint}
                        labelOn="Passkey"
                        labelOff={tx("Sem passkey")}
                      />
                      <UserBadge
                        active={isAdmin}
                        icon={ShieldCheck}
                        labelOn={tx("Administrador")}
                        labelOff={tx("Membro")}
                      />
                    </div>

                    {!isMe && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label={tx("Mais ações")}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="border-border bg-card text-text-primary ring-1 ring-border"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              handleRoleChange(
                                user.id,
                                isAdmin ? "member" : "admin",
                              )
                            }
                            className="text-xs text-text-secondary focus:bg-bg-muted focus:text-text-primary"
                          >
                            {isAdmin
                              ? tx("Tornar membro")
                              : tx("Tornar administrador")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDelete(user.id)}
                            className="text-xs text-destructive focus:bg-bg-muted"
                          >
                            {tx("Excluir usuário")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* --- Invitations --- */}
        <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
          <div className="border-b border-border px-5 py-4">
            <SectionHeader
              icon={Mail}
              title={tx("Convites ({0})", invites.length)}
              subtitle={tx("Convites abertos e os antigos.")}
            />
          </div>

          {invites.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title={tx("Nenhum convite ainda")}
              hint={tx("Crie um pelo botão acima.")}
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                const meta = INVITE_STATUS_META[status];
                return (
                  <li
                    key={invite.id}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted">
                      <Mail size={14} className="text-text-tertiary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {invite.email || tx("Convite aberto")}
                        </p>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                            meta.chipClass,
                          )}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <p className="truncate text-xs font-light text-text-tertiary">
                        {invite.role === "admin" ? "administrador" : "membro"} ·{" "}
                        {status === "expired"
                          ? tx("expirou em {0}", formatDate(invite.expiresAt))
                          : status === "used"
                            ? `aceito ${invite.usedAt ? formatDate(invite.usedAt) : ""}`
                            : `expira ${relativeTime(invite.expiresAt)}`}
                      </p>
                    </div>
                    {status === "pending" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label={tx("Mais ações")}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="border-border bg-card text-text-primary ring-1 ring-border"
                        >
                          <DropdownMenuItem
                            onClick={() => handleRevoke(invite.id)}
                            className="text-xs text-destructive focus:bg-bg-muted"
                          >
                            {tx("Revogar convite")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}

/* --------------------------------- helpers --------------------------------- */

function RoleButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[8px] border px-3 py-2 text-left transition-colors",
        active
          ? "border-primary bg-primary-soft"
          : "border-border bg-card hover:bg-bg-muted",
      )}
    >
      <span
        className={cn(
          "block text-xs font-semibold",
          active ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {label}
      </span>
      <span className="block text-[11px] font-light text-text-tertiary">
        {hint}
      </span>
    </button>
  );
}

function UserBadge({
  active,
  icon: Icon,
  labelOn,
  labelOff,
}: {
  active: boolean;
  icon: React.ElementType;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
        active
          ? "bg-primary-soft text-primary-ink ring-primary/20"
          : "bg-bg-muted ring-border text-text-tertiary",
      )}
    >
      <Icon size={9} />
      {active ? labelOn : labelOff}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint: string;
}) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 text-xs font-light text-text-tertiary">{hint}</p>
    </div>
  );
}
