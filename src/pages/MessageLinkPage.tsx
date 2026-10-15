import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fetchEmail } from "@/lib/api";

import { tx } from "@/lib/i18n";
/**
 * Resolves a shareable `/m/<emailId>` link to the in-app location of the
 * message. Looks up the email's person + owning inbox, then redirects to
 * the existing person route with a `#m=<emailId>` hash for PersonDetail
 * to scroll/flash. `replace` keeps the resolver URL out of history so the
 * back button doesn't bounce.
 */
export default function MessageLinkPage() {
  const { emailId } = useParams<{ emailId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!emailId) {
      setError(tx("Link sem o identificador da mensagem."));
      return;
    }
    let cancelled = false;
    fetchEmail(emailId)
      .then((email) => {
        if (cancelled) return;
        // For received emails the owning inbox is `recipient`; for sent
        // emails the API returns recipient: null and the inbox is the
        // outbound identity in `fromAddress`. Mirror inboxOf() in PersonDetail.
        const inbox =
          email.type === "received" ? email.recipient : email.fromAddress;
        const personId = email.personId;
        if (!personId || !inbox) {
          setError(tx("Esta mensagem não abre na caixa."));
          return;
        }
        navigate(
          `/inbox/${encodeURIComponent(inbox)}/${encodeURIComponent(personId)}#m=${encodeURIComponent(emailId)}`,
          { replace: true },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setError(tx("Mensagem não encontrada, ou você não tem acesso a ela."));
      });
    return () => {
      cancelled = true;
    };
  }, [emailId, navigate]);

  if (error) {
    return (
      <div className="flex h-full flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-sm rounded-[12px] bg-card p-8 text-center ring-1 ring-border">
          <h2 className="text-base font-semibold text-text-primary">
            {tx("Não deu para abrir a mensagem")}
          </h2>
          <p className="mt-2 text-sm text-text-secondary">{error}</p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm font-medium text-primary-ink hover:underline"
          >
            {tx("Voltar à caixa")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 items-center justify-center text-sm text-text-tertiary">
      {tx("Abrindo a mensagem…")}
    </div>
  );
}
