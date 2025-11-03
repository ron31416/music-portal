// src/lib/requireAdminPage.ts
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isAdminEmail } from "@/lib/isAdmin";

export async function requireAdminPage(): Promise<void> {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email ?? null;

    if (!email) {
        redirect("/login?next=/admin");
    }
    if (!isAdminEmail(email)) {
        redirect("/"); // or a 403 page
    }
}
