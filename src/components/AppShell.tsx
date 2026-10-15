import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, PenSquare } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Sidebar from "@/components/Sidebar";
import Toaster from "@/components/Toaster";
import { PushOptInBanner } from "@/components/PushOptInBanner";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { useBranding } from "@/lib/branding";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { hasDismissedPrompt, isPushSupported } from "@/lib/push";
import { onEmailSent } from "@/lib/email-events";
import { onInboxRefresh } from "@/lib/inbox-events";
import { notificarRascunhos } from "@/lib/rascunho";
import { WebMcpBridgeProvider, type ComposeSeed } from "@/webmcp/bridge";
import { WebMcpTools } from "@/webmcp/registerTools";
import { chaves, useStats } from "@/lib/queries";

import { tx } from "@/lib/i18n";
// O editor de texto (Tiptap) vem junto com a bandeja: só baixa no primeiro "Escrever".
const ComposeModal = lazy(() => import("@/pages/ComposeModal"));

export interface ShellContext {
  onCompose: (prefill?: ComposePrefill) => void;
}

export default function AppShell() {
  const qc = useQueryClient();
  const { brandName, webmcpEnabled } = useBranding();
  const navigate = useNavigate();
  const { data: stats } = useStats();
  const [menuAberto, setMenuAberto] = useState(false);
  const [compose, setCompose] = useState<{
    aberto: boolean;
    usado: boolean;
    prefill: ComposePrefill | null;
  }>({ aberto: false, usado: false, prefill: null });
  const [pedirPush, setPedirPush] = useState(false);

  const onCompose = useCallback((prefill?: ComposePrefill) => {
    setCompose({ aberto: true, usado: true, prefill: prefill ?? null });
  }, []);

  // As ferramentas WebMCP (um agente no navegador) dirigem a tela por aqui. O
  // filtro "Rascunhos" desta interface é a página própria, não `/?drafts=1`.
  const irPara = useCallback(
    (path: string) => {
      const url = new URL(path, window.location.origin);
      const rascunhos = ["1", "true"].includes(
        url.searchParams.get("drafts") ?? "",
      );
      navigate(rascunhos ? "/rascunhos" : path);
    },
    [navigate],
  );
  const abrirRascunho = useCallback(
    (seed: ComposeSeed) =>
      onCompose({
        ...(seed.from ? { from: seed.from } : {}),
        ...(seed.to ? { to: seed.to } : {}),
        ...(seed.subject ? { subject: seed.subject } : {}),
        ...(seed.bodyHtml ? { bodyHtml: seed.bodyHtml } : {}),
        ...(seed.cc
          ? {
              cc: seed.cc.map((c) => ({
                email: c.email,
                name: c.name ?? null,
              })),
            }
          : {}),
      }),
    [onCompose],
  );
  // Uma ação do agente mexeu em dados (salvou rascunho, matriculou contato):
  // listas e o selo de rascunhos refazem a consulta.
  useEffect(
    () =>
      onInboxRefresh(() => {
        void qc.invalidateQueries({ queryKey: chaves.conversas });
        void qc.invalidateQueries({ queryKey: ["emails-pessoa"] });
        void qc.invalidateQueries({ queryKey: ["conversa"] });
        notificarRascunhos();
      }),
    [qc],
  );

  // Um WebSocket só, aqui no casco: e-mail novo atualiza contadores e listas em
  // qualquer tela, não só na caixa.
  useRealtimeUpdates(
    () => {
      void qc.invalidateQueries({ queryKey: chaves.stats });
      void qc.invalidateQueries({ queryKey: chaves.conversas });
      void qc.invalidateQueries({ queryKey: ["emails-pessoa"] });
      void qc.invalidateQueries({ queryKey: ["conversa"] });
    },
    () => {
      if (!isPushSupported() || hasDismissedPrompt()) return;
      if (Notification.permission !== "default") return;
      setPedirPush(true);
    },
  );

  // Enviou: a conversa ganha a mensagem e a fila de saída pode ter mudado.
  useEffect(
    () =>
      onEmailSent(() => {
        void qc.invalidateQueries({ queryKey: chaves.conversas });
        void qc.invalidateQueries({ queryKey: chaves.saida });
        void qc.invalidateQueries({ queryKey: ["emails-pessoa"] });
        void qc.invalidateQueries({ queryKey: ["conversa"] });
      }),
    [qc],
  );

  const naoLidas = stats?.unreadCount ?? 0;
  useEffect(() => {
    document.title = naoLidas > 0 ? `(${naoLidas}) ${brandName}` : brandName;
  }, [naoLidas, brandName]);

  return (
    <WebMcpBridgeProvider navigate={irPara} openCompose={abrirRascunho}>
      {webmcpEnabled && <WebMcpTools />}
      <div className="flex h-dvh overflow-hidden bg-background">
        <aside className="hidden w-[240px] shrink-0 border-r border-border lg:block">
          <Sidebar onCompose={() => onCompose()} />
        </aside>

        <DialogPrimitive.Root open={menuAberto} onOpenChange={setMenuAberto}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="drawer-overlay fixed inset-0 z-40 bg-black/40 lg:hidden" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className="drawer-content fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[300px] bg-background shadow-xl focus:outline-none lg:hidden"
              style={{ paddingTop: "env(safe-area-inset-top)" }}
            >
              <DialogPrimitive.Title className="sr-only">
                {tx("Menu")}
              </DialogPrimitive.Title>
              <Sidebar
                onCompose={() => onCompose()}
                onNavigate={() => setMenuAberto(false)}
                onClose={() => setMenuAberto(false)}
              />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Celular e tablet: a lateral vira gaveta, e o Escrever fica sempre à mão. */}
          <header
            className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 lg:hidden"
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            <button
              type="button"
              onClick={() => setMenuAberto(true)}
              aria-label={tx("Abrir menu")}
              className="flex h-9 w-9 items-center justify-center rounded-[6px] text-text-secondary hover:bg-text-primary/[0.05]"
            >
              <Menu size={18} />
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              {brandName}
            </span>
            <button
              type="button"
              onClick={() => onCompose()}
              className="flex h-9 items-center gap-1.5 rounded-[6px] bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              <PenSquare size={15} />
              {tx("Escrever")}
            </button>
          </header>

          {pedirPush && <PushOptInBanner onClose={() => setPedirPush(false)} />}

          <main className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<div className="flex-1" />}>
              <Outlet context={{ onCompose } satisfies ShellContext} />
            </Suspense>
          </main>
        </div>

        {compose.usado && (
          <Suspense fallback={null}>
            <ComposeModal
              open={compose.aberto}
              onClose={() =>
                setCompose((c) => ({ ...c, aberto: false, prefill: null }))
              }
              prefill={compose.prefill}
            />
          </Suspense>
        )}

        <Toaster />
      </div>
    </WebMcpBridgeProvider>
  );
}
