// src/app/api/whoami/route.ts
import { NextResponse } from "next/server";
import { getCurrentUserInfo } from "@/lib/currentUser";

// Returns who is signed in and their role.
// Shape: { ok: true, email: string|null, role: string|null, is_admin: boolean }
// Logic:
//   - If signed out: email=null, role=null, is_admin=false
//   - If signed in: role from user_get(user_email), is_admin = (role === "admin")
export async function GET() {
  try {
    const { email, role, isAdmin, userId } = await getCurrentUserInfo();

    return NextResponse.json({
      ok: true as const,
      email,
      role,
      is_admin: isAdmin,
      userId,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
