import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Cabeçalho das páginas de ferramentas e administração: título, explicação e ação. */
export default function PageHeader({
  title,
  subtitle,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
        {subtitle && (
          <p className="mt-1 max-w-2xl text-sm text-text-tertiary">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Página fora da caixa: rola dentro do casco (a lateral fica parada) e limita a
 * largura de leitura.
 */
export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto w-full max-w-[1200px] px-4 pb-12 pt-6 md:px-8",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
