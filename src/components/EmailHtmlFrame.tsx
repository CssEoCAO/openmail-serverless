import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { buildEmailFrameDoc } from "@/lib/email-frame";
import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

import { tx } from "@/lib/i18n";
interface EmailHtmlFrameProps {
  html: string;
  /** Used to resolve `cid:` inline images. */
  attachments?: Attachment[];
  /** When set, taller content is clipped to this height with a "Show full email" toggle. */
  collapsedHeight?: number;
  className?: string;
}

// Same-origin (so /api/attachments/*/inline gets the session cookie) but no
// scripts, so the email cannot reach the app's DOM. Popups escape the sandbox
// so links open normally; every link carries rel=noopener (see email-frame.ts).
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const OVERFLOW_SLACK = 48;

/** Renders an email's original HTML (styles, tables, images) in a sandboxed iframe sized to its content. */
export default function EmailHtmlFrame({
  html,
  attachments,
  collapsedHeight,
  className,
}: EmailHtmlFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [imagesFor, setImagesFor] = useState<string | null>(null);
  const doc = useMemo(
    () => buildEmailFrameDoc(html, attachments, imagesFor === html),
    [html, attachments, imagesFor],
  );

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    function measure() {
      const d = frame?.contentDocument;
      if (!d?.documentElement) return;
      setHeight(
        Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0),
      );
    }
    function onLoad() {
      measure();
      const d = frame?.contentDocument;
      // Clicks inside the frame never reach the page; re-dispatch them so the
      // message around it still reacts (e.g. marking it read).
      d?.addEventListener("click", () =>
        frame?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      observer?.disconnect();
      if (d?.body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(d.documentElement);
        observer.observe(d.body);
      }
    }
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  const overflows =
    collapsedHeight != null && height > collapsedHeight + OVERFLOW_SLACK;
  const clipped = overflows && !expanded;
  const shown = clipped ? collapsedHeight : height;

  return (
    // O e-mail foi feito para papel branco: a moldura inteira fica branca nos dois
    // temas, e os links dela usam o azul escuro (o azul claro do tema escuro some no branco).
    <div className={cn("bg-white", className)}>
      {imagesFor !== html && (
        <button
          type="button"
          className="px-3 py-1.5 text-xs font-medium text-[#1c4fc4] hover:underline"
          onClick={() => setImagesFor(html)}
        >
          {tx("Carregar imagens externas")}
        </button>
      )}
      <div className="relative">
        <iframe
          ref={ref}
          title={tx("Mensagem")}
          sandbox={SANDBOX}
          srcDoc={doc}
          scrolling="no"
          className="block w-full border-0 bg-white"
          style={{ height: shown || 48, minHeight: 48 }}
        />
        {clipped && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className={cn(
            "inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#1c4fc4] hover:underline",
          )}
        >
          {expanded ? (
            <>
              {tx("Mostrar menos")} <ChevronUp size={11} />
            </>
          ) : (
            <>
              {tx("Mostrar a mensagem inteira")} <ChevronDown size={11} />
            </>
          )}
        </button>
      )}
    </div>
  );
}
