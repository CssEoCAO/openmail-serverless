import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox } from "lucide-react";
import { fetchStats, type Stats } from "@/lib/api";

export default function InboxSelectorPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!stats) return;
    // Auto-redirect when there's exactly one inbox — no picker needed.
    if (stats.inboxes.length === 1) {
      navigate(`/inbox/${encodeURIComponent(stats.inboxes[0].email)}`, {
        replace: true,
      });
    }
  }, [stats, navigate]);

  if (!stats) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-text-secondary">Loading…</p>
      </div>
    );
  }

  if (stats.inboxes.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 items-center justify-center px-4 py-16 md:px-6">
        <div className="rounded-2xl bg-card p-12 text-center ring-1 ring-border">
          <h2 className="text-lg font-semibold text-text-primary">
            No inboxes assigned yet
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Ask an admin to grant you access to an inbox.
          </p>
        </div>
      </div>
    );
  }

  // Single-inbox: already redirecting in the effect above.
  if (stats.inboxes.length === 1) return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4 py-10 md:px-6">
      <h1 className="mb-6 text-xl font-semibold text-text-primary">
        Choose an inbox
      </h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* All inboxes tile */}
        <button
          onClick={() => navigate("/inbox/todas")}
          className="flex items-center gap-4 rounded-[8px] bg-card p-6 text-left ring-1 ring-border transition-shadow hover:shadow-md hover:ring-border/80"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg-subtle">
            <Inbox size={20} className="text-text-secondary" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-text-primary">All inboxes</p>
            <p className="mt-0.5 truncate text-sm text-text-secondary">
              {stats.totalEmails} emails · {stats.unreadCount} unread
            </p>
          </div>
        </button>

        {/* Per-inbox tiles */}
        {stats.inboxes.map((inbox) => (
          <button
            key={inbox.email}
            onClick={() =>
              navigate(`/inbox/${encodeURIComponent(inbox.email)}`)
            }
            className="flex items-center gap-4 rounded-[8px] bg-card p-6 text-left ring-1 ring-border transition-shadow hover:shadow-md hover:ring-border/80"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg-subtle">
              <Inbox size={20} className="text-text-secondary" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-text-primary">
                {inbox.displayName ?? inbox.email}
              </p>
              <p className="mt-0.5 truncate text-sm text-text-secondary">
                {inbox.email}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
