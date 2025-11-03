// src/components/navaccount.tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type AuthState = { email: string | null; admin: boolean };

export default function NavAccount() {
    const [auth, setAuth] = useState<AuthState>({ email: null, admin: false });

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch("/api/auth-state", { cache: "no-store" });
                if (!res.ok) { return; }
                const json = (await res.json()) as AuthState;
                if (alive) { setAuth(json); }
            } catch {
                // ignore
            }
        };
        load();
        return () => { alive = false; };
    }, []);

    const onLogout = async () => {
        // hit Supabase sign out, then hard refresh
        await fetch("/auth/signout", { method: "POST" }).catch(() => { });
        window.location.replace("/");
    };

    if (!auth.email) {
        return (
            <div className="flex items-center gap-3">
                <Link className="underline text-sm" href="/login">Login</Link>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3">
            {auth.admin ? <Link className="underline text-sm" href="/admin">Admin</Link> : null}
            <button onClick={onLogout} className="text-sm underline" aria-label="Sign out">
                Logout
            </button>
        </div>
    );
}
