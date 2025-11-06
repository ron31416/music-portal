// src/app/welcome/page.tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import Link from "next/link";

type Props = {
    searchParams?: { [key: string]: string | string[] | undefined };
};

export default async function WelcomePage({ searchParams }: Props) {
    // Bind Supabase SSR client to this request's cookie jar
    const cookieStore = await cookies();
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                get(name: string) {
                    return cookieStore.get(name)?.value ?? undefined;
                },
                set(name: string, value: string, options: CookieOptions) {
                    cookieStore.set({ name, value, ...options });
                },
                remove(name: string, options: CookieOptions) {
                    cookieStore.set({ name, value: "", ...options, maxAge: 0 });
                },
            },
        }
    );

    // Must be authenticated to proceed
    const { data: sessData } = await supabase.auth.getSession();
    const email = sessData?.session?.user?.email ?? null;
    if (!email) {
        redirect("/login");
    }

    // If the row already exists, skip welcome and go home
    const admin = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY! // server-only env
    );

    const { data: rows, error: getErr } = await admin.rpc("user_get", {
        p_user_id: null,
        p_user_email: email!,
    });

    if (!getErr && Array.isArray(rows) && rows.length > 0) {
        redirect("/");
    }

    // --- Error banner from ?err= ---
    const rawErr = searchParams?.err;
    const errCode = Array.isArray(rawErr) ? rawErr[0] : rawErr;

    let errMsg: string | null = null;
    switch (errCode) {
        case "invalid_name":
            errMsg = "Please enter a display name between 1 and 80 characters.";
            break;
        case "save_failed":
            errMsg = "We couldn’t save your name. Please try again.";
            break;
        case "session":
            errMsg = "Your session could not be verified. Please sign in again.";
            break;
        case "no_email":
            errMsg = "We didn’t find an email on your session. Please sign in again.";
            break;
        case undefined:
        case null:
            errMsg = null;
            break;
        default:
            errMsg = "Something went wrong. Please try again.";
    }

    return (
        <main className="mx-auto max-w-md p-6">
            <h1 className="text-2xl font-semibold mb-2">Welcome</h1>
            <p className="text-sm text-gray-600 mb-6">
                What should we call you? It doesn’t have to be your real name—you can change it later.
            </p>

            {errMsg && (
                <div
                    className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
                    role="alert"
                    aria-live="polite"
                >
                    {errMsg}
                </div>
            )}

            <form method="POST" action="/welcome/complete" className="space-y-4">
                <label className="block">
                    <span className="block text-sm font-medium mb-1">Display name</span>
                    <input
                        type="text"
                        name="displayName"
                        required
                        minLength={1}
                        maxLength={80}
                        autoFocus
                        placeholder="e.g., Pat"
                        className="w-full rounded border px-3 py-2"
                    />
                </label>

                <div className="flex items-center gap-3">
                    <button
                        type="submit"
                        className="rounded bg-black px-4 py-2 text-white"
                    >
                        Continue
                    </button>
                    <Link href="/" className="text-sm underline">
                        Cancel
                    </Link>
                </div>
            </form>
        </main>
    );
}
