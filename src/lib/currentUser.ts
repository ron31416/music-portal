// src/lib/currentUser.ts
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

export type CurrentUserInfo = {
  email: string | null;
  role: string | null;
  isAdmin: boolean;
  userId: number | null;
};

export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await getSupabaseServerClient();

  // 1) Auth user from cookie-bound server client
  const { data: ures, error: uerr } = await supabase.auth.getUser();
  const user = ures?.user ?? null;
  const email = (user?.email as string | null) ?? null;

  if (uerr || !user || !email) {
    return { email: null, role: null, isAdmin: false, userId: null };
  }

  // 2) DB lookup via service_role RPC: user_get
  const adminClient = getSupabaseAdmin();

  let role: string | null = null;
  let userId: number | null = null;

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
        user_id?: number | null;
      };

      if (row.user_role_name !== null) {
        role = String(row.user_role_name).toLowerCase();
      }

      if (row.user_id !== null && typeof row.user_id === "number") {
        userId = row.user_id;
      }
    }
  } catch {
    role = null;
    userId = null;
  }

  const isAdmin = role === "admin";

  return { email, role, isAdmin, userId };
}
