import { Paperclip, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GroupedConversation } from "@/lib/api";

// Solid palette for stacked group avatars — opaque equivalents of
// PersonList's soft transparent palette (the rgba(_, 0.12-0.16) values
// composited over a white card). Visually identical to the regular
// person avatars when viewed solo; doesn't bleed into neighbors when
// stacked because there's no transparency. Foreground colors mirror
// PersonList's `fg` so the same person hashes to the same hue.
const AVATAR_PALETTE = [
  { bg: "#efebff", fg: "#5b3ce6" }, // violet
  { bg: "#e4f8ec", fg: "#15803d" }, // green
  { bg: "#fdebf5", fg: "#be185d" }, // pink
  { bg: "#fef0e4", fg: "#c2410c" }, // orange
  { bg: "#e3f6fe", fg: "#0369a1" }, // blue
  { bg: "#f3e7fe", fg: "#7e22ce" }, // purple
  { bg: "#def5f3", fg: "#0f766e" }, // teal
  { bg: "#fcf3d7", fg: "#a16207" }, // amber
];

function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function initials(name: string | null, email: string) {
  const source = name || email.split("@")[0];
  const parts = source.split(/[\s.\-_]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "?";
}

function formatTime(ts: number) {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) {
    const m = Math.max(1, Math.floor(diffMs / 60_000));
    return `${m}m`;
  }
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (diffH < 24 * 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function groupLabel(participants: GroupedConversation["participants"]): string {
  if (participants.length === 0) return "Group conversation";
  const names = participants.map((p) => {
    if (p.name && p.name.trim()) return p.name.trim().split(/\s+/)[0];
    return p.email.split("@")[0];
  });
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

interface GroupRowProps {
  group: GroupedConversation;
  isSelected: boolean;
  onSelect: () => void;
  onMarkRead?: (id: string) => void;
}

/**
 * Inbox sidebar row for a multi-participant thread. Renders overlapping
 * avatar circles for the external participants, a comma-separated name
 * list, and the same meta line as PersonList rows (count + time + unread
 * badge). Internal CCs aren't surfaced here — they're scoped to the
 * thread but don't define its identity.
 */
export default function GroupRow({
  group,
  isSelected,
  onSelect,
  onMarkRead,
  /**
   * Compact mode — when the sidebar is dragged narrow, just the avatar
   * stack + unread badge. Hides the name list and meta.
   */
  compact = false,
}: GroupRowProps & { compact?: boolean }) {
  const display = groupLabel(group.participants);
  // Show up to 3 avatars in a horizontal stack (each shifted left of the
  // next), with a "+N" pill if the group is bigger. Each circle has a
  // ring matching the row's hover state so the stack reads as one shape.
  const MAX_AVATARS = 3;
  const visible = group.participants.slice(0, MAX_AVATARS);
  const overflow = Math.max(0, group.participants.length - visible.length);
  const AVATAR_SIZE = 28; // h-7 / w-7
  const OVERLAP = 10; // each subsequent avatar starts 10px left → 18px showing
  // Total width of the stack: first avatar full + (n-1) showing OVERLAP each.
  const stackWidth =
    AVATAR_SIZE +
    Math.max(0, visible.length + (overflow > 0 ? 1 : 0) - 1) *
      (AVATAR_SIZE - OVERLAP);

  return (
    <li
      className={cn(
        "group relative transition-colors",
        isSelected ? "bg-text-primary/[0.04]" : "hover:bg-text-primary/[0.025]",
      )}
    >
      {isSelected && (
        <span
          className="absolute inset-y-2 left-0 w-0.5 rounded-full"
          style={{ backgroundColor: "#7c5cfc" }}
          aria-hidden
        />
      )}

      <button
        data-testid="group-row"
        data-conversation-id={group.id}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-text-primary/[0.04] sm:py-2",
          compact && "justify-center px-2",
        )}
      >
        {/* Horizontally stacked avatars — clean single-row group chip. */}
        <span
          className="relative shrink-0 self-center"
          style={{ width: stackWidth, height: AVATAR_SIZE }}
        >
          {visible.map((p, i) => {
            const color = avatarColor(p.email);
            return (
              <span
                key={p.id}
                title={p.name || p.email}
                className="absolute flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold tracking-tight"
                style={{
                  backgroundColor: color.bg,
                  color: color.fg,
                  left: i * (AVATAR_SIZE - OVERLAP),
                  top: 0,
                  zIndex: 10 - i,
                }}
              >
                {initials(p.name, p.email)}
              </span>
            );
          })}
          {overflow > 0 && (
            <span
              className="absolute flex h-7 w-7 items-center justify-center rounded-full bg-bg-muted text-[10px] font-semibold text-text-secondary"
              style={{
                left: visible.length * (AVATAR_SIZE - OVERLAP),
                top: 0,
                zIndex: 10 - visible.length,
              }}
              title={`+${overflow} more participants`}
            >
              +{overflow}
            </span>
          )}
        </span>

        {!compact && (
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 truncate text-sm",
                  group.unreadCount > 0
                    ? "font-semibold text-text-primary"
                    : "font-medium text-text-primary",
                )}
              >
                <Users size={11} className="shrink-0 text-text-tertiary" />
                <span className="truncate">{display}</span>
              </span>
              <span className="shrink-0 text-[11px] font-light text-text-tertiary">
                {formatTime(group.lastEmailAt)}
              </span>
            </div>

            <p
              className="mt-0.5 truncate text-xs text-text-secondary"
              title={group.latestSubject?.trim() || "(sem assunto)"}
            >
              {group.latestSubject?.trim() || "(sem assunto)"}
            </p>

            <div className="mt-0.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <span className="truncate">{group.inbox.split("@")[0]}</span>
                <span className="text-text-tertiary/40">·</span>
                <span>
                  {group.totalCount} message{group.totalCount !== 1 ? "s" : ""}
                </span>
                {group.hasAttachment === 1 && (
                  <Paperclip
                    size={10}
                    className="text-text-tertiary"
                    aria-label="Has attachment"
                  />
                )}
              </div>

              {group.unreadCount > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Tap to mark all as read"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkRead?.(group.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onMarkRead?.(group.id);
                    }
                  }}
                  className="flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white"
                  style={{ backgroundColor: "#7c5cfc" }}
                >
                  {group.unreadCount}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Compact mode: just the unread badge, anchored to the avatar stack. */}
        {compact && group.unreadCount > 0 && (
          <span
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
            style={{ backgroundColor: "#7c5cfc" }}
          >
            {group.unreadCount}
          </span>
        )}
      </button>
    </li>
  );
}
