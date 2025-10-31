// src/components/SongListPanel.tsx
"use client";

import React from "react";
import { SONG_COL, type SongColToken } from "@/lib/songCols";
import type { SongListItem } from "@/lib/types";
import SortHeaderButton from "@/components/common/SortHeaderButton";
import panelCss from "./SongListPanel.module.css";

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

    // Row interaction
    onRowClick(row: SongListItem): void;

    // Layout
    gridCols: React.CSSProperties["gridTemplateColumns"]; // "170px 170px 380px 90px"
    tableMinPx: number;                                   // sum of column widths
    rowPx: number;                                        // e.g., 40
    visibleRowCount: number;                              // e.g., 12
};

export default function SongListPanel(props: Props): React.ReactElement {
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

    const bodyPx = rowPx * visibleRowCount;

    // Normalize numeric sizes to px strings so SSR/CSR match exactly
    const tableMinCss = `${tableMinPx}px`;
    const bodyCss = `${bodyPx}px`;
    const rowHeightCss = `${rowPx}px`;

    return (
        <section aria-label="Songs">
            {/* Inline status line, but keep the table mounted */}
            {listError && (
                <p style={{ color: "#ff6b6b", margin: "4px 0 8px" }}>
                    Error: {listError}
                </p>
            )}

            {/* Outer safety wrapper: keeps layout tidy on narrow screens */}
            <div
                style={{
                    width: "100%",
                    maxWidth: "960px",    // cap the card area
                    margin: "0 auto",     // center within page
                    overflowX: "auto",    // allow horizontal scroll if needed
                    WebkitOverflowScrolling: "touch",
                }}
            >
                <div
                    className={panelCss.card}
                    style={{
                        position: "relative",
                        minWidth: tableMinCss,
                        width: tableMinCss,
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

                    {/* Header */}
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
                    </div>

                    {/* Body: fixed height, scrollbar only when needed */}
                    <div
                        style={{
                            height: bodyCss, // "Npx"
                            overflowY: rows.length > visibleRowCount ? "auto" : "hidden",
                            overflowX: "hidden",
                            borderTop: "1px solid var(--border)",
                            opacity: listLoading ? 0.7 : 1,
                            transition: "opacity 120ms linear",
                        }}
                        aria-busy={listLoading}
                    >
                        {/* Data rows */}
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
                                        minWidth: tableMinCss, // lock min size
                                        width: "100%",        // fill available width
                                        height: rowHeightCss,
                                        lineHeight: `${rowPx - 10}px`,
                                    }}
                                    title="Open in a new tab"
                                >
                                    <div className={panelCss.cellEllipsis}>
                                        {r.composer_first_name || "\u2014"}
                                    </div>
                                    <div className={panelCss.cellEllipsis}>
                                        {r.composer_last_name || "\u2014"}
                                    </div>
                                    <div className={panelCss.cellEllipsis}>
                                        {r.song_title}
                                    </div>
                                    <div>{r.skill_level_name}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}
