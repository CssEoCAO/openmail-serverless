import { cn } from "@/lib/utils";

// Tons que funcionam nos dois temas: fundo translúcido e letra forte no claro,
// letra clara no escuro. A mesma pessoa cai sempre na mesma cor.
const CORES = [
  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  "bg-slate-500/15 text-slate-700 dark:text-slate-300",
];

function corDe(semente: string): string {
  let h = 0;
  for (let i = 0; i < semente.length; i++)
    h = (h * 31 + semente.charCodeAt(i)) >>> 0;
  return CORES[h % CORES.length];
}

export function iniciais(nome: string | null | undefined, email = ""): string {
  const fonte = nome?.trim() || email.split("@")[0] || "";
  const partes = fonte.split(/[\s.\-_]+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}

interface MonogramaProps {
  nome?: string | null;
  email: string;
  className?: string;
  title?: string;
}

/** Círculo com as iniciais da pessoa. Tamanho pelo `className` (padrão 32 px). */
export default function Monograma({
  nome,
  email,
  className,
  title,
}: MonogramaProps) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        corDe(email || nome || "?"),
        className,
      )}
    >
      {iniciais(nome, email)}
    </span>
  );
}
