import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

type Kind =
  | "image"
  | "pdf"
  | "sheet"
  | "doc"
  | "archive"
  | "audio"
  | "video"
  | "other";

const ICON = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  doc: FileText,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  other: File,
} as const;

// Kinds the browser renders itself: open the inline URL in a new tab
// instead of forcing a download.
const PREVIEWABLE = new Set<Kind>(["image", "pdf", "video", "audio"]);

function kindOf(att: Attachment): Kind {
  const ct = att.contentType.toLowerCase();
  const ext = att.filename.split(".").pop()?.toLowerCase() ?? "";
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (/sheet|excel|csv/.test(ct) || /^(xlsx?|csv|ods)$/.test(ext))
    return "sheet";
  if (
    /zip|rar|7z|tar|gzip|compressed/.test(ct) ||
    /^(zip|rar|7z|gz)$/.test(ext)
  )
    return "archive";
  if (/word|document|text\//.test(ct) || /^(docx?|odt|txt|rtf)$/.test(ext))
    return "doc";
  return "other";
}

interface AttachmentListProps {
  attachments: Attachment[];
  /** `chips` — one-line pills for message bubbles; `list` — cards with a larger preview. */
  variant?: "chips" | "list";
  className?: string;
}

/** Downloadable (non-inline) attachments with a type icon, size, image thumbnail and download link. */
export default function AttachmentList({
  attachments,
  variant = "chips",
  className,
}: AttachmentListProps) {
  const files = attachments.filter((a) => !a.contentId);
  if (files.length === 0) return null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (variant === "chips") {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {files.map((att) => {
          const kind = kindOf(att);
          const Icon = ICON[kind];
          const inline = `/api/attachments/${att.id}/inline`;
          const preview = PREVIEWABLE.has(kind);
          return (
            <a
              key={att.id}
              href={preview ? inline : `/api/attachments/${att.id}`}
              target={preview ? "_blank" : undefined}
              rel="noreferrer"
              onClick={stop}
              title={`${att.filename} · ${formatBytes(att.size)}`}
              className="flex max-w-[260px] items-center gap-1.5 rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-muted"
            >
              {kind === "image" ? (
                <img
                  src={inline}
                  alt=""
                  loading="lazy"
                  className="h-8 w-8 shrink-0 rounded object-cover"
                />
              ) : (
                <Icon size={13} className="shrink-0 text-text-tertiary" />
              )}
              <span className="truncate">{att.filename}</span>
              <span className="shrink-0 text-text-tertiary">
                {formatBytes(att.size)}
              </span>
            </a>
          );
        })}
      </div>
    );
  }

  return (
    <ul className={cn("grid gap-2 sm:grid-cols-2", className)}>
      {files.map((att) => {
        const kind = kindOf(att);
        const Icon = ICON[kind];
        const inline = `/api/attachments/${att.id}/inline`;
        const download = `/api/attachments/${att.id}`;
        const preview = PREVIEWABLE.has(kind);
        const ext = att.filename.includes(".")
          ? att.filename.split(".").pop()!.toUpperCase()
          : att.contentType;
        return (
          <li
            key={att.id}
            className="flex items-center gap-2 rounded-[8px] border border-border bg-card p-2 text-xs"
          >
            <a
              href={preview ? inline : download}
              target={preview ? "_blank" : undefined}
              rel="noreferrer"
              title={preview ? tx("Abrir") : tx("Baixar")}
              className="flex min-w-0 flex-1 items-center gap-2.5"
            >
              {kind === "image" ? (
                <img
                  src={inline}
                  alt=""
                  loading="lazy"
                  className="h-12 w-12 shrink-0 rounded-[6px] object-cover ring-1 ring-border"
                />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted text-text-tertiary">
                  <Icon size={20} />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium text-text-primary">
                  {att.filename}
                </span>
                <span className="block text-text-tertiary">
                  {formatBytes(att.size)} · {ext}
                </span>
              </span>
            </a>
            <a
              href={download}
              download={att.filename}
              title={tx("Baixar")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              <Download size={14} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
