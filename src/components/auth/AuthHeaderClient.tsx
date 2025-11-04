// src/components/auth/AuthHeaderClient.tsx
"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function AuthHeaderClient({
    title = "Music Portal",
    next = "/",
}: {
    title?: string;
    next?: string;
}) {
    const router = useRouter();
    const supabase = React.useMemo(() => getSupabaseBrowser(), []);
    const [hasUser, setHasUser] = React.useState(false);
    const [isAdmin, setIsAdmin] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        (async () => {
            const [{ data }, who] = await Promise.all([
                supabase.auth.getUser(),
                fetch("/api/whoami", { cache: "no-store" })
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null),
            ]);
            if (!active) { return; }
            setHasUser(Boolean(data.user));
            const adminFlag =
                (who && (who.is_admin === true || who.role === "admin")) || false;
            setIsAdmin(Boolean(adminFlag));
        })();
        return () => {
            active = false;
        };
    }, [supabase]);

    const onLogout = async () => {
        await supabase.auth.signOut();
        router.refresh();
    };

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
                    {/* Left slot: Create account (signed-out) OR Admin (signed-in admin) */}
                    <div style={{ minHeight: 1 }}>
                        {!hasUser ? (
                            <Link
                                href={`/login?mode=create&next=${encodeURIComponent(next)}`}
                                style={outlineBtn}
                            >
                                New user
                            </Link>
                        ) : isAdmin ? (
                            <Link href="/admin" style={outlineBtn}>
                                Admin
                            </Link>
                        ) : null}
                    </div>

                    {/* Right slot: Log in (signed-out) OR Log out (signed-in) */}
                    <div>
                        {!hasUser ? (
                            <Link
                                href={`/login?mode=login&next=${encodeURIComponent(next)}`}
                                style={outlineBtn}
                            >
                                Log in
                            </Link>
                        ) : (
                            <button type="button" onClick={onLogout} style={outlineBtn}>
                                Log out
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
