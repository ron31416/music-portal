// src/app/api/song/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { Buffer } from "node:buffer";
import { DB_SCHEMA } from "@/lib/dbSchema";
import { z } from "zod";
import { SONG_COL } from "@/lib/songCols";
import type { SongListItem, SongListResponse } from "@/lib/types";

/* =========================
   Response helpers / types
   ========================= */

type OkResponse = { ok: true; song_id: number | null };
type ErrResponse = { ok: false; error: string; message?: string };

function ok(body: OkResponse, status = 200): NextResponse<OkResponse> {
  return NextResponse.json<OkResponse>(body, { status });
}
function err(message: string, status = 400, extra?: { message?: string }): NextResponse<ErrResponse> {
  return NextResponse.json<ErrResponse>({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

/* =========================
   Validation
   ========================= */

const CanonicalSaveSchema = z.object({
  song_id: z.number().int().positive().optional(),
  song_title: z.string().trim().min(1, "song_title is required"),
  composer_first_name: z.string().trim().min(1, "composer_first_name is required"),
  composer_last_name: z.string().trim().min(1, "composer_last_name is required"),
  // DB expects NUMBER, not name:
  skill_level_number: z.number().int().positive({ message: "skill_level_number must be a positive integer" }),
  file_name: z.string().trim().min(1, "file_name is required"),
  // Base64 of the .mxl zip; required on create, optional on pure metadata update.
  mxl_base64: z.string().trim().min(1, "mxl_base64 is required"),
});

type CanonicalSaveInput = z.infer<typeof CanonicalSaveSchema>;

/* =========================
   Small guards
   ========================= */

function isObjectRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isZipMagic(u8: Uint8Array): boolean {
  return (
    u8.length >= 4 &&
    u8[0] === 0x50 && // 'P'
    u8[1] === 0x4b && // 'K'
    (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07) &&
    (u8[3] === 0x04 || u8[3] === 0x06 || u8[3] === 0x08)
  );
}
function base64ToByteaHex(b64: string): string {
  const norm = b64.replace(/\s+/g, "");
  const u8 = new Uint8Array(Buffer.from(norm, "base64"));
  if (!isZipMagic(u8)) {
    throw new Error("payload_not_mxl_zip");
  }
  return "\\x" + Buffer.from(u8).toString("hex");
}

/* =========================
   Query validation (Zod)
   ========================= */

const QuerySchema = z.object({
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

function parseQuery(req: NextRequest): { sort: string | null; dir: "asc" | "desc" } {
  const url = new URL(req.url);
  const raw = {
    sort: url.searchParams.get("sort") ?? null,
    dir: (url.searchParams.get("dir") ?? "asc").toLowerCase(),
  };
  const parsed = QuerySchema.safeParse(raw);
  let sort: string | null = null;
  let dir: "asc" | "desc" = "asc";
  if (parsed.success) {
    const q = parsed.data;
    if (q.sort) { sort = q.sort; }
    if (q.dir === "asc" || q.dir === "desc") { dir = q.dir; }
  }
  return { sort, dir };
}


/* =========================
   POST /api/song  (create/update a song)
   ========================= */

export async function POST(req: Request): Promise<NextResponse<OkResponse | ErrResponse>> {
  try {
    const raw = (await req.json()) as unknown;
    if (!isObjectRecord(raw)) {
      return err("Invalid JSON body", 400);
    }

    // Map from your column constants to a canonical object we can validate.
    const candidate: CanonicalSaveInput = {
      song_id: (() => {
        const v = raw[SONG_COL.songId];
        if (typeof v === "number" && Number.isInteger(v) && v > 0) { return v; }
        if (typeof v === "string" && /^\d+$/.test(v)) {
          const n = Number(v);
          if (Number.isInteger(n) && n > 0) { return n; }
        }
        return undefined;
      })(),
      song_title: String(raw[SONG_COL.songTitle] ?? ""),
      composer_first_name: String(raw[SONG_COL.composerFirstName] ?? ""),
      composer_last_name: String(raw[SONG_COL.composerLastName] ?? ""),
      // DB expects NUMBER, not name:
      skill_level_number: Number(raw[SONG_COL.skillLevelNumber]),
      file_name: String(raw[SONG_COL.fileName] ?? ""),
      mxl_base64: String(raw[SONG_COL.songMxl] ?? ""),
    };

    const parsed = CanonicalSaveSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(first?.message ?? "Invalid request body", 400);
    }
    const input = parsed.data;

    // Convert base64 to Postgres bytea hex literal
    let mxlHex: string | null = null;
    try {
      mxlHex = base64ToByteaHex(input.mxl_base64);
    } catch (e) {
      if (e instanceof Error && e.message === "payload_not_mxl_zip") {
        return err("payload_not_mxl_zip", 400, { message: "Song bytes must be compressed .mxl (ZIP) format." });
      }
      return err("invalid_base64", 400, { message: "mxl_base64 is not valid base64." });
    }

    // 👇 lazily create the admin client inside the handler
    const supabaseAdmin = getSupabaseAdmin();

    // RPC to your actual function + argument names
    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("song_upsert", {
        p_song_id: input.song_id ?? null,
        p_song_title: input.song_title,
        p_composer_first_name: input.composer_first_name,
        p_composer_last_name: input.composer_last_name,
        p_skill_level_number: input.skill_level_number,
        p_file_name: input.file_name,
        p_song_mxl: mxlHex, // bytea hex literal
      });

    if (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        return err("conflict", 409, { message: "A song with the same file name or (title, composer, level) already exists." });
      }
      if ((error as { code?: string } | null)?.code === "P0002") {
        return err("not_found", 404, { message: "song_id not found for update." });
      }
      return err((error as { message?: string } | null)?.message ?? "RPC song_upsert failed", 500);
    }

    const songId = typeof data === "number" ? data : null;
    return ok({ ok: true, song_id: songId }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg, 500);
  }
}

/* =========================
   DELETE /api/song?id=<song_id>
   ========================= */

export async function DELETE(req: NextRequest): Promise<NextResponse<OkResponse | ErrResponse>> {
  try {
    const url = new URL(req.url);
    const idRaw = url.searchParams.get("id");
    if (!idRaw) {
      return err("missing_id", 400, { message: "Provide ?id=<song_id> in the query string." });
    }

    const idNum = Number(idRaw);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return err("invalid_id", 400, { message: "song_id must be a positive integer." });
    }

    // 👇 lazily create the admin client inside the handler
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("song_delete", {
        p_song_id: idNum,
      });

    if (error) {
      // If you don't have ON DELETE CASCADE on child tables, FK violations may surface as 23503
      if ((error as { code?: string } | null)?.code === "23503") {
        return err("constraint_violation", 409, {
          message: "Cannot delete: this song is referenced by other records.",
        });
      }
      return err((error as { message?: string } | null)?.message ?? "RPC song_delete failed", 500);
    }

    const deletedCount = typeof data === "number" ? data : Number(data ?? 0);
    if (deletedCount < 1) {
      return err("not_found", 404, { message: "song_id not found." });
    }

    return ok({ ok: true, song_id: idNum }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg, 500);
  }
}

/* =========================
   GET /api/song (list songs)
   ========================= */

export async function GET(req: NextRequest): Promise<NextResponse<SongListResponse | { error: string }>> {
  try {
    const { sort, dir } = parseQuery(req);

    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("song_list", {
        p_sort_column: sort,
        p_sort_direction: dir,
      });

    if (error) {
      console.error("[song_list] RPC error:", error);
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        },
        { status: 500 }
      );
    }

    const items = (Array.isArray(data) ? data : []) as SongListItem[];
    return NextResponse.json(
      { items },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

