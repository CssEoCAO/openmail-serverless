import { MarcaPublica } from "@/components/Publico";

import { tx } from "@/lib/i18n";
interface LegalLayoutProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}

/** Páginas de termos e privacidade: coluna de leitura no fundo liso, sem login. */
export default function LegalLayout({
  title,
  lastUpdated,
  children,
}: LegalLayoutProps) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-6 md:px-6">
        <MarcaPublica />
        <a
          href="/login"
          className="text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          {tx("Entrar")}
        </a>
      </header>
      <article className="mx-auto max-w-3xl px-4 pb-16 md:px-6">
        <header className="mb-8 border-b border-border pb-6">
          <h1 className="text-3xl font-semibold text-text-primary">{title}</h1>
          <p className="mt-2 text-sm text-text-tertiary">
            {tx("Atualizado em")} {lastUpdated}
          </p>
        </header>
        <div className="max-w-none [&_a]:font-medium [&_a]:text-primary-ink [&_a:hover]:underline [&_code]:rounded [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:text-[0.85em] [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-text-primary [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-text-primary [&_li]:my-1 [&_li]:text-[15px] [&_li]:leading-relaxed [&_li]:text-text-secondary [&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-relaxed [&_p]:text-text-secondary [&_strong]:font-semibold [&_strong]:text-text-primary [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
          {children}
        </div>
      </article>
    </div>
  );
}
