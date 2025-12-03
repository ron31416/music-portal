// src/lib/songCols.ts

/* ============================================================
   Canonical column tokens used at the client/server boundary
   (Single Source of Truth)
   ============================================================ */

export const SONG_COL = {
  songId: "song_id",
  songTitle: "song_title",
  composerFirstName: "composer_first_name",
  composerLastName: "composer_last_name",
  skillLevelNumber: "skill_level_number",
  skillLevelName: "skill_level_name",
  fileName: "file_name",
  songMxl: "song_mxl",
  insertedDatetime: "inserted_datetime",
  updatedDatetime: "updated_datetime",
} as const;

/** Union of all known tokens (values of SONG_COL) */
export type SongColToken = (typeof SONG_COL)[keyof typeof SONG_COL];

/** Quick runtime guard (useful if something untyped reaches the boundary) */
export function isSongColToken(v: unknown): v is SongColToken {
  if (typeof v !== "string") { return false; }
  return Object.values(SONG_COL).includes(v as SongColToken);
}

/* ============================================================
   Sorting whitelist
   Only these tokens are allowed for server-side ORDER BY.
   Extend deliberately (don’t sort by large blobs like song_mxl).
   ============================================================ */

export const SORTABLE_TOKENS = [
  SONG_COL.songTitle,
  SONG_COL.composerFirstName,
  SONG_COL.composerLastName,
  SONG_COL.skillLevelNumber,
  SONG_COL.fileName,
  SONG_COL.insertedDatetime,
  SONG_COL.updatedDatetime
] as const;

export type SortableSongColToken = (typeof SORTABLE_TOKENS)[number];

/** Runtime guard for sortable tokens */
export function isSortableSongColToken(v: unknown): v is SortableSongColToken {
  if (typeof v !== "string") { return false; }
  return (SORTABLE_TOKENS as readonly string[]).includes(v);
}

/* ============================================================
   Safe token → SQL column map (readonly)
   Used by /api/song GET list to avoid string interpolation.
   ============================================================ */

export const tokenToSql: Readonly<Record<SortableSongColToken, string>> = {
  [SONG_COL.songTitle]: "song_title",
  [SONG_COL.composerFirstName]: "composer_first_name",
  [SONG_COL.composerLastName]: "composer_last_name",
  [SONG_COL.skillLevelNumber]: "skill_level_number",
  [SONG_COL.fileName]: "file_name",
  [SONG_COL.insertedDatetime]: "inserted_datetime",
  [SONG_COL.updatedDatetime]: "updated_datetime",
} as const;

/* ============================================================
   Optional helpers / defaults
   ============================================================ */

export const DEFAULT_SORT: SortableSongColToken = SONG_COL.composerLastName;
export const DEFAULT_DIR = "asc" as const;
