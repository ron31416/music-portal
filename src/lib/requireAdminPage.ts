// src/lib/requireAdminPage.ts
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isAdminEmail } from "@/lib/isAdmin";

export async function requireAdminPage(): Promise<void> {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email ?? null;

    // ---- dev override: allow admin UI locally without real session ----
    if (
        (process.env.DEV_FORCE_ADMIN === "1") &&
        (
            process.env.NODE_ENV !== "production" || // safety: only local / preview
            typeof window === "undefined" // pages run server-side
        )
    ) {
        // skip all checks
        return;
    }
    // ---------------------------------------------------------------

    if (!email) {
        redirect("/login?next=/admin");
    }
    if (!isAdminEmail(email)) {
        redirect("/"); // or a 403 page
    }
}
