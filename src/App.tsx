import { lazy, Suspense, useEffect } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { BrandingProvider, useBranding } from "@/lib/branding";
import { useSession } from "@/lib/auth-client";
import { fetchPasskeyStatus } from "@/lib/api";
import { preCarregarAbertura } from "@/lib/queries";
import AppShell from "@/components/AppShell";
import Carregando from "@/components/Carregando";
import InboxPage from "@/pages/InboxPage";

// Só a caixa vai no primeiro arquivo. O resto baixa quando a tela abre: o editor de
// HTML (CodeMirror) e o de texto (Tiptap) não pesam mais na abertura.
const PublicLayout = lazy(() => import("@/components/PublicLayout"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const ConsentPage = lazy(() => import("@/pages/ConsentPage"));
const OnboardingPage = lazy(() => import("@/pages/OnboardingPage"));
const InviteAcceptPage = lazy(() => import("@/pages/InviteAcceptPage"));
const SetupPasskeyPage = lazy(() => import("@/pages/SetupPasskeyPage"));
const TermsPage = lazy(() => import("@/pages/TermsPage"));
const PrivacyPage = lazy(() => import("@/pages/PrivacyPage"));
const UnsubscribePage = lazy(() => import("@/pages/UnsubscribePage"));
const TemplatesPage = lazy(() => import("@/pages/TemplatesPage"));
const TemplateEditorPage = lazy(() => import("@/pages/TemplateEditorPage"));
const AdminUsersPage = lazy(() => import("@/pages/AdminUsersPage"));
const SuppressionsPage = lazy(() => import("@/pages/SuppressionsPage"));
const ApiKeysPage = lazy(() => import("@/pages/ApiKeysPage"));
const SequencesPage = lazy(() => import("@/pages/SequencesPage"));
const SequenceDetailPage = lazy(() => import("@/pages/SequenceDetailPage"));
const SequenceEditorPage = lazy(() => import("@/pages/SequenceEditorPage"));
const InboxesPage = lazy(() => import("@/pages/InboxesPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const MessageLinkPage = lazy(() => import("@/pages/MessageLinkPage"));
const BlocklistPage = lazy(() => import("@/pages/BlocklistPage"));
const OutboxPage = lazy(() => import("@/pages/OutboxPage"));
const RascunhosPage = lazy(() => import("@/pages/RascunhosPage"));
const SpamPage = lazy(() => import("@/pages/SpamPage"));

// Dado de servidor fica 30 s fresco: trocar de caixa e voltar não refaz a chamada.
// A chegada de e-mail (WebSocket) e as ações invalidam o que mudou.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function AuthGuard() {
  const { data: session, isPending } = useSession();
  const { passkeyRequired, loaded: brandingLoaded } = useBranding();
  // Em paralelo com a sessão e a configuração, não depois delas: são três idas ao
  // servidor que antes saíam em fila. Sem sessão a resposta é 401 e não é usada.
  const passkey = useQuery({
    queryKey: ["passkey-status"],
    queryFn: fetchPasskeyStatus,
    retry: false,
    staleTime: Infinity,
  });
  // A caixa também não espera a sessão para pedir lista e contagens. Só na
  // abertura (o AuthGuard monta uma vez); link com ?q= filtra e pede outra chave.
  const qc = useQueryClient();
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!search) preCarregarAbertura(qc, pathname);
  }, []);

  if (isPending || !brandingLoaded) return <Carregando />;
  if (!session) return <Navigate to="/login" replace />;

  // O servidor decide se a passkey é obrigatória (demo/dev desligam), então a tela
  // e a API concordam sempre.
  if (passkeyRequired) {
    if (passkey.isPending) return <Carregando />;
    if (!passkey.data?.hasPasskey) {
      return <Navigate to="/setup-passkey" replace />;
    }
  }

  return <Outlet />;
}

/**
 * O service worker (public/sw.js) avisa a aba aberta quando alguém clica numa
 * notificação push; aqui a navegação termina do lado do app.
 */
function NotificationClickListener() {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    function onMessage(e: MessageEvent) {
      const data = e.data;
      if (
        data &&
        data.type === "saasmail.notificationclick" &&
        typeof data.url === "string"
      ) {
        navigate(data.url);
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [navigate]);
  return null;
}

function App() {
  return (
    <BrandingProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <NotificationClickListener />
          <Suspense fallback={<Carregando />}>
            <Routes>
              {/* Telas públicas: cartão no meio da tela, sem sessão. */}
              <Route element={<PublicLayout />}>
                <Route path="/login" element={<LoginPage />} />
                {/* Consentimento OAuth: fora do AuthGuard, o provedor manda para o
                  /login antes quando não há sessão e volta para cá. */}
                <Route path="/consent" element={<ConsentPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/invite/:token" element={<InviteAcceptPage />} />
                <Route path="/setup-passkey" element={<SetupPasskeyPage />} />
              </Route>

              <Route path="/terms" element={<TermsPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />

              {/* Descadastro por link do e-mail: autentica pelo token, quem chega aqui
                nunca está logado. API em worker/src/routers/unsubscribe-router.ts. */}
              <Route path="/unsubscribe" element={<UnsubscribePage />} />

              <Route element={<AuthGuard />}>
                <Route element={<AppShell />}>
                  {/* A raiz é a lista de todas as caixas; as 94 caixas ficam sempre à
                    vista na lateral, então a antiga tela de escolher caixa saiu. */}
                  <Route path="/" element={<InboxPage />} />
                  <Route path="/inbox/todas" element={<InboxPage />} />
                  <Route path="/inbox/:inbox" element={<InboxPage />} />
                  {/* Link das notificações push: worker/src/do/notifications.ts. */}
                  <Route
                    path="/inbox/:inbox/:personId"
                    element={<InboxPage />}
                  />
                  {/* /d/<domínio> era a escolha de caixa por domínio: hoje é a lateral. */}
                  <Route
                    path="/d/:dominio"
                    element={<Navigate to="/" replace />}
                  />
                  {/* Link para uma mensagem: acha pessoa e caixa e manda para a rota
                    acima com #m=<id>. */}
                  <Route path="/m/:emailId" element={<MessageLinkPage />} />
                  <Route path="/templates" element={<TemplatesPage />} />
                  <Route
                    path="/templates/new"
                    element={<TemplateEditorPage />}
                  />
                  <Route
                    path="/templates/:slug/edit"
                    element={<TemplateEditorPage />}
                  />
                  <Route path="/sequences" element={<SequencesPage />} />
                  <Route
                    path="/sequences/new"
                    element={<SequenceEditorPage />}
                  />
                  <Route
                    path="/sequences/:id/edit"
                    element={<SequenceEditorPage />}
                  />
                  <Route
                    path="/sequences/:id"
                    element={<SequenceDetailPage />}
                  />
                  <Route path="/api-keys" element={<ApiKeysPage />} />
                  <Route path="/inboxes" element={<InboxesPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/blocklist" element={<BlocklistPage />} />
                  <Route path="/outbox" element={<OutboxPage />} />
                  <Route path="/rascunhos" element={<RascunhosPage />} />
                  <Route path="/spam" element={<SpamPage />} />
                  <Route path="/admin/users" element={<AdminUsersPage />} />
                  <Route
                    path="/admin/suppressions"
                    element={<SuppressionsPage />}
                  />
                  <Route path="/*" element={<InboxPage />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </BrandingProvider>
  );
}

export default App;
