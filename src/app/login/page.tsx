// src/app/login/page.tsx
"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

// Prefer current browser origin in dev; fallback to env on Vercel
const ORIGIN =
    typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_SITE_URL ?? "");

export default function LoginPage() {
    const router = useRouter();
    const params = useSearchParams();

    // Mode purely controls headings/copy; both flows hit the same endpoint.
    const mode = (params.get("mode") === "login" ? "login" : "create") as "login" | "create";

    const supabase = useMemo(() => getSupabaseBrowser(), []);
    const [email, setEmail] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);
    const [msg, setMsg] = useState<string>("");

    // Normalize ?next= (path only; never an origin)
    const nextPath = useMemo<string>(() => {
        const n = params.get("next");
        return typeof n === "string" && n.startsWith("/") ? n : "/";
    }, [params]);

    // Absolute callback for Supabase
    const redirectToAbs = `${ORIGIN}/auth/callback?next=${encodeURIComponent(nextPath)}`;

    const signInWithEmail = useCallback(async () => {
        if (!email) {
            setMsg("Please enter an email address.");
            return;
        }
        setBusy(true);
        setMsg("");
        try {
            const { error } = await supabase.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: redirectToAbs },
            });
            if (error) {
                setMsg(`Sign-in failed: ${error.message}`);
            } else {
                setMsg("Check your inbox for the sign-in link.");
            }
        } catch {
            setMsg("Unexpected error starting email sign-in.");
        } finally {
            setBusy(false);
        }
    }, [email, supabase, redirectToAbs]);

    const signInWithGoogle = useCallback(async () => {
        setBusy(true);
        setMsg("");
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: redirectToAbs },
            });
            if (error) {
                setMsg(`Google sign-in failed: ${error.message}`);
                setBusy(false);
            }
        } catch {
            setMsg("Unexpected error starting Google sign-in.");
            setBusy(false);
        }
    }, [supabase, redirectToAbs]);

    const cancel = useCallback(() => {
        router.push(nextPath || "/");
    }, [router, nextPath]);

    // --- minimal inline styles (no Tailwind) ---
    const s = {
        page: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 } as const,
        card: {
            width: "100%",
            maxWidth: 420,
            borderRadius: 16,
            border: "1px solid rgba(160,160,160,0.25)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            padding: 20,
            background: "rgba(20,20,20,0.6)",
            backdropFilter: "blur(2px)",
        } as const,
        h1: { fontSize: 22, fontWeight: 700, margin: "4px 0 16px 0", textAlign: "center" } as const,
        label: { display: "block", fontSize: 14, marginBottom: 6, opacity: 0.9 } as const,
        input: {
            width: "100%", borderRadius: 10, border: "1px solid rgba(160,160,160,0.35)",
            padding: "10px 12px", marginBottom: 12, outline: "none", background: "transparent", color: "inherit",
        } as const,
        row: { display: "flex", gap: 10 } as const,
        btnPrimary: {
            flex: 1, borderRadius: 10, border: "1px solid rgba(160,160,160,0.35)",
            padding: "10px 12px", cursor: "pointer", background: "rgba(220,220,220,0.1)", color: "inherit",
        } as const,
    };

    return (
        <div style={s.page}>
            <div style={s.card}>
                <h1 style={s.h1}>{mode === "create" ? "Create your account" : "Sign in"}</h1>

                <label htmlFor="email" style={s.label}>Email for magic link</label>
                <input
                    id="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    style={s.input}
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); }}
                    disabled={busy}
                />

                <div style={s.row}>
                    <button type="button" style={s.btnPrimary} onClick={signInWithEmail} disabled={busy}>
                        Send magic link
                    </button>
                </div>

                {/* Optional OAuth. Keep if you want; remove if you want email-only. */}
                <div style={{ textAlign: "center", fontSize: 13, margin: "10px 0 6px", opacity: 0.75 }}>— or —</div>
                <div style={s.row}>
                    <button type="button" style={s.btnPrimary} onClick={signInWithGoogle} disabled={busy}>
                        Continue with Google
                    </button>
                </div>

                {msg ? <p style={{ fontSize: 13, marginTop: 12 }}>{msg}</p> : null}

                <div style={{ marginTop: 18, textAlign: "center" }}>
                    <button
                        type="button"
                        onClick={cancel}
                        disabled={busy}
                        style={{
                            fontSize: 13, textDecoration: "underline", background: "transparent",
                            border: "none", color: "inherit", cursor: "pointer"
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
