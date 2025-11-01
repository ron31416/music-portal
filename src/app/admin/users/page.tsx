// src/app/admin/users/page.tsx
"use client";

import React from "react";

import { usePrefersDark, themeTokens, fieldStyle } from "@/lib/theme";
import AdminUserListPanel from "@/components/AdminUserListPanel";
import AdminUserEditPanel from "@/components/AdminUserEditPanel";
import type { UserListItem } from "@/lib/types";
import { USER_COL, type UserColToken, DEFAULT_SORT, DEFAULT_DIR } from "@/lib/userCols";
import { fetchUserList } from "@/lib/userListFetch";
import { fetchUserRoles, type UserRole } from "@/lib/userRoleFetch";


// --- Config ----

//                  Name Email FName LName Role Upd
const GRID_COLS_PX = [100, 200, 150, 150, 100, 150] as const;
const GRID_COLS: React.CSSProperties["gridTemplateColumns"] = GRID_COLS_PX.map(n => `${n}px`).join(" ");
const TABLE_MIN_PX = GRID_COLS_PX.reduce((a, b) => a + b, 0);
const TABLE_ROW_PX = 28;
const TABLE_ROW_COUNT = 10;

const USER_LIST_ENDPOINT = "/api/userlist";
const SAVE_ENDPOINT = "/api/user";

// --- Types ---

type SaveResponse = {
    ok?: boolean;
    user_id?: number;
    error?: string;
    message?: string;
};

type SortDir = "asc" | "desc";


// --- Component ---

