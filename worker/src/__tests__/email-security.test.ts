import { describe, it, expect } from "vitest";
import { parseTrustedAuthResults } from "../lib/email-parser";

describe("trusted inbound authentication results", () => {
  it("accepts Cloudflare's aligned DMARC pass", () => {
    const result = parseTrustedAuthResults(
      [
        {
          key: "Authentication-Results",
          value:
            "mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
        },
      ],
      "sender@example.com",
    );
    expect(result.spf).toBe("pass");
    expect(result.dkim).toBe("pass");
    expect(result.dmarc).toBe("pass");
  });

  it("ignores a sender-supplied authserv-id", () => {
    const result = parseTrustedAuthResults(
      [
        {
          key: "Authentication-Results",
          value:
            "attacker.example; spf=pass; dkim=pass; dmarc=pass header.from=victim.example",
        },
      ],
      "victim@victim.example",
    );
    expect(result.spf).toBeNull();
    expect(result.dkim).toBeNull();
    expect(result.dmarc).toBeNull();
  });

  it("rejects an unaligned pass", () => {
    const result = parseTrustedAuthResults(
      [
        {
          key: "Authentication-Results",
          value:
            "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=attacker.example",
        },
      ],
      "victim@victim.example",
    );
    expect(result.dmarc).not.toBe("pass");
  });

  it("does not let a duplicate spoofed pass override Cloudflare's failure", () => {
    const result = parseTrustedAuthResults(
      [
        {
          key: "Authentication-Results",
          value: "mx.cloudflare.net; dmarc=pass header.from=victim.example",
        },
        {
          key: "Authentication-Results",
          value: "mx.cloudflare.net; dmarc=fail header.from=victim.example",
        },
      ],
      "victim@victim.example",
    );
    expect(result.dmarc).not.toBe("pass");
  });

  it("returns null when Cloudflare supplied no authentication result", () => {
    const result = parseTrustedAuthResults([], "sender@example.com");
    expect(result.spf).toBeNull();
    expect(result.dkim).toBeNull();
    expect(result.dmarc).toBeNull();
  });

  // Gmail's own header, as messages.get(format=raw) returns it (folded).
  const google = {
    key: "Authentication-Results",
    value:
      "mx.google.com;\r\n       dkim=pass header.i=@example.com header.s=s1;\r\n       spf=pass (google.com: domain of sender@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=sender@example.com;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com",
  };

  it("accepts Google's aligned DMARC pass for mail read from Gmail", () => {
    const result = parseTrustedAuthResults(
      [google],
      "sender@example.com",
      "mx.google.com",
    );
    expect(result.spf).toBe("pass");
    expect(result.dkim).toBe("pass");
    expect(result.dmarc).toBe("pass");
  });

  it("ignores a Google-shaped header on the Cloudflare path", () => {
    const result = parseTrustedAuthResults([google], "sender@example.com");
    expect(result.dmarc).toBeNull();
  });

  it("ignores a Cloudflare-shaped header on the Gmail path", () => {
    const result = parseTrustedAuthResults(
      [
        {
          key: "Authentication-Results",
          value: "mx.cloudflare.net; dmarc=pass header.from=example.com",
        },
      ],
      "sender@example.com",
      "mx.google.com",
    );
    expect(result.dmarc).toBeNull();
  });

  it("does not let a spoofed Google pass override Google's failure", () => {
    const result = parseTrustedAuthResults(
      [
        google,
        {
          key: "Authentication-Results",
          value: "mx.google.com; dmarc=fail (p=REJECT) header.from=example.com",
        },
      ],
      "sender@example.com",
      "mx.google.com",
    );
    expect(result.dmarc).not.toBe("pass");
  });
});

describe("sanitizeFilename", () => {
  function sanitizeFilename(filename: string): string {
    return (
      filename
        .replace(/\.\.[/\\]/g, "")
        .replace(/[/\\]/g, "_")
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 255) || "unnamed"
    );
  }

  it("passes through normal filenames", () => {
    expect(sanitizeFilename("document.pdf")).toBe("document.pdf");
    expect(sanitizeFilename("photo 2024.jpg")).toBe("photo 2024.jpg");
  });

  it("strips path traversal sequences", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32")).toBe(
      "windows_system32",
    );
  });

  it("replaces path separators with underscores", () => {
    expect(sanitizeFilename("path/to/file.txt")).toBe("path_to_file.txt");
    expect(sanitizeFilename("path\\to\\file.txt")).toBe("path_to_file.txt");
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("file\x00name\x0a.txt")).toBe("filename.txt");
  });

  it("truncates to 255 characters", () => {
    const longName = "a".repeat(300) + ".pdf";
    expect(sanitizeFilename(longName).length).toBe(255);
  });

  it("returns 'unnamed' for empty result", () => {
    expect(sanitizeFilename("")).toBe("unnamed");
    expect(sanitizeFilename("../")).toBe("unnamed");
  });
});
