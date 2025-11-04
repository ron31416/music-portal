// src/components/auth/AuthActionsServer.tsx
// Server component: decides which auth buttons to show on the main page header.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

export default async function AuthActionsServer({
    title = "Music Portal",
    next = "/",
}: {
    title?: string;
    next?: string;
}) {
    const supabase = await getSupabaseServerClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    return (
        // keep a simple wrapper
        <div className="mb-4">
            {/* enforce the same centered width & padding as <main class="mx-auto max-w-2xl p-6"> */}
            <div className="mx-auto max-w-2xl px-6">
                {/* 3-col grid: [spacer] [center title] [right actions] */}
                <div className="grid grid-cols-3 items-center">
                    <div />

                    <h1 className="justify-self-center text-xl font-semibold text-neutral-100">
                        {title}
                    </h1>

                    <div className="justify-self-end whitespace-nowrap">
                        {!user ? (
                            <div className="flex items-center gap-2">
                                <Link
                                    href={`/login?mode=create&next=${encodeURIComponent(next)}`}
                                    className="rounded-lg px-3 py-2 bg-neutral-100 text-neutral-900 hover:bg-white transition"
                                >
                                    Create account
                                </Link>
                                <Link
                                    href={`/login?mode=login&next=${encodeURIComponent(next)}`}
                                    className="rounded-lg px-3 py-2 border border-neutral-400/50 hover:border-neutral-300/80 transition"
                                >
                                    Log in
                                </Link>
                            </div>
                        ) : (
                            <form action={logout} className="m-0">
                                <input type="hidden" name="next" value={next} />
                                <button
                                    type="submit"
                                    className="rounded-lg px-3 py-2 border border-neutral-400/50 hover:border-neutral-300/80 transition"
                                >
                                    Log out
                                </button>
                            </form>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ----- server action -----
async function logout(formData: FormData) {
    "use server";
    const next = (formData.get("next") as string) || "/";
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
    redirect(next);
}