export default function AdminUsersPage(): React.ReactElement {
    // Users list state (inline, always visible)
    const [rows, setRows] = React.useState<UserListItem[]>([]);
    const [listLoading, setListLoading] = React.useState(false);
    const [listError, setListError] = React.useState("");

    // Server sorting only
    const [sort, setSort] = React.useState<UserColToken | null>(DEFAULT_SORT);
    const [sortDir, setSortDir] = React.useState<SortDir>(DEFAULT_DIR);

    // Edit fields (manual entry; no files/XML)
    const [userId, setUserId] = React.useState<number | null>(null);
    const [userName, setUserName] = React.useState("");
    const [userEmail, setUserEmail] = React.useState("");
    const [userFirst, setUserFirst] = React.useState("");
    const [userLast, setUserLast] = React.useState("");
    const [roleNumber, setRoleNumber] = React.useState(""); // holds selected user_role_number as string

    // Status
    const [error, setError] = React.useState("");
    const [saveOk, setSaveOk] = React.useState("");
    const [deleting, setDeleting] = React.useState(false);
    const [statusTick, setStatusTick] = React.useState(0);

    // User roles state
    const [roles, setRoles] = React.useState<ReadonlyArray<UserRole>>([]);
    const [rolesLoading, setRolesLoading] = React.useState(false);
    const [rolesError, setRolesError] = React.useState("");

    // Abort/seq guards (match Songs page pattern)
    const listAbortRef = React.useRef<AbortController | null>(null);
    const listSeqRef = React.useRef(0);

    const isDark = usePrefersDark();
    const T = React.useMemo(() => themeTokens(isDark), [isDark]);
    const fieldCss = React.useMemo(() => fieldStyle(isDark), [isDark]);

    // fetch list on mount
    React.useEffect(() => {
        void refreshUserList();
        return () => {
            if (listAbortRef.current !== null) {
                listAbortRef.current.abort();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // fetch roles on mount
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
        if (showSpinner) {
            setListLoading(true);
        }

        // cancel any in-flight request
        if (listAbortRef.current !== null) {
            listAbortRef.current.abort();
        }

        // set up new request + sequence
        const controller = new AbortController();
        listAbortRef.current = controller;
        const seq = listSeqRef.current + 1;
        listSeqRef.current = seq;

        try {
            const effSort = overrideSort ?? sort;
            const effDir: SortDir = overrideDir ?? sortDir;

            // shared fetch + normalize
            const data = await fetchUserList(
                USER_LIST_ENDPOINT,
                effSort,           // UserColToken | null → string | null OK
                effDir,            // "asc" | "desc"
                controller.signal
            );

            // ignore stale responses
            if (seq !== listSeqRef.current) {
                return;
            }

            // set table rows
            setRows(data);
        } catch (e: unknown) {
            const name = (e as { name?: string } | null)?.name ?? "";
            if (name === "AbortError") {
                return;
            }
            setListError(e instanceof Error ? e.message : String(e));
            setRows([]);
        } finally {
            if (seq === listSeqRef.current) {
                setListLoading(false);
            }
        }
    }

    const toggleSort = (key: UserColToken): void => {
        const nextDir: SortDir = (sort === key) ? (sortDir === "asc" ? "desc" : "asc") : "asc";
        setSort(key);
        setSortDir(nextDir);
        void refreshUserList(key, nextDir);
    };

    // Selecting a row fills the form (mirrors Songs' loadSongRow shape)
    async function loadUserRow(item: UserListItem): Promise<void> {
        setError("");
        setSaveOk("");
        setUserId(item.user_id);
        setUserName(item.user_name ?? "");
        setUserEmail(item.user_email ?? "");
        setUserFirst(item.user_first_name ?? "");
        setUserLast(item.user_last_name ?? "");
        setRoleNumber(item.user_role_number !== null ? String(item.user_role_number) : "");
    }

    // Clear Entry (Songs had "Load New Song" button; this is the parallel)
    function onClear(): void {
        setError("");
        setSaveOk("");
        setUserId(null);
        setUserName("");
        setUserEmail("");
        setUserFirst("");
        setUserLast("");
        setRoleNumber("");
    }

    // ---- Save / Delete ----

    function hasLeadingSpace(s: string): boolean {
        return s.length > 0 && s[0] === " ";
    }
    function hasDoubleSpace(s: string): boolean {
        return s.includes("  ");
    }
    function rtrimSpaces(s: string): string {
        return s.replace(/[ \t]+$/u, "");
    }

    const isUpdate = userId !== null;
    const canAdd =
        !isUpdate &&
        userName.trim().length > 0 &&
        userEmail.trim().length > 0 &&
        roleNumber.length > 0 &&
        !deleting;

    const canUpdate =
        isUpdate &&
        userName.trim().length > 0 &&
        userEmail.trim().length > 0 &&
        roleNumber.length > 0 &&
        !deleting;

    const canSave = isUpdate ? canUpdate : canAdd;
    const saveLabel = isUpdate ? "Update User" : "Add User";
    const canDelete = userId !== null && !deleting;

    async function onSave(): Promise<void> {
        setError("");
        setSaveOk("");

        const nameTrim = rtrimSpaces(userName);
        const emailTrim = rtrimSpaces(userEmail);
        const firstTrim = rtrimSpaces(userFirst);
        const lastTrim = rtrimSpaces(userLast);

        if (nameTrim.length === 0) {
            setError("Username is required.");
            return;
        }
        if (emailTrim.length === 0) {
            setError("Email is required.");
            return;
        }
        if (roleNumber.length === 0) {
            setError("Role is required.");
            return;
        }

        if (hasLeadingSpace(nameTrim)) {
            setError("Username must not start with a space.");
            return;
        }
        if (hasDoubleSpace(nameTrim)) {
            setError("Username must not contain double spaces.");
            return;
        }
        if (hasLeadingSpace(emailTrim)) {
            setError("Email must not start with a space.");
            return;
        }

        try {
            // Build payload using constant keys (parallel to SONG_COL pattern)
            const payload = {
                [USER_COL.userId]: userId,
                [USER_COL.userName]: nameTrim,
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
                const message = (json && (json.message || json.error)) || (await res.text()) || `Save failed (HTTP ${res.status})`;
                setError(message);
                return;
            }

            const wasUpdate = userId !== null;

            if (json && typeof json.user_id === "number" && Number.isFinite(json.user_id)) {
                setUserId(json.user_id);
            }

            // Refresh the list **silently** (no spinner, no layout dim)
            await refreshUserList(undefined, undefined, false);

            // Clear any prior error, then set the final success message **last**
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

        if (userId === null) {
            setError("No user selected.");
            return;
        }

        const confirmed = window.confirm("Delete this user? This cannot be undone.");
        if (!confirmed) {
            return;
        }

        try {
            setDeleting(true);

            const res = await fetch(`/api/user?id=${userId}`, { method: "DELETE" });
            if (!res.ok) {
                const ct = res.headers.get("content-type") ?? "";
                let detail = `HTTP ${res.status}`;

                if (ct.includes("application/json")) {
                    try {
                        const j = (await res.json()) as unknown;
                        const msg = (j && typeof j === "object" ? (j as Record<string, unknown>).message : "") as unknown;
                        if (typeof msg === "string" && msg.trim()) {
                            detail = msg;
                        }
                    } catch {
                        // ignore json parse
                    }
                } else if (ct.startsWith("text/")) {
                    try {
                        const t = await res.text();
                        if (t) {
                            detail = t.slice(0, 200);
                        }
                    } catch {
                        // ignore text read
                    }
                }

                setError(detail || "Delete failed.");
                return;
            }

            // Success: keep field values, but set userId to null
            setUserId(null);

            // Silent list refresh
            await refreshUserList(undefined, undefined, false);

            // Feedback
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
                T={T}
            />

            {/* ===== EDIT PANEL (ALWAYS VISIBLE, BELOW GRID) ===== */}
            <AdminUserEditPanel
                /* controlled values */
                userName={userName}
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
                onChangeUserName={(v) => { setUserName(v); }}
                onChangeUserEmail={(v) => { setUserEmail(v); }}
                onChangeUserFirst={(v) => { setUserFirst(v); }}
                onChangeUserLast={(v) => { setUserLast(v); }}
                onChangeRoleNumber={(v) => { setRoleNumber(v); }}
                onPick={onClear}
                onSave={onSave}
                onDelete={onDelete}

                /* theming/layout */
                T={T}
                fieldCss={fieldCss}
                isDark={isDark}
            />
        </main>
    );
}
