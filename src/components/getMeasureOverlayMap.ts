// src/viewer/getMeasureOverlayMap.ts
// v3: Compatible with strictNullChecks + noUncheckedIndexedAccess + exactOptionalPropertyTypes

export type MeasureId = number | string;

export interface Rect {
    x: number; // viewer/layout coordinate space
    y: number;
    w: number;
    h: number;
}

export interface MeasureOverlayInfo {
    measureId: MeasureId;
    bbox: Rect;         // unified rect covering both staves + whitespace
    systemIndex: number;
}

export type MeasureOverlayMap = Record<string, MeasureOverlayInfo>;

// ---- Loose input contracts (all fields optional-friendly) ----
export interface LayoutStaffRectLike {
    x?: number | null;
    y?: number | null;
    width?: number | null;
    height?: number | null;
}

export interface LayoutMeasureLike {
    globalIndex?: number | null;
    uid?: string | null;
    staffRects?: LayoutStaffRectLike[] | null;
}

export interface LayoutSystemLike {
    systemIndex?: number | null;
    measures?: LayoutMeasureLike[] | null;
}

export interface ProcessedLayoutLike {
    systems?: LayoutSystemLike[] | null;
}

// ---- Type guards & helpers ----
function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function toRectMaybe(rLike: LayoutStaffRectLike | null | undefined): Rect | null {
    if (!rLike) { return null; }
    const { x, y, width, height } = rLike;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
        return null;
    }
    if (width <= 0 || height <= 0) { return null; }
    return { x, y, w: width, h: height };
}

function unionRects(rects: ReadonlyArray<Rect>): Rect {
    // Defensive: handle 1+ rects without indexing (supports noUncheckedIndexedAccess)
    let minX: number | null = null;
    let minY: number | null = null;
    let maxX: number | null = null;
    let maxY: number | null = null;

    for (const r of rects) {
        const rx2 = r.x + r.w;
        const ry2 = r.y + r.h;

        minX = minX === null ? r.x : (r.x < minX ? r.x : minX);
        minY = minY === null ? r.y : (r.y < minY ? r.y : minY);
        maxX = maxX === null ? rx2 : (rx2 > maxX ? rx2 : maxX);
        maxY = maxY === null ? ry2 : (ry2 > maxY ? ry2 : maxY);
    }

    // By construction rects is 1+, so these are set.
    // Narrow with non-null check instead of assertion for TS.
    if (minX === null || minY === null || maxX === null || maxY === null) {
        // Should never happen; return a harmless zero rect if it does.
        return { x: 0, y: 0, w: 0, h: 0 };
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function firstRect(rects: ReadonlyArray<Rect>): Rect {
    // rects is guaranteed non-empty by caller; avoid indexed access for noUncheckedIndexedAccess
    for (const r of rects) {
        return r;
    }
    // Absolute fallback; should be unreachable.
    return { x: 0, y: 0, w: 0, h: 0 };
}

function deriveMeasureId(m: LayoutMeasureLike, fallbackSeed: number): MeasureId {
    if (isFiniteNumber(m.globalIndex)) { return m.globalIndex; }
    if (typeof m.uid === "string" && m.uid.length > 0) { return m.uid; }
    return `measure-${fallbackSeed}`;
}

// ---- Public API ----
export function getMeasureOverlayMap(layout: ProcessedLayoutLike): MeasureOverlayMap {
    const out: MeasureOverlayMap = {};

    const systemsSrc = Array.isArray(layout.systems) ? layout.systems : [];

    let sysIdx = 0;
    for (const sysMaybe of systemsSrc) {
        const sys = sysMaybe ?? {};
        const measuresSrc = Array.isArray(sys.measures) ? sys.measures : [];
        const systemIndex: number = isFiniteNumber(sys.systemIndex) ? sys.systemIndex! : sysIdx;

        let mIdx = 0;
        for (const mMaybe of measuresSrc) {
            const m = mMaybe ?? {};

            // Collect valid staff rects without indexing
            const rects: Rect[] = [];
            const staffSrc = Array.isArray(m.staffRects) ? m.staffRects : [];
            for (const rLike of staffSrc) {
                const rr = toRectMaybe(rLike);
                if (rr) { rects.push(rr); }
            }

            if (rects.length === 0) {
                mIdx++;
                continue;
            }

            const unified: Rect = rects.length === 1 ? firstRect(rects) : unionRects(rects);
            const measureId = deriveMeasureId(m, mIdx);
            const key = String(measureId);

            out[key] = {
                measureId,
                bbox: unified,
                systemIndex,
            };

            mIdx++;
        }

        sysIdx++;
    }

    return out;
}

/* ---------- Optional strict adapter ----------
export interface StrictLayoutStaffRect { x: number; y: number; width: number; height: number; }
export interface StrictLayoutMeasure { globalIndex?: number; uid?: string; staffRects: StrictLayoutStaffRect[]; }
export interface StrictLayoutSystem { systemIndex: number; measures: StrictLayoutMeasure[]; }
export interface StrictProcessedLayout { systems: StrictLayoutSystem[]; }

export function getMeasureOverlayMapStrict(strict: StrictProcessedLayout): MeasureOverlayMap {
  const loose: ProcessedLayoutLike = {
    systems: strict.systems.map(s => ({
      systemIndex: s.systemIndex,
      measures: s.measures.map(m => ({
        globalIndex: m.globalIndex ?? null,
        uid: m.uid ?? null,
        staffRects: m.staffRects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
      })),
    })),
  };
  return getMeasureOverlayMap(loose);
}
*/
