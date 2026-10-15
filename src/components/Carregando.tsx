/** Tela de espera de página inteira (sessão, configuração, pedaço do app baixando). */
import { tx } from "@/lib/i18n";
export default function Carregando() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <p className="text-sm text-text-tertiary">{tx("Carregando…")}</p>
    </div>
  );
}
