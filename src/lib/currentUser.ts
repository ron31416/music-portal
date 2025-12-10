// src/lib/currentUser.ts
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

export type CurrentUserInfo = {
  email: string | null;
  role: string | null;   // normalized, lowercased
  isAdmin: boolean;
};

export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await getSupabaseServerClient();

  // 1) Auth user from cookie-bound server client
  const { data: ures, error: uerr } = await supabase.auth.getUser();
  const user = ures?.user ?? null;
  const email = (user?.email as string | null) ?? null;

  if (uerr || !user || !email) {
    return { email: null, role: null, isAdmin: false };
  }

  // 2) DB role via service_role RPC: user_get(email)
  const adminClient = getSupabaseAdmin();

  let role: string | null = null;

  try {
    const { data, error: getErr } = await adminClient
      .schema(DB_SCHEMA)
      .rpc("user_get", {
        p_user_id: null,
        p_user_email: email,
      });

    if (!getErr && Array.isArray(data) && data.length > 0) {
      const row = data[0] as {
        user_role_name?: string | null;
      };

      if (row.user_role_name !== null) {
        role = String(row.user_role_name).toLowerCase();
      }
    }
  } catch {
    // If the RPC blows up, just treat as non-admin
    role = null;
  }

  const isAdmin = role === "admin";

  return { email, role, isAdmin };
}
