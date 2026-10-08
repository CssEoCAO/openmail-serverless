import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared layout primitives for "settings-style" admin pages —
 * TemplateEditor, SequenceEditor, SequenceDetail, etc. Keeps the
 * label/input/hint shape and code-block presentation identical
 * everywhere so fields read the same wherever they're used.
 */

export const FORM_INPUT_CLASS =
  "h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:cursor-not-allowed";

interface SectionHeaderProps {
  icon?: React.ElementType;
  title: string;
  subtitle?: React.ReactNode;
  /** Optional element to render flush to the right of the title row. */
  action?: React.ReactNode;
}

export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: SectionHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {Icon && (
          <Icon size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-text-tertiary">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs text-text-tertiary">{hint}</span>
      )}
    </label>
  );
}

/** Pill-style label used at the top of code/preview panes. */
export function PaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-b border-border bg-bg-subtle/40 px-3 py-1.5">
      <span className="text-[11px] font-medium text-text-tertiary">
        {children}
      </span>
    </div>
  );
}

/** Read-only code block with a copy button in the corner. */
export function CodeBlock({
  value,
  oneLine,
}: {
  value: string;
  oneLine?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="relative">
      <pre
        className={cn(
          "overflow-x-auto rounded-[6px] border border-border bg-bg-subtle/60 p-3 text-[11px] leading-relaxed text-text-secondary",
          oneLine ? "whitespace-nowrap" : "whitespace-pre",
        )}
      >
        <code className="font-mono">{value}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copiar"
        className="absolute right-2 top-2 inline-flex h-6 items-center gap-1 rounded-[4px] border border-border bg-card px-1.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
      >
        {copied ? <Check size={10} /> : <Copy size={10} />}
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}
