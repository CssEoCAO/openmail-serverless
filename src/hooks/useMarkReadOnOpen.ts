import { useEffect, useRef } from "react";
import type { Email } from "@/lib/api";

export function useMarkReadOnOpen(
  email: Email,
  onMarkRead: (email: Email) => void,
) {
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (
      email.type !== "received" ||
      email.isRead !== 0 ||
      attempted.current === email.id
    )
      return;
    // Uma tentativa por abertura; a recarga após falha não deve criar um loop.
    attempted.current = email.id;
    onMarkRead(email);
  }, [email, onMarkRead]);
}
