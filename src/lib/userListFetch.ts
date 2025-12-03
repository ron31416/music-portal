// src/lib/userListFetch.ts
import type { UserListItem } from "@/lib/types";

export type SortDir = "asc" | "desc";

/** Convert /api/user GET list payload into strict UserListItem[] */
export function normalizeUserList(json: unknown): UserListItem[] {
  const items = (json && typeof json === "object"
    ? (json as Record<string, unknown>).items
    : []) as unknown;

  const out: UserListItem[] = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === "object") {
        const r = it as Record<string, unknown>;

        const id = r.user_id;
        if (typeof id === "number" && Number.isFinite(id)) {
          out.push({
            user_id: id,
            user_email: String(r.user_email ?? ""),
            user_first_name: String(r.user_first_name ?? ""),
            user_last_name: String(r.user_last_name ?? ""),
            user_role_number: Number(r.user_role_number ?? 1),
            user_role_name: String(r.user_role_name ?? ""),
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
export async function fetchUserList(
  endpoint: string,
  sort: string | null,
  dir: SortDir,
  signal?: AbortSignal
): Promise<UserListItem[]> {
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
  return normalizeUserList(json);
}
