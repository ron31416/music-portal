"use client";

import React from "react";
import Link from "next/link";

type WhoAmI = {
  ok: boolean;
  email: string | null;
  role: string | null;
  is_admin: boolean;
};

export default function AuthHeaderClient({
  title = "Music Portal",
}: {
  title?: string;
}) {
  const [hasUser, setHasUser] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);

  React.useEffect(() => {
    let active = true;

    (async () => {
      try {
        const res = await fetch("/api/whoami", { cache: "no-store" });
        if (!res.ok) {
          if (active) {
            setHasUser(false);
            setIsAdmin(false);
          }
          return;
        }

        const who = (await res.json()) as WhoAmI;
        if (!active) { return; }

        const signedIn = Boolean(who.email);
        setHasUser(signedIn);
        setIsAdmin(Boolean(who.is_admin));
      } catch {
        if (active) {
          setHasUser(false);
          setIsAdmin(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // Shared button style (outline, no fill) for visual parity
  const outlineBtn: React.CSSProperties = {
    display: "inline-block",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #666",
    background: "transparent",
    color: "inherit",
    textDecoration: "none",
    cursor: "pointer",
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "0 24px" }}>
        {/* Row 1: centered title alone */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            alignItems: "center",
          }}
        >
          <h1
            style={{
              justifySelf: "center",
              fontSize: 24,
              fontWeight: 700,
              textAlign: "center",
              margin: 0,
            }}
          >
            {title}
          </h1>
        </div>

        {/* Row 2: left & right actions on one line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 10,
          }}
        >
          {/* Left slot: Admin only */}
          <div style={{ minHeight: 1 }}>
            {isAdmin ? (
              <Link
                href="/admin"
                target="_blank"
                rel="noopener noreferrer"
                style={outlineBtn}
              >
                Admin
              </Link>
            ) : null}
          </div>

          {/* Right slot: Sign in (signed-out only) */}
          <div>
            {!hasUser ? (
              <Link
                href="/login"
                target="_blank"
                rel="noopener noreferrer"
                style={outlineBtn}
              >
                Sign in
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
