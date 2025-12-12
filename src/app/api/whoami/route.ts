// src/app/api/whoami/route.ts
import { NextResponse } from "next/server";
import { getCurrentUserInfo } from "@/lib/currentUser";

// Returns who is signed in and their role.
// Normal shape:
//   { ok: true, email, role, is_admin, userId, devBypass? }
// - If using localhost dev bypass, devBypass will be true.
// - On real environments, devBypass will be false or omitted.
export async function GET() {
  try {
    const { email, role, isAdmin, userId, devBypass } = await getCurrentUserInfo();

    return NextResponse.json({
      ok: true as const,
      email,
      role,
      is_admin: isAdmin,
      userId,
      devBypass: !!devBypass,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
