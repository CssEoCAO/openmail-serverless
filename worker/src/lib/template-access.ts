import { isInboxAllowed, type AllowedInboxes } from "./inbox-permissions";

/** Global templates are readable by everyone; inbox templates follow grants. */
export function canReadTemplate(
  allowed: AllowedInboxes,
  fromAddress: string | null,
): boolean {
  return (
    allowed.isAdmin ||
    fromAddress === null ||
    isInboxAllowed(allowed, fromAddress)
  );
}

/** Members may mutate only templates owned by one of their inboxes. */
export function canModifyTemplate(
  allowed: AllowedInboxes,
  fromAddress: string | null,
): boolean {
  return (
    allowed.isAdmin ||
    (fromAddress !== null && isInboxAllowed(allowed, fromAddress))
  );
}

/**
 * A scoped template may only be sent by its owning inbox. Global templates
 * are intentionally reusable by every authorized sender.
 */
export function templateCanSendFrom(
  templateFromAddress: string | null,
  senderFromAddress: string,
): boolean {
  return (
    templateFromAddress === null ||
    templateFromAddress.trim().toLowerCase() ===
      senderFromAddress.trim().toLowerCase()
  );
}
