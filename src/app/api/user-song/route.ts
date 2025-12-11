// src/app/api/user-song/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

//=========================
// Types
//=========================*/

type UserSongRow = {
  user_song_id: number;
  user_id: number;
  song_id: number;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

//=========================
// Small helpers (JSON responses)
//=========================*/

function badRequestJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "bad_request", message },
    { status: 400 }
  );
}

function serverErrorJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "server_error", message },
    { status: 500 }
  );
}

//=========================
// GET /api/user-song
// Query: ?userId=123&songId=456
// Calls: user_song_get(p_user_id, p_song_id)
// Returns: { ok: true, data: UserSongRow | null }
//=========================*/
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const url = new URL(req.url);
    const userIdParam = url.searchParams.get("userId");
    const songIdParam = url.searchParams.get("songId");

    if (!userIdParam || !songIdParam) {
      return badRequestJson("userId and songId query parameters are required");
    }

    const userId = Number(userIdParam);
    const songId = Number(songIdParam);

    if (!Number.isInteger(userId) || userId <= 0) {
      return badRequestJson("userId must be a positive integer");
    }
    if (!Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_get", {
        p_user_id: userId,
        p_song_id: songId,
      });

    if (error) {
      console.error("user_song_get error:", error);
      return serverErrorJson(error.message ?? "Failed to get user_song row");
    }

    const rows = Array.isArray(data) ? (data as UserSongRow[]) : [];
    const row = rows.length > 0 ? rows[0] : null;

    return NextResponse.json(
      {
        ok: true,
        data: row,
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song GET endpoint";

    console.error("user-song GET route error:", e);
    return serverErrorJson(message);
  }
}

//=========================
// POST /api/user-song
// Body: { songId: number, userId: number }
// Behavior:
//   - Uses service_role client to call user_song_upsert(p_user_id, p_user_email=null, p_song_id).
//   - No Supabase auth here; ViewerClient already resolved userId via /api/whoami.
// Returns: { ok: true, data: UserSongRow | null } on success
//=========================*/
export async function POST(req: NextRequest): Promise<Response> {
  try {
    // --------------------------------------------
    // Safely read and log the incoming request body
    // --------------------------------------------
    let raw: unknown;
    try {
      raw = await req.json();
    } catch (err) {
      console.error("[user-song POST] Failed to parse JSON body:", err);
      return badRequestJson("Invalid JSON body");
    }

    console.log("[user-song POST] RAW BODY:", raw);

    // Ensure raw is an object before destructuring
    if (typeof raw !== "object" || raw === null) {
      return badRequestJson("Request body must be an object");
    }

    const body = raw as Record<string, unknown>;
    const songId = body.songId;
    const userId = body.userId;

    console.log(
      "[user-song POST] Parsed values → songId:",
      songId,
      "userId:",
      userId
    );

    // --------------------------------------------
    // Validation
    // --------------------------------------------
    if (
      typeof songId !== "number" ||
      !Number.isInteger(songId) ||
      songId <= 0
    ) {
      console.error("[user-song POST] Invalid songId:", songId);
      return badRequestJson("songId must be a positive integer");
    }

    if (
      typeof userId !== "number" ||
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      console.error("[user-song POST] Invalid userId:", userId);
      return badRequestJson("userId must be a positive integer");
    }

    // --------------------------------------------
    // Perform RPC call (same as before)
    // --------------------------------------------
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_upsert", {
        p_user_id: userId,
        p_user_email: null,
        p_song_id: songId,
      });

    if (error) {
      console.error("[user-song POST] user_song_upsert error:", error);
      return serverErrorJson(error.message ?? "Failed to upsert user_song row");
    }

    const rows = Array.isArray(data) ? (data as UserSongRow[]) : [];
    const row = rows.length > 0 ? rows[0] : null;

    console.log("[user-song POST] Upsert result row:", row);

    return NextResponse.json({ ok: true, data: row }, { status: 200 });

  } catch (e: unknown) {
    console.error("[user-song POST] route error:", e);
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song POST endpoint";

    return serverErrorJson(message);
  }
}
