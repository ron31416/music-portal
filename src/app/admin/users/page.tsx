// src/app/admin/users/page.tsx
"use client";

import React from "react";

import { usePrefersDark } from "@/lib/theme";
import AdminUserListPanel from "@/components/AdminUserListPanel";
import AdminUserEditPanel from "@/components/AdminUserEditPanel";
import type { UserListItem } from "@/lib/types";
import { USER_COL, type UserColToken, DEFAULT_SORT, DEFAULT_DIR } from "@/lib/userCols";
import { fetchUserList } from "@/lib/userListFetch";
import { fetchUserRoles, type UserRole } from "@/lib/userRoleFetch";

/* ========================
   Config
   ========================= */

//                  Email FName LName Role Upd
const GRID_COLS_PX = [200, 150, 150, 100, 150] as const;
const GRID_COLS: React.CSSProperties["gridTemplateColumns"] =
  GRID_COLS_PX.map((n) => `${n}px`).join(" ");
const TABLE_MIN_PX = GRID_COLS_PX.reduce((a, b) => a + b, 0);
const TABLE_ROW_PX = 28;
const TABLE_ROW_COUNT = 10;

const USER_LIST_ENDPOINT = "/api/user";
const SAVE_ENDPOINT = "/api/user";

/* =========================
   Types
   ========================= */

type SaveResponse = {
  ok?: boolean;
  user_id?: number;
  error?: string;
  message?: string;
};

type SortDir = "asc" | "desc";

/* =========================
   Component
   ========================= */

