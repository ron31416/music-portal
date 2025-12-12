// src/lib/currentUser.ts
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

export type CurrentUserInfo = {
  email: string | null;
  role: string | null;
  isAdmin: boolean;
  userId: number | null;
  devBypass?: boolean;
};

export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await getSupabaseServerClient();

  // ------------------------------------------
  // 1) Try to read real user via Supabase auth
  // ------------------------------------------
  const { data: ures, error: uerr } = await supabase.auth.getUser();
  const user = ures?.user ?? null;
  const email = (user?.email as string | null) ?? null;

  // If we DO have a real auth user → normal production flow
  if (!uerr && user && email) {
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

        if (typeof row.user_id === "number") {
          userId = row.user_id;
        }
      }
    } catch {
      /* ignore DB errors → fall back to signed-out */
    }

    const isAdmin = role === "admin";

    return { email, role, isAdmin, userId };
  }

  // ----------------------------------------------------
  // 2) Local dev bypass — trust the environment variables
  // ----------------------------------------------------
  const fakeIdRaw = process.env.DEV_FAKE_USER_ID;
  const fakeEmail = process.env.DEV_FAKE_USER_EMAIL;
  const fakeRole = process.env.DEV_FAKE_USER_ROLE;

  const fakeId = Number(fakeIdRaw);
  const fakeIsAdmin = fakeRole === "admin";
  console.warn(
    `getCurrentUserInfo: fakeIdRaw=${fakeIdRaw}, fakeEmail=${fakeEmail}, fakeRole=${fakeRole}, fakeIsAdmin=${fakeIsAdmin}`
  );

  if (fakeId && fakeEmail && fakeRole) {
    console.warn(
      `getCurrentUserInfo: fakeId=${fakeId}, fakeEmail=${fakeEmail}, fakeRole=${fakeRole}, fakeIsAdmin=${fakeIsAdmin}`
    );

    return {
      email: fakeEmail,
      role: fakeRole,
      isAdmin: fakeIsAdmin,
      userId: fakeId,
      devBypass: true,
    };
  }

  // ------------------------------------------
  // 3) Normal signed-out fallback
  // ------------------------------------------
  return {
    email: null,
    role: null,
    isAdmin: false,
    userId: null,
    devBypass: false,
  };
}
