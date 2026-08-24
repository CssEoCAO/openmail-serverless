import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Inbox, Layers, Send, AlertCircle } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { fetchStats, type Stats } from "@/lib/api";

/**
 * Landing page: pick an inbox.
 *
 * Replaces "open every inbox at once with a filter dropdown". On an account that takes
 * catch-all mail across dozens of domains, the combined view is the rare case, not the
 * default — and the dropdown hid the inboxes behind a click nobody made.
 *
 * "See them all together" sits at the END of the list on purpose: still one click, but no
 * longer the place you land without choosing.
 */

type InboxRow = Stats["inboxes"][number];

/** Same label rule as the old filter dropdown, so an inbox doesn't change name between
 *  screens. */
function label(row: InboxRow): string {
  return row.displayName || row.email.split("@")[0] || row.email;
}

function lastSeen(epochSeconds: number | null): string {
  if (!epochSeconds) return "nothing yet";
  const days = Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

export default function InboxSelectorPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    fetchStats()
      .then(setStats)
      // Swallowing this would leave the page on "Loading…" forever, which reads as a
      // hung app rather than a failed request.
      .catch(() => setError("Could not load your inboxes"));
  }, []);

  const inboxes = stats?.inboxes ?? [];

  // `/?q=` and `/?search=` are ALREADY-PUBLISHED deep links (external admin links — see
  // the commit that added them). The root stopped being the list, so they would land on
  // a screen that ignores the query. Forwarding preserves links that exist out there;
  // changing the documented URL would break whoever saved one.
  const deepLinkSearch = searchParams.get("q") ?? searchParams.get("search");

  // One inbox means there is nothing to choose: skip straight to it. Costs a redirect,
  // saves a pointless click on every single visit.
  //
  // The dependency is the ADDRESS, not the array: `stats?.inboxes ?? []` is a fresh
  // reference on every render, so depending on it would re-run this effect forever and
  // fire navigate() in a loop. And it stands down for a deep link, otherwise the two
  // redirects would race and the ?q= would lose.
  const unicaCaixa = inboxes.length === 1 ? inboxes[0].email : null;
  useEffect(() => {
    if (unicaCaixa && deepLinkSearch === null) {
      navigate(`/inbox/${encodeURIComponent(unicaCaixa)}`, { replace: true });
    }
  }, [unicaCaixa, deepLinkSearch, navigate]);

  if (deepLinkSearch !== null) {
    return <Navigate to={`/inbox/todas?${searchParams.toString()}`} replace />;
  }

  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Inboxes" />
        <p className="text-sm text-text-secondary">{error}</p>
      </PageContainer>
    );
  }

  if (stats && inboxes.length === 0) {
    return (
      <PageContainer>
        <PageHeader title="Inboxes" />
        <div className="rounded-[8px] bg-card px-5 py-8 text-center ring-1 ring-border">
          <p className="text-sm font-medium text-text-primary">
            No inboxes yet
          </p>
          <p className="mt-1 text-xs font-light text-text-tertiary">
            An inbox shows up here on the first message it receives, or when an
            admin adds it under Inboxes.
          </p>
        </div>
      </PageContainer>
    );
  }

  // Redirecting in the effect above.
  if (inboxes.length === 1) return null;

  // Unread first, then most recently active. Alphabetical would bury the inbox with 40
  // unread under an empty one that happens to start with "a".
  const ordered = [...inboxes].sort(
    (a, b) => b.naoLidas - a.naoLidas || (b.ultima ?? 0) - (a.ultima ?? 0),
  );
  const totalUnread = inboxes.reduce((sum, i) => sum + i.naoLidas, 0);

  return (
    <PageContainer>
      <PageHeader
        title="Inboxes"
        subtitle={
          stats
            ? `${inboxes.length} inbox${inboxes.length === 1 ? "" : "es"}${
                totalUnread > 0 ? ` · ${totalUnread} unread` : ""
              }`
            : undefined
        }
      />

      <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
        <ul className="divide-y divide-border/60" data-testid="inbox-list">
          {ordered.map((row) => (
            <li
              key={row.email}
              data-testid="inbox-row"
              data-inbox={row.email}
              className="group transition-colors hover:bg-text-primary/[0.02]"
            >
              <Link
                to={`/inbox/${encodeURIComponent(row.email)}`}
                className="flex items-center gap-3 px-5 py-3.5 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                  <Inbox size={14} className="text-text-tertiary" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {label(row)}
                    </p>
                    {row.naoLidas > 0 && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-text-primary px-2 py-0.5 text-[10px] font-medium tabular-nums text-white">
                        {row.naoLidas}
                      </span>
                    )}
                    {/* Receive-only: saying it here beats letting someone open the
                        inbox, write the whole reply, and only then find out this
                        address has no sending identity. */}
                    {!row.podeEnviar && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-[10px] font-light text-text-tertiary"
                        title="This address receives mail but is not configured to send"
                      >
                        <AlertCircle size={9} />
                        receive-only
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs font-light text-text-tertiary">
                    {row.email} · {row.total} message
                    {row.total === 1 ? "" : "s"} · {lastSeen(row.ultima)}
                  </p>
                </div>
                {row.podeEnviar && (
                  <Send
                    size={12}
                    className="shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-60"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <Link
        to="/inbox/todas"
        data-testid="see-all-inboxes"
        className="mt-3 flex items-center justify-center gap-2 rounded-[8px] border border-border bg-card px-5 py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
      >
        <Layers size={14} />
        See them all together
      </Link>
    </PageContainer>
  );
}
