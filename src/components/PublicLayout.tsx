import { Outlet } from "react-router-dom";

/**
 * Casca das telas sem sessão (login, primeiro acesso, convite, passkey,
 * consentimento): fundo liso da família e o cartão no meio. Sem shader nem
 * animação de fundo, que custavam GPU e um pedaço de 250 KB a mais.
 */
export default function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Outlet />
      </main>
    </div>
  );
}
