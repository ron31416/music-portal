// src/components/AdminSongEditPanel.tsx
"use client";

import React from "react";

type Level = { number: number; name: string };
type TokenMap = Readonly<Record<string, string | number>>;

export type AdminSongEditPanelProps = {
    // Values (controlled)
    title: string;
    composerFirst: string;
    composerLast: string;
    level: string; // selected level_number as string
    levels: ReadonlyArray<Level>;
    levelsLoading: boolean;
    levelsError: string;
    fileName: string;
    xml: string;
    xmlLoading: boolean;
    parsing: boolean;
    errorText: string;
    saveOkText: string;
    statusTick: number;

    // Computed enables/labels
    canSave: boolean;
    saveLabel: string;
    canView: boolean;
    canDelete: boolean;
    deleting: boolean;

    // Handlers
    onChangeTitle(value: string): void;
    onChangeComposerFirst(value: string): void;
    onChangeComposerLast(value: string): void;
    onChangeLevel(value: string): void;
    onChangeXml(value: string): void;
    onPick: React.ChangeEventHandler<HTMLInputElement>;
    onSave(): void;
    onOpenViewer(): void;
    onDelete(): void;

    // Refs (nullable/optional)
    fileInputRef?: React.RefObject<HTMLInputElement | null> | null;

    // Theming / layout (optional)
    T?: TokenMap;
    fieldCss?: React.CSSProperties | string;
    isDark?: boolean;
    xmlPreviewHeight?: number;
};

function makeFallbackTokens(isDark: boolean): TokenMap {
    return isDark
        ? { border: "#30363d", bgCard: "#0f1115", fgCard: "#e5e7eb", headerFg: "#9ca3af" }
        : { border: "#e5e7eb", bgCard: "#fafafa", fgCard: "#111111", headerFg: "#374151" };
}

function normalizeFieldStyle(
    fieldCss: React.CSSProperties | string | undefined,
    isDark: boolean,
    T: TokenMap
): React.CSSProperties {
    if (fieldCss && typeof fieldCss === "object") return fieldCss;
    return {
        width: "100%",
        padding: "6px 8px",
        border: `1px solid ${String(T.border)}`,
        borderRadius: 6,
        background: isDark ? "#1f1f1f" : "#ffffff",
        color: isDark ? "#ffffff" : "#111111",
        outline: "none",
        fontSize: 14,
        lineHeight: 1.35,
    };
}

