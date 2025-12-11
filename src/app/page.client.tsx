// src/app/page.client.tsx
"use client";

import React from "react";

import SongListPanel from "@/components/SongListPanel";
import type { SongListItem } from "@/lib/types";
import { type SongColToken, DEFAULT_SORT, DEFAULT_DIR } from "@/lib/songCols";
import { fetchSongList } from "@/lib/songListFetch";
import AuthHeaderClient from "@/components/auth/AuthHeaderClient";

// --- Config ---
//                 First   Last    Title   Level
const GRID_COLS_PX = [140, 140, 260, 120] as const;
const GRID_COLS: React.CSSProperties["gridTemplateColumns"] =
  GRID_COLS_PX.map((n) => `${n}px`).join(" ");
const TABLE_MIN_PX = GRID_COLS_PX.reduce((a, b) => a + b, 0);
const TABLE_ROW_PX = 40;
const TABLE_ROW_COUNT = 12;

const SONG_LIST_ENDPOINT = "/api/song";

type SortDir = "asc" | "desc";

export default function HomeClient(): React.ReactElement {
  // Data/state
  const [rows, setRows] = React.useState<SongListItem[]>([]);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState("");

  // Sorting
  const [sort, setSort] = React.useState<SongColToken | null>(DEFAULT_SORT);
  const [sortDir, setSortDir] = React.useState<SortDir>(DEFAULT_DIR);

  // NEW: userId for the viewer tab
  const [viewerUserId, setViewerUserId] = React.useState<number | null>(null);

  // Fetch lifecycle
  const listAbortRef = React.useRef<AbortController | null>(null);
  const listSeqRef = React.useRef(0);

  // NEW: Load userId for viewer
  React.useEffect(() => {
    async function loadWho() {
      try {
        const res = await fetch("/api/whoami", {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) { return; }

        const json = await res.json();
        setViewerUserId(json.userId ?? null);
      } catch {
        setViewerUserId(null);
      }
    }
    loadWho();
  }, []);

  // Fetch song list
  const refreshSongList = React.useCallback(
    async (
      overrideSort?: SongColToken | null,
      overrideDir?: SortDir,
      showSpinner: boolean = true
    ): Promise<void> => {
      setListError("");
      if (showSpinner) { setListLoading(true); }

      if (listAbortRef.current !== null) { listAbortRef.current.abort(); }

      const controller = new AbortController();
      listAbortRef.current = controller;
      const seq = listSeqRef.current + 1;
      listSeqRef.current = seq;

      try {
        const effSort = overrideSort ?? sort;
        const effDir: SortDir = overrideDir ?? sortDir;

        const data = await fetchSongList(
          SONG_LIST_ENDPOINT,
          effSort,
          effDir,
          controller.signal
        );

        if (seq !== listSeqRef.current) { return; }

        setRows(data);
      } catch (e: unknown) {
        const name = (e as { name?: string } | null)?.name ?? "";
        if (name !== "AbortError") {
          setListError(e instanceof Error ? e.message : String(e));
          setRows([]);
        }
      } finally {
        if (seq === listSeqRef.current) { setListLoading(false); }
      }
    },
    [sort, sortDir]
  );

  // Initial list load
  React.useEffect(() => {
    void refreshSongList();
    return () => {
      if (listAbortRef.current !== null) { listAbortRef.current.abort(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSort = (key: SongColToken): void => {
    const nextDir: SortDir =
      sort === key ? (sortDir === "asc" ? "desc" : "asc") : "asc";
    setSort(key);
    setSortDir(nextDir);
    void refreshSongList(key, nextDir);
  };

  // NEW: open viewer with uid=userId GET param
  const openInNewTab = (id: number): void => {
    const tabId = Date.now().toString(36);
    const uid = viewerUserId ?? "";
    window.open(
      `/viewer?tab=${tabId}&id=${id}&uid=${uid}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  return (
    <section>
      <AuthHeaderClient title="Music Portal" />

      <SongListPanel
        rows={rows}
        listLoading={listLoading}
        listError={listError}
        sort={sort}
        sortDir={sortDir}
        onToggleSort={toggleSort}
        onRowClick={(row) => openInNewTab(row.song_id)}
        gridCols={GRID_COLS}
        tableMinPx={TABLE_MIN_PX}
        rowPx={TABLE_ROW_PX}
        visibleRowCount={TABLE_ROW_COUNT}
      />
    </section>
  );
}