export default function AdminUsersPage(): React.ReactElement {
  // Users list state
  const [rows, setRows] = React.useState<UserListItem[]>([]);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState("");

  // Server sorting only
  const [sort, setSort] = React.useState<UserColToken | null>(DEFAULT_SORT);
  const [sortDir, setSortDir] = React.useState<SortDir>(DEFAULT_DIR);

  // Fields
  const [userId, setUserId] = React.useState<number | null>(null);
  const [userEmail, setUserEmail] = React.useState("");
  const [userFirst, setUserFirst] = React.useState("");
  const [userLast, setUserLast] = React.useState("");
  const [roleNumber, setRoleNumber] = React.useState(""); // selected user_role_number as string
  const [roles, setRoles] = React.useState<ReadonlyArray<UserRole>>([]);
  const [rolesLoading, setRolesLoading] = React.useState(false);
  const [rolesError, setRolesError] = React.useState("");

  // Status
  const [error, setError] = React.useState("");
  const [saveOk, setSaveOk] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [statusTick, setStatusTick] = React.useState(0);

  // Refs / seq guards
  const listAbortRef = React.useRef<AbortController | null>(null);
  const listSeqRef = React.useRef(0);

  // Theme hydration gate (match Songs page)
  const prefersDark = usePrefersDark();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(true); }, []);
  const isDark = mounted ? prefersDark : false;

  /* ----- fetch list on mount ----- */
  React.useEffect(() => {
    void refreshUserList();
    return () => { if (listAbortRef.current) { listAbortRef.current.abort(); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- fetch roles on mount ----- */
  React.useEffect(() => {
    let ignore = false;
    setRolesLoading(true);
    setRolesError("");
    fetchUserRoles()
      .then((data) => { if (!ignore) { setRoles(data); } })
      .catch((e) => { if (!ignore) { setRolesError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (!ignore) { setRolesLoading(false); } });
    return () => { ignore = true; };
  }, []);

  async function refreshUserList(
    overrideSort?: UserColToken | null,
    overrideDir?: SortDir,
    showSpinner: boolean = true
  ): Promise<void> {
    setListError("");
    if (showSpinner) { setListLoading(true); }

    if (listAbortRef.current) { listAbortRef.current.abort(); }

    const controller = new AbortController();
    listAbortRef.current = controller;
    const seq = ++listSeqRef.current;

    try {
      const effSort = overrideSort ?? sort;
      const effDir: SortDir = overrideDir ?? sortDir;
      const data = await fetchUserList(USER_LIST_ENDPOINT, effSort, effDir, controller.signal);

      if (seq !== listSeqRef.current) { return; }

      setRows(data);
    } catch (e: unknown) {
      if ((e as { name?: string } | null)?.name === "AbortError") { return; }
      setListError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      if (seq === listSeqRef.current) { setListLoading(false); }
    }
  }

  const toggleSort = (key: UserColToken): void => {
    const nextDir: SortDir = sort === key ? (sortDir === "asc" ? "desc" : "asc") : "asc";
    setSort(key);
    setSortDir(nextDir);
    void refreshUserList(key, nextDir);
  };

  // Selecting a row fills the form (mirrors Songs shape)
  async function loadUserRow(item: UserListItem): Promise<void> {
    setError("");
    setSaveOk("");
    setUserId(item.user_id);
    setUserEmail(item.user_email ?? "");
    setUserFirst(item.user_first_name ?? "");
    setUserLast(item.user_last_name ?? "");
    setRoleNumber(item.user_role_number !== null ? String(item.user_role_number) : "");
  }

  // Clear entry (parallel to “Load New Song”)
  function onClear(): void {
    setError("");
    setSaveOk("");
    setUserId(null);
    setUserEmail("");
    setUserFirst("");
    setUserLast("");
    setRoleNumber("");
  }

  // ---- client-side string checks ----
  function hasLeadingSpace(s: string): boolean { return s.length > 0 && s[0] === " "; }
  function rtrimSpaces(s: string): string { return s.replace(/[ \t]+$/u, ""); }

  const isUpdate = userId !== null;

  const canAdd =
    !isUpdate &&
    userEmail.trim().length > 0 &&
    roleNumber.length > 0 &&
    !deleting;

  const canUpdate =
    isUpdate &&
    userEmail.trim().length > 0 &&
    roleNumber.length > 0 &&
    !deleting;

  const canSave = isUpdate ? canUpdate : canAdd;
  const saveLabel = isUpdate ? "Update User" : "Add User";
  const canDelete = userId !== null && !deleting;

  async function onSave(): Promise<void> {
    setError("");
    setSaveOk("");

    const emailTrim = rtrimSpaces(userEmail);
    const firstTrim = rtrimSpaces(userFirst);
    const lastTrim = rtrimSpaces(userLast);

    if (emailTrim.length === 0) { setError("Email is required."); return; }
    if (roleNumber.length === 0) { setError("Role is required."); return; }

    if (hasLeadingSpace(emailTrim)) { setError("Email must not start with a space."); return; }

    try {
      const payload = {
        [USER_COL.userId]: userId,
        [USER_COL.userEmail]: emailTrim,
        [USER_COL.userFirstName]: firstTrim,
        [USER_COL.userLastName]: lastTrim,
        [USER_COL.userRoleNumber]: Number(roleNumber),
      };

      const res = await fetch(SAVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let json: SaveResponse | null = null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        json = (await res.json()) as SaveResponse;
      }

      if (!res.ok) {
        const message =
          (json && (json.message || json.error)) ||
          (await res.text()) ||
          `Save failed (HTTP ${res.status})`;
        setError(message);
        return;
      }

      const wasUpdate = userId !== null;
      if (json && typeof json.user_id === "number" && Number.isFinite(json.user_id)) {
        setUserId(json.user_id);
      }

      await refreshUserList(undefined, undefined, false);

      setError("");
      setSaveOk(wasUpdate ? "Updated" : "Added");
      setStatusTick((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(): Promise<void> {
    setError("");
    setSaveOk("");

    if (userId === null) { setError("No user selected."); return; }

    const confirmed = window.confirm("Delete this user? This cannot be undone.");
    if (!confirmed) { return; }

    try {
      setDeleting(true);

      const res = await fetch(`/api/user?id=${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        let detail = `HTTP ${res.status}`;

        if (ct.includes("application/json")) {
          try {
            const j = (await res.json()) as unknown;
            const msg =
              (j && typeof j === "object" ? (j as Record<string, unknown>).message : "") as unknown;
            if (typeof msg === "string" && msg.trim()) { detail = msg; }
          } catch { /* ignore */ }
        } else if (ct.startsWith("text/")) {
          try {
            const t = await res.text();
            if (t) { detail = t.slice(0, 200); }
          } catch { /* ignore */ }
        }

        setError(detail || "Delete failed.");
        return;
      }

      setUserId(null);
      await refreshUserList(undefined, undefined, false);
      setError("");
      setSaveOk("Deleted");
      setStatusTick((t) => t + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main style={{ maxWidth: TABLE_MIN_PX + 32, margin: "24px auto", padding: "0 16px" }}>
      {/* ===== USER LIST (TOP) ===== */}
      <AdminUserListPanel
        rows={rows}
        listLoading={listLoading}
        listError={listError}
        sort={sort}
        sortDir={sortDir}
        onToggleSort={toggleSort}
        onRowClick={(row) => { void loadUserRow(row); }}
        gridCols={GRID_COLS}
        tableMinPx={TABLE_MIN_PX}
        rowPx={TABLE_ROW_PX}
        visibleRowCount={TABLE_ROW_COUNT}
      />

      {/* ===== EDIT PANEL (BELOW) =====
          Mount gate mirrors Songs page to keep SSR/CSR identical */}
      {mounted && (
        <AdminUserEditPanel
          /* controlled values */
          userEmail={userEmail}
          userFirst={userFirst}
          userLast={userLast}
          roleNumber={roleNumber}
          roles={roles}
          rolesLoading={rolesLoading}
          rolesError={rolesError}
          errorText={error}
          saveOkText={saveOk}
          statusTick={statusTick}

          /* computed enables/labels */
          canSave={canSave}
          saveLabel={saveLabel}
          canDelete={canDelete}
          deleting={deleting}

          /* handlers */
          onChangeUserEmail={setUserEmail}
          onChangeUserFirst={setUserFirst}
          onChangeUserLast={setUserLast}
          onChangeRoleNumber={setRoleNumber}
          onPick={onClear}
          onSave={onSave}
          onDelete={onDelete}

          /* theming parity with Songs: only boolean */
          isDark={isDark}
        />
      )}
    </main>
  );
}