const AdminSongEditPanel: React.FC<AdminSongEditPanelProps> = (props) => {
    const {
        title, composerFirst, composerLast, level, levels, levelsLoading, levelsError,
        fileName, xml, xmlLoading, parsing, errorText, saveOkText, statusTick,
        canSave, saveLabel, canView, canDelete, deleting,
        onChangeTitle, onChangeComposerFirst, onChangeComposerLast, onChangeLevel,
        onChangeXml, onPick, onSave, onOpenViewer, onDelete,
        fileInputRef,
        T: maybeTokens, fieldCss, isDark = false, xmlPreviewHeight = 200,
    } = props;

    // Avoid SSR/CSR attr mismatch
    const [hydrated, setHydrated] = React.useState(false);
    React.useEffect(() => { setHydrated(true); }, []);

    const T = React.useMemo<TokenMap>(() => {
        const fb = makeFallbackTokens(isDark);
        if (!maybeTokens) return fb;
        return {
            border: (maybeTokens.border ?? fb.border) as string | number,
            bgCard: (maybeTokens.bgCard ?? fb.bgCard) as string | number,
            fgCard: (maybeTokens.fgCard ?? fb.fgCard) as string | number,
            headerFg: (maybeTokens.headerFg ?? fb.headerFg) as string | number,
        };
    }, [maybeTokens, isDark]);

    const fieldCssObj = React.useMemo(
        () => normalizeFieldStyle(fieldCss, isDark, T),
        [fieldCss, isDark, T]
    );

    const themeAttr = hydrated ? (isDark ? "dark" : "light") : undefined;

    return (
        <section aria-label="Edit panel" style={{ marginTop: 8, background: "transparent" }}>
            <div
                id="edit-card"
                data-theme={themeAttr}
                style={{
                    padding: 16,
                    border: `1px solid ${String(T.border)}`,
                    borderRadius: 8,
                    background: String(T.bgCard),
                    color: String(T.fgCard),
                }}
            >
                <div
                    style={{
                        marginTop: 0,
                        display: "grid",
                        gridTemplateColumns: "120px 1fr",
                        rowGap: 10,
                        columnGap: 12,
                        background: "transparent",
                    }}
                >
                    <label style={{ alignSelf: "center", fontWeight: 600 }}>Song Title</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => { onChangeTitle(e.target.value); }}
                        style={fieldCssObj}
                    />

                    <label style={{ alignSelf: "center", fontWeight: 600 }}>Composer</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input
                            type="text"
                            value={composerFirst}
                            onChange={(e) => { onChangeComposerFirst(e.target.value); }}
                            placeholder="First"
                            style={fieldCssObj}
                        />
                        <input
                            type="text"
                            value={composerLast}
                            onChange={(e) => { onChangeComposerLast(e.target.value); }}
                            placeholder="Last"
                            style={fieldCssObj}
                        />
                    </div>

                    <label style={{ alignSelf: "center", fontWeight: 600 }}>Skill Level</label>
                    <select
                        value={level}
                        onChange={(e) => { onChangeLevel(e.target.value); }}
                        disabled={levelsLoading || (levelsError.length > 0) || levels.length === 0}
                        style={{ ...fieldCssObj, appearance: "auto" as const }}
                    >
                        <option value="" disabled>— Select a level —</option>
                        {levels.map((lvl) => (
                            <option key={lvl.number} value={String(lvl.number)}>
                                {lvl.name}
                            </option>
                        ))}
                    </select>

                    {levelsError && (
                        <div style={{ gridColumn: "1 / span 2", color: "#b00020" }}>
                            Failed to load skill levels: {levelsError}
                        </div>
                    )}

                    <label style={{ alignSelf: "center", fontWeight: 600 }}>File Name</label>
                    <input type="text" value={fileName} readOnly style={fieldCssObj} />

                    <label style={{ alignSelf: "start", fontWeight: 600, paddingTop: 6 }}>MusicXML</label>
                    <textarea
                        aria-label="XML"
                        value={xml}
                        onChange={(e) => { onChangeXml(e.target.value); }}
                        spellCheck={false}
                        style={{
                            ...fieldCssObj,
                            width: "100%",
                            margin: 0,
                            minHeight: xmlPreviewHeight,
                            maxHeight: xmlPreviewHeight,
                            overflow: "auto",
                            resize: "vertical",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                            fontSize: 13,
                            lineHeight: 1.4,
                        }}
                    />
                </div>

                <div
                    style={{
                        marginTop: 16,
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                    }}
                >
                    <input
                        ref={fileInputRef ?? undefined}
                        id="song-file-input"
                        type="file"
                        accept=".mxl,.musicxml,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml,application/zip"
                        onChange={onPick}
                        style={{ display: "none" }}
                    />

                    <button
                        type="button"
                        onClick={() => { const el = fileInputRef?.current; if (el) el.click(); }}
                        style={{
                            padding: "8px 12px",
                            border: `1px solid ${String(T.border)}`,
                            borderRadius: 6,
                            background: isDark ? "#1f1f1f" : "#fafafa",
                            color: isDark ? "#fff" : "#111",
                            cursor: "pointer",
                        }}
                    >
                        Load Song
                    </button>

                    <button
                        type="button"
                        onClick={onOpenViewer}
                        disabled={!canView || xmlLoading}
                        style={{
                            padding: "8px 12px",
                            border: `1px solid ${String(T.border)}`,
                            borderRadius: 6,
                            background: isDark ? "#1f1f1f" : "#fafafa",
                            color: isDark ? "#fff" : "#111",
                            cursor: (!canView || xmlLoading) ? "not-allowed" : "pointer",
                            opacity: (!canView || xmlLoading) ? 0.5 : 1,
                        }}
                    >
                        View Song
                    </button>

                    <span
                        key={`status-${statusTick}`}
                        aria-live="polite"
                        role={parsing ? "status" : (errorText ? "alert" : (saveOkText ? "status" : undefined))}
                        title={parsing ? "Parsing…" : (errorText || saveOkText || "")}
                        style={{
                            flex: 1,
                            minWidth: 0,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            textAlign: "center",
                            color: parsing ? (isDark ? "#ccc" : "#555") : (errorText ? "#ff6b6b" : String(T.headerFg)),
                            fontWeight: 500,
                            margin: 0,
                            visibility: (parsing || errorText || saveOkText) ? "visible" : "hidden",
                        }}
                    >
                        {parsing ? "Parsing…" : (errorText || saveOkText || "")}
                    </span>

                    <button
                        type="button"
                        onClick={onSave}
                        disabled={!canSave}
                        style={{
                            padding: "8px 12px",
                            border: `1px solid ${String(T.border)}`,
                            borderRadius: 6,
                            background: isDark ? "#1f1f1f" : "#fafafa",
                            color: isDark ? "#fff" : "#111",
                            cursor: canSave ? "pointer" : "not-allowed",
                            opacity: canSave ? 1 : 0.5,
                        }}
                    >
                        {saveLabel}
                    </button>

                    <button
                        type="button"
                        onClick={onDelete}
                        disabled={!canDelete}
                        title={canDelete ? "Delete this song permanently" : "Delete unavailable"}
                        style={{
                            padding: "8px 12px",
                            border: `1px solid ${String(T.border)}`,
                            borderRadius: 6,
                            background: isDark ? "#1f1f1f" : "#fafafa",
                            color: isDark ? "#fff" : "#111",
                            cursor: canDelete ? "pointer" : "not-allowed",
                            opacity: canDelete ? 1 : 0.5,
                        }}
                    >
                        {deleting ? "Deleting…" : "Delete Song"}
                    </button>
                </div>
            </div>
        </section>
    );
};

export default AdminSongEditPanel;
