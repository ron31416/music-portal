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

type WhoAmIResponse = {
  ok: boolean;
  userId: number | null;
  error?: string;
  message?: string;
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

function unauthorizedJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "unauthorized", message },
    { status: 401 }
  );
}

function serverErrorJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "server_error", message },
    { status: 500 }
  );
}

// Helper: reuse /api/whoami to resolve current user from cookies.
async function getCurrentUserId(req: NextRequest): Promise<number | null> {
  const url = new URL(req.url);
  url.pathname = "/api/whoami";

  const cookieHeader = req.headers.get("cookie") ?? "";

  const res = await fetch(url.toString(), {
    headers: {
      cookie: cookieHeader,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const json = (await res.json()) as WhoAmIResponse;
  return json.ok && json.userId !== null ? json.userId : null;
}

//=========================
// GET /api/user-song
// Query: ?songId=456
// Uses current authenticated user from cookies.
// Calls: user_song_get(p_user_id, p_song_id)
// Returns: { ok: true, data: UserSongRow | null }
//=========================*/
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const url = new URL(req.url);
    const songIdParam = url.searchParams.get("songId");

    if (!songIdParam) {
      return badRequestJson("songId query parameter is required");
    }

    const songId = Number(songIdParam);

    if (!Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    const userId = await getCurrentUserId(req);
    if (!userId) {
      return unauthorizedJson("You must be signed in");
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
// Body: { songId: number }
// Behavior:
//   - Resolves current user from cookies via /api/whoami.
//   - Calls user_song_upsert(p_user_id, p_user_email=null, p_song_id).
// Returns: { ok: true, data: UserSongRow | null } on success
//=========================*/
export async function POST(req: NextRequest): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch (err) {
      console.error("[user-song POST] Failed to parse JSON body:", err);
      return badRequestJson("Invalid JSON body");
    }

    if (typeof raw !== "object" || raw === null) {
      return badRequestJson("Request body must be an object");
    }

    const body = raw as Record<string, unknown>;
    const songId = body.songId;

    if (
      typeof songId !== "number" ||
      !Number.isInteger(songId) ||
      songId <= 0
    ) {
      console.error("[user-song POST] Invalid songId:", songId);
      return badRequestJson("songId must be a positive integer");
    }

    const userId = await getCurrentUserId(req);
    if (!userId) {
      return unauthorizedJson("You must be signed in to edit annotations.");
    }

    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_upsert", {
        p_user_id: userId,
        p_song_id: songId,
      });

    if (error) {
      console.error("[user-song POST] user_song_upsert error:", error);
      return serverErrorJson(error.message ?? "Failed to upsert user_song row");
    }

    if (typeof data !== "number" || !Number.isFinite(data) || data <= 0) {
      console.error("[user-song POST] user_song_upsert returned invalid id:", data);
      return serverErrorJson("user_song_upsert returned invalid id");
    }

    return NextResponse.json({ ok: true, data }, { status: 200 });
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
