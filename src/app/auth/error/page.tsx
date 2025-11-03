// src/app/auth/error/page.tsx
import Link from "next/link";

export const dynamic = "force-static";

export default function AuthErrorPage({
    searchParams,
}: {
    searchParams?: Record<string, string | string[] | undefined>;
}) {
    const msg =
        (typeof searchParams?.message === "string" && searchParams.message) ||
        "Authentication error.";

    return (
        <main className="mx-auto max-w-xl p-6 space-y-4">
            <h1 className="text-2xl font-semibold">Page not found</h1>
            <p className="text-sm">{msg}</p>
            <Link className="underline text-sm" href="/">
                Go back home
            </Link>
        </main>
    );
}
