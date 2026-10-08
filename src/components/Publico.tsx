import { Mail } from "lucide-react";
import { useBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";

// Peças das telas sem sessão (login, primeiro acesso, convite, passkey, consentimento).

export const campoPublico =
  "h-10 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none";

export const rotuloPublico = "block text-xs font-medium text-text-secondary";

export const botaoPrimario =
  "inline-flex h-10 w-full items-center justify-center gap-2 rounded-[6px] bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";

export const botaoSecundario =
  "inline-flex h-10 w-full items-center justify-center gap-2 rounded-[6px] border border-border bg-card px-4 text-sm font-medium text-text-primary transition-colors hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60";

export function MarcaPublica() {
  const { brandName } = useBranding();
  return (
    <div className="flex items-center justify-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-primary text-primary-foreground">
        <Mail size={17} strokeWidth={2.25} aria-hidden />
      </span>
      <span className="text-lg font-semibold text-text-primary">
        {brandName}
      </span>
    </div>
  );
}

export function CartaoPublico({
  titulo,
  subtitulo,
  children,
  className,
}: {
  titulo?: string;
  subtitulo?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full max-w-sm flex-col gap-6", className)}>
      <MarcaPublica />
      <div className="rounded-[12px] border border-border bg-card p-6 shadow-sm sm:p-7">
        {titulo && (
          <div className="mb-5">
            <h1 className="text-lg font-semibold text-text-primary">
              {titulo}
            </h1>
            {subtitulo && (
              <p className="mt-1 text-sm text-text-tertiary">{subtitulo}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function ErroPublico({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mb-4 rounded-[6px] bg-destructive-subtle px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}
