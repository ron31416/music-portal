// src/lib/songListFetch.ts
import type { SongListItem } from "@/lib/types";

/** Convert /api/song GET list payload into strict SongListItem[] */
export function normalizeSongList(json: unknown): SongListItem[] {
  const items = (json && typeof json === "object"
    ? (json as Record<string, unknown>).items
    : []) as unknown;

  const out: SongListItem[] = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === "object") {
        const r = it as Record<string, unknown>;
        const id = r.song_id;
        if (typeof id === "number" && Number.isFinite(id)) {
          out.push({
            song_id: id,
            song_title: String(r.song_title ?? ""),
            composer_first_name: String(r.composer_first_name ?? ""),
            composer_last_name: String(r.composer_last_name ?? ""),
            skill_level_name: String(r.skill_level_name ?? ""),
            skill_level_number: Number(r.skill_level_number ?? 0),
            file_name: String(r.file_name ?? ""),
            inserted_datetime: String(r.inserted_datetime ?? ""),
            updated_datetime: String(r.updated_datetime ?? ""),
          });
        }
      }
    }
  }
  return out;
}

/** Fetch + normalize with optional server sort */
export async function fetchSongList(
  endpoint: string,
  sort: string | null,
  dir: "asc" | "desc",
  signal?: AbortSignal
): Promise<SongListItem[]> {
  const params = new URLSearchParams();
  if (sort !== null) {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  const res = await fetch(`${endpoint}?${params.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  return normalizeSongList(json);
}
