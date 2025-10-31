// src/components/admin/AdminSongListPanel.tsx
"use client";

import React from "react";
import { SONG_COL, type SongColToken } from "@/lib/songCols";
import type { SongListItem } from "@/lib/types";
import SortHeaderButton from "@/components/common/SortHeaderButton";
import panelCss from "./AdminSongListPanel.module.css";

type SortDir = "asc" | "desc";

type Props = {
    // Data & status
    rows: ReadonlyArray<SongListItem>;
    listLoading: boolean;
    listError: string;

    // Sorting (server-side only)
    sort: SongColToken | null;
    sortDir: SortDir;
    onToggleSort(col: SongColToken): void;

    // Row selection
    onRowClick(row: SongListItem): void;

    // Layout (kept identical to Admin page constants)
    gridCols: React.CSSProperties["gridTemplateColumns"];
    tableMinPx: number;
    rowPx: number;
    visibleRowCount: number;
};

export default function AdminSongListPanel(props: Props): React.ReactElement {
    const {
        rows,
        listLoading,
        listError,
        sort,
        sortDir,
        onToggleSort,
        onRowClick,
        gridCols,
        tableMinPx,
        rowPx,
        visibleRowCount,
    } = props;

    // Normalize numbers → px strings for SSR/CSR parity
    const tableMinCss = `${tableMinPx}px`;
    const bodyCss = `${rowPx * visibleRowCount}px`;
    const rowHeightCss = `${rowPx}px`;

    return (
        <section aria-label="Songs" style={{ marginTop: 0 }}>
            {listError && (
                <p style={{ color: "#ff6b6b", margin: "4px 0 8px" }}>
                    Error: {listError}
                </p>
            )}

            {/* Outer wrapper keeps layout tidy on narrow screens */}
            <div
                style={{
                    width: "100%",
                    maxWidth: "960px",
                    margin: "0 auto",
                    overflowX: "auto",
                    WebkitOverflowScrolling: "touch",
                }}
            >
                <div
                    className={panelCss.card}
                    style={{
                        position: "relative",
                        minWidth: tableMinCss,  // grid can't shrink below total columns
                        width: tableMinCss,     // horizontal scroll kicks in when viewport < min
                        margin: "0 auto",
                        overflowX: "hidden",
                        overflowY: "hidden",
                    }}
                >
                    {/* Loader overlay that does not collapse layout */}
                    {listLoading && (
                        <div
                            aria-hidden="true"
                            style={{
                                position: "absolute",
                                inset: 0,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                backdropFilter: "blur(1px)",
                                pointerEvents: "none",
                            }}
                        >
                            <p className={panelCss.loadingText}>Loading…</p>
                        </div>
                    )}

                    {/* Header row */}
                    <div
                        id="songs-header"
                        className={panelCss.header}
                        style={{
                            gridTemplateColumns: gridCols,
                            minWidth: tableMinCss,
                            width: "100%",
                            opacity: listLoading ? 0.7 : 1,
                        }}
                    >
                        <SortHeaderButton<SongColToken>
                            col={SONG_COL.composerFirstName}
                            curSort={sort}
                            dir={sortDir}
                            onToggle={onToggleSort}
                            label="Composer First"
                        />
                        <SortHeaderButton<SongColToken>
                            col={SONG_COL.composerLastName}
                            curSort={sort}
                            dir={sortDir}
                            onToggle={onToggleSort}
                            label="Composer Last"
                        />
                        <SortHeaderButton<SongColToken>
                            col={SONG_COL.songTitle}
                            curSort={sort}
                            dir={sortDir}
                            onToggle={onToggleSort}
                            label="Song Title"
                        />
                        <SortHeaderButton<SongColToken>
                            col={SONG_COL.skillLevelNumber}
                            curSort={sort}
                            dir={sortDir}
                            onToggle={onToggleSort}
                            label="Skill Level"
                        />
                        <SortHeaderButton<SongColToken>
                            col={SONG_COL.fileName}
                            curSort={sort}
                            dir={sortDir}
                            onToggle={onToggleSort}
                            label="File Name"
                        />
                    </div>

                    {/* Body section */}
                    <div
                        style={{
                            height: bodyCss,
                            overflowY: rows.length > visibleRowCount ? "auto" : "hidden",
                            overflowX: "hidden",
                            borderTop: "1px solid var(--border)",
                            opacity: listLoading ? 0.7 : 1,
                            transition: "opacity 120ms linear",
                        }}
                        aria-busy={listLoading}
                    >
                        {rows.map((r, idx) => {
                            const rowClass = idx % 2 === 0 ? panelCss.rowEven : panelCss.rowOdd;
                            return (
                                <div
                                    key={r.song_id}
                                    onClick={() => { onRowClick(r); }}
                                    onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            onRowClick(r);
                                        }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    className={`${panelCss.row} ${rowClass}`}
                                    style={{
                                        gridTemplateColumns: gridCols,
                                        minWidth: tableMinCss,
                                        width: "100%",
                                        height: rowHeightCss,
                                        lineHeight: `${rowPx - 10}px`,
                                    }}
                                    title="Load for edit"
                                >
                                    <div className={panelCss.cellEllipsis}>
                                        {r.composer_first_name || "\u2014"}
                                    </div>
                                    <div className={panelCss.cellEllipsis}>
                                        {r.composer_last_name || "\u2014"}
                                    </div>
                                    <div className={panelCss.cellEllipsis}>{r.song_title}</div>
                                    <div>{r.skill_level_name}</div>
                                    <div className={panelCss.cellEllipsis}>
                                        {r.file_name || "\u2014"}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}
