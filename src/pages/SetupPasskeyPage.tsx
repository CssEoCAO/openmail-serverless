import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import {
  CartaoPublico,
  ErroPublico,
  botaoPrimario,
} from "@/components/Publico";

import { tx } from "@/lib/i18n";
export default function SetupPasskeyPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    setLoading(true);
    setError("");
    try {
      const result = await authClient.passkey.addPasskey();
      if (result?.error) {
        setError(
          result.error.message || tx("Não deu para cadastrar a passkey."),
        );
      } else {
        window.location.href = "/";
      }
    } catch {
      setError(tx("Não deu para cadastrar a passkey. Tente de novo."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <CartaoPublico
      titulo={tx("Cadastre uma passkey")}
      subtitulo={tx(
        "Por segurança, a caixa só abre depois de cadastrar uma passkey neste aparelho (digital, rosto ou chave de segurança).",
      )}
    >
      {error && <ErroPublico>{error}</ErroPublico>}
      <button
        className={botaoPrimario}
        onClick={handleRegister}
        disabled={loading}
      >
        <Fingerprint size={16} />
        {loading ? tx("Cadastrando…") : tx("Cadastrar passkey")}
      </button>
    </CartaoPublico>
  );
}
