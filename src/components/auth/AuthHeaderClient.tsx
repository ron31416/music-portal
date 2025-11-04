// src/components/auth/AuthHeaderClient.tsx
"use client";

import React from "react";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function AuthHeaderClient({
    title = "Music Portal",
}: {
    title?: string;
}) {
    const supabase = React.useMemo(() => getSupabaseBrowser(), []);
    const [hasUser, setHasUser] = React.useState(false);
    const [isAdmin, setIsAdmin] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        (async () => {
            const [authRes, who] = await Promise.all([
                supabase.auth.getUser(),
                fetch("/api/whoami", { cache: "no-store" })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
            ]);
            if (!active) { return; }

            const userFromSupabase = Boolean(authRes?.data?.user);
            const emailFromWho = (who && who.email) || null;

            // consider "signed in" if either Supabase has a session OR /api/whoami returned an email
            const effectiveHasUser = userFromSupabase || Boolean(emailFromWho);
            setHasUser(effectiveHasUser);

            const adminFlag =
                (who && (who.is_admin === true || who.role === "admin")) || false;
            setIsAdmin(Boolean(adminFlag));
        })();
        return () => {
            active = false;
        };
    }, [supabase]);

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

                    {/* Right slot: Log in (signed-out) OR Log out (signed-in) */}
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
