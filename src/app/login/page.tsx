"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function LoginPage() {
    const router = useRouter();
    const params = useSearchParams();

    const supabase = useMemo(() => getSupabaseBrowser(), []);
    const [email, setEmail] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);
    const [msg, setMsg] = useState<string>("");

    // where to take users after successful auth
    const redirectTo = useMemo<string>(() => {
        const next = params.get("next");
        if (typeof next === "string" && next.startsWith("/")) {
            return next;
        }
        return "/"; // default home
    }, [params]);

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
                options: {
                    emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
                },
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
    }, [email, supabase, redirectTo]);

    const signInWithGoogle = useCallback(async () => {
        setBusy(true);
        setMsg("");
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
                },
            });
            if (error) {
                setMsg(`Google sign-in failed: ${error.message}`);
                setBusy(false);
            } else {
                // On success, Supabase will redirect; nothing else to do here.
            }
        } catch {
            setMsg("Unexpected error starting Google sign-in.");
            setBusy(false);
        }
    }, [supabase, redirectTo]);

    const goHome = useCallback(() => {
        router.push("/");
    }, [router]);

    return (
        <div className="min-h-screen flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl shadow-lg p-6 border">
                <h1 className="text-xl font-semibold mb-4">Sign in</h1>

                <label htmlFor="email" className="block text-sm mb-1">
                    Email for magic link
                </label>
                <input
                    id="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    className="w-full border rounded-lg px-3 py-2 mb-3"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); }}
                    disabled={busy}
                />

                <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 border mb-3"
                    onClick={signInWithEmail}
                    disabled={busy}
                >
                    Send magic link
                </button>

                <div className="text-center text-sm my-2">— or —</div>

                <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 border"
                    onClick={signInWithGoogle}
                    disabled={busy}
                >
                    Continue with Google
                </button>

                {msg ? (
                    <p className="text-sm mt-3">{msg}</p>
                ) : null}

                <button
                    type="button"
                    className="mt-6 text-sm underline"
                    onClick={goHome}
                    disabled={busy}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
