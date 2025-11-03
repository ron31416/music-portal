// src/components/AdminFab.tsx (server component)
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isAdminEmail } from "@/lib/isAdmin";
import Link from "next/link";

export default async function AdminFab() {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const user = data.user ?? null;

    if (!user || !isAdminEmail(user.email)) {
        return null; // hide if not admin
    }

    return (
        <Link
            href="/admin"
            className="fixed right-4 bottom-4 rounded-full px-4 py-2 border shadow"
            aria-label="Admin"
        >
            Admin
        </Link>
    );
}
