// src/components/ScoreViewer.tsx 
"use client";

// NAV: -----------------imports

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { useAnnotations } from "@/components/AnnotationsProvider";
import type {
  AnnotationPayload,
  AnnotationItem,
  AnnotationFingeringItem,
  AnnotationTextItem,
  AnnotationPedalItem,
  FingeringAnchorRef,
  TextAnchorRef,
  TextAnchorMode,
  PedalAnchorRef,
  AnnotationMap,
} from "@/components/AnnotationsProvider";


// NAV: -----------------types

// Extend the Window type without using `any`
declare global {
  interface Window {
    debugShowMeasurePreview?: (x: number, y: number, w: number, h: number) => void;
  }
}

interface Band { top: number; bottom: number; height: number }

// Viewer-space rectangle (left/top/width/height in px, relative to wrapper host)
interface Rect { x: number; y: number; w: number; h: number }

// Type: function stored in a ref
type ReflowCallback = () => Promise<void>;

type RectPx = {
  x: number;
  y: number;
  w: number;
  h: number;
};

// Module-scope: shared by scan phase and drawMeasureBoxes
type BarCand = {
  el: SVGGraphicsElement;
  bb: { x: number; y: number; width: number; height: number }; // page-local px (pre-translate)
  thin: boolean;
  yTop: number;  // page-local (pre-translate)
  yBot: number;  // page-local (pre-translate)
  hinted: boolean;
};

// Cached geometry per measure (pre-translate, page-local px)
type MeasureInterval = { left: number; right: number };

type MeasureGeom = {
  id: string;              // measure id (e.g., "measure-12")
  tileIndex: number;       // system index this measure belongs to
  interval: MeasureInterval; // horizontal span from barlines
  top: number;             // vertical extent (px, pre-translate)
  bottom: number;          // vertical extent (px, pre-translate)
};

type MeasureBoxRect = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // 1-based OSMD measure number, or -1 if we couldn't parse one
  measureNumber: number;
};

// ===== Measure preview popup state =====
type SimpleRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

// Normalized point inside a measure box (0..1 in both directions)
type PointRel = {
  xRel: number;
  yRel: number;
};

// One rendered glyph (notehead, rest, etc.) in page-local coordinates
type GlyphRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  glyphTag?: string;   // renamed from debug
};

type NoteAnchorKind = "note" | "rest" | "unknown";

type NoteAnchor = {
  id: string;   // stable within a measure, e.g. "n0", "n1"
  x: number;    // notehead center X (page-local px)
  y: number;    // notehead center Y (page-local px)
  w: number;    // notehead width
  h: number;    // notehead height
  kind: NoteAnchorKind;
  confidence: number; // 0..1

  // DIAG (optional)
  glyphTag: string;
  tallRatio: number;
  aspect: number;
  area: number;
};

// We use the shared payload directly from AnnotationsProvider.
type MeasureAnnotation = AnnotationPayload;

// drawAnnotationBoxes just needs whatever the provider returns.
type GetAnnotationsForMeasure = (
  measureNumber: number
) => MeasureAnnotation | undefined;

type PedalEndpointKey = {
  measureNumber: number; // 1-based
  noteId: string;        // "n0", "n1", ...
  dxRel: number;         // units of noteH
};

type PedalMark = {
  start: PedalEndpointKey;
  end: PedalEndpointKey;
};

type PedalMarkIndex = {
  marks: PedalMark[];
  byStartKey: Map<string, PedalMark>;
};

// Props for the score viewer; currently just the song source ID.
interface Props {
  src: string;
}


// NAV: -----------------constants

// Central pagination/masking knobs (tuned for Hi/Lo DPR). Change here, not inline.
const REFLOW = {
  // Width used for OSMD's layout (computed from container width / zoom, then clamped)
  MIN_LAYOUT_W: 320,
  MAX_LAYOUT_W: 1600,
  WIDTH_NUDGE: -1,           // small bias to avoid edge-case layouts

  // Pagination height slop: lets us fill the page slightly past the visible height
  PAGE_FILL_SLOP_PX: 8,

  // Masking/peek guards between pages (don’t usually need to touch)
  MASK_BOTTOM_SAFETY_PX: 14,

  // Fixed bottom cutter padding
  BOTTOM_PEEK_PAD_LO_DPR: 5,
  BOTTOM_PEEK_PAD_HI_DPR: 6,

  // base headroom for both system bands and measure boxes
  PAD_PX_BASE: 12
} as const;

// Annotation handle geometry (caret-style)
//
// All measurements in px. These define the visual shape and also the math
// that maps finger position → caret tip (the true annotation point).
const HANDLE_STEM_WIDTH = 40;       // width of the draggable “pill”
const HANDLE_STEM_HEIGHT = 40;      // height of the draggable stem
const HANDLE_TIP_WIDTH = 10;        // half-width of the triangle at the base
const HANDLE_TIP_HEIGHT = 20;       // height of the triangle tip
//const HANDLE_BORDER_RADIUS = 9999;

// How close we allow the caret tip to get to a glyph, in px.
const AVOID_GLYPH_MARGIN_PX = 4;

// URL flags (read once at module import; change URL + Reload to apply)
const URL_LOG = readDebugFlag("log", false);
const URL_DIAG = readDebugFlag("diag", false);

// Effective switches: pagination diag implies logging
const isLogOn = () => URL_LOG || URL_DIAG;
const isDiagOn = () => URL_DIAG;

const SHOW_NOTEHEAD_EXCLUSION_DIAG = false;
const SHOW_ANCHOR_TAGS = false;


// NAV: -----------------helper functions

// Expand a rect by `margin` in all directions and test if (x, y) is inside.
// NAV: function pointHitsRectWithMargin
function pointHitsRectWithMargin(x: number, y: number, rect: RectPx, margin: number): boolean {
  const left = rect.x - margin;
  const right = rect.x + rect.w + margin;
  const top = rect.y - margin;
  const bottom = rect.y + rect.h + margin;

  if (x < left) {
    return false;
  }
  if (x > right) {
    return false;
  }
  if (y < top) {
    return false;
  }
  if (y > bottom) {
    return false;
  }
  return true;
}

// NAV: function pointHitsAnyRectWithMargin
function pointHitsAnyRectWithMargin(
  x: number,
  y: number,
  rects: readonly RectPx[],
  margin: number,
): boolean {
  for (const rect of rects) {
    if (pointHitsRectWithMargin(x, y, rect, margin)) {
      return true;
    }
  }
  return false;
}

// NAV: function buildPedalMarkIndex
function buildPedalMarkIndex(map: AnnotationMap): PedalMarkIndex {
  const marks: PedalMark[] = [];
  const byStartKey = new Map<string, PedalMark>();

  // Measures sorted numerically
  const measureNumbers = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  let openStart: PedalEndpointKey | null = null;

  // Diagnostics
  let missingXRelCount = 0;
  let boundaryItemCount = 0;

  for (const measureNumber of measureNumbers) {
    const payload = map[measureNumber];
    const items = Array.isArray(payload?.items) ? payload!.items : [];

    // Collect pedal boundary items for this measure and sort them.
    type PedalBoundary = {
      item: AnnotationPedalItem;
      index: number;        // original array index (stable tiebreak)
      xRel: number | null;  // endpoint x position in measure, if present
      hasLeft: boolean;
      hasRight: boolean;
    };

    const boundaries: PedalBoundary[] = [];

    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      if (!raw || raw.kind !== "pedal") {
        continue;
      }

      const item = raw as AnnotationPedalItem;
      const hasLeft = !!item.left;
      const hasRight = !!item.right;

      // Active-only (no endpoints) doesn’t affect the global index.
      if (!hasLeft && !hasRight) {
        continue;
      }

      boundaryItemCount++;

      // Prefer left endpoint for xRel when present; otherwise use right endpoint.
      // (Single-measure left+right items will sort by left.xRel, as desired.)
      const endpointXRel =
        (hasLeft ? item.left?.xRel : undefined) ??
        (hasRight ? item.right?.xRel : undefined) ??
        null;

      const hasXRel =
        typeof endpointXRel === "number" &&
        Number.isFinite(endpointXRel);

      if (!hasXRel) {
        missingXRelCount++;
      }

      boundaries.push({
        item,
        index: i,
        xRel: hasXRel ? (endpointXRel as number) : null,
        hasLeft,
        hasRight,
      });
    }

    // Sort boundaries by xRel if present; otherwise keep stable by original index.
    boundaries.sort((a, b) => {
      // Items with an explicit xRel come first (so legacy items don’t scramble things)
      if (a.xRel !== null && b.xRel === null) {
        return -1;
      }
      if (a.xRel === null && b.xRel !== null) {
        return 1;
      }

      // Both have xRel → numeric sort
      if (a.xRel !== null && b.xRel !== null) {
        if (a.xRel !== b.xRel) {
          return a.xRel - b.xRel;
        }
        // tie-break: stable
        return a.index - b.index;
      }

      // Neither has xRel → preserve array order
      return a.index - b.index;
    });

    // Now process this measure’s pedal boundary items in sorted order.
    for (const entry of boundaries) {
      const item = entry.item;
      const hasLeft = entry.hasLeft;
      const hasRight = entry.hasRight;

      // If an item has both ends in one measure, treat it as a single-measure pedal mark.
      if (hasLeft && hasRight) {
        if (openStart !== null) {
          console.warn(
            "[pedal-index] Unexpected: openStart exists but found pedal with both left+right",
            { openStart, measureNumber }
          );
          // We do not guess; abandon pairing.
          openStart = null;
        }

        const start = endpointFromPedalAnchor(measureNumber, item.left!);
        const end = endpointFromPedalAnchor(measureNumber, item.right!);

        const mark: PedalMark = { start, end };
        marks.push(mark);
        byStartKey.set(pedalEndpointKeyToString(start), mark);
        continue;
      }

      if (hasLeft) {
        if (openStart !== null) {
          console.warn(
            "[pedal-index] Overlap/nesting detected (left encountered while a mark is already open).",
            { openStart, newLeftMeasure: measureNumber, newLeft: item.left }
          );
          // Overlap is forbidden → drop the old open mark.
          openStart = null;
        }

        openStart = endpointFromPedalAnchor(measureNumber, item.left!);
        continue;
      }

      if (hasRight) {
        if (openStart === null) {
          console.warn("[pedal-index] Unmatched right endpoint (no open start).", {
            measureNumber,
            right: item.right,
          });
          continue;
        }

        const end = endpointFromPedalAnchor(measureNumber, item.right!);
        const mark: PedalMark = { start: openStart, end };
        marks.push(mark);
        byStartKey.set(pedalEndpointKeyToString(openStart), mark);
        openStart = null;
        continue;
      }
    }
  }

  if (openStart !== null) {
    console.warn("[pedal-index] Unterminated pedal mark (start found but no end).", { openStart });
  }

  // One compact diagnostic log so you can confirm it’s doing what you expect.
  if (isDiagOn()) {
    void logStep(
      `[pedal-index] rebuilt ` +
      `marks=${marks.length} ` +
      `boundaryItems=${boundaryItemCount} ` +
      `missingXRel=${missingXRelCount}`
    );
  }

  return { marks, byStartKey };
}

// NAV: function withTimeout
async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(tag)), ms);
    p.then(v => { window.clearTimeout(t); resolve(v); },
      e => { window.clearTimeout(t); reject(e); });
  });
}

// Await osmd.load(...) whether it returns void or a Promise.
// NAV: function loadOSMD
async function loadOSMD(
  osmd: OpenSheetMusicDisplay,
  input: string | Document | ArrayBuffer | Uint8Array
): Promise<void> {
  type LoadInput = string | Document | ArrayBuffer | Uint8Array;
  type OSMDHasLoad = { load: (i: LoadInput) => void | Promise<unknown> };

  const rules = osmd.EngravingRules;
  rules.MinSkyBottomDistBetweenSystems *= 1.3;  // give more headroom between systems

  if (isDiagOn()) {
    logStep(`OSMD rules.MinSkyBottomDistBetweenSystems: ${rules.MinSkyBottomDistBetweenSystems}`, {});
  }

  const o = osmd as unknown as OSMDHasLoad;
  await Promise.resolve(o.load(input));
}


// Instance-scoped afterPaint factory (safe for multiple components)
// NAV: function makeAfterPaint
function makeAfterPaint(outer: HTMLDivElement) {
  return function afterPaintLocal(label?: string, timeoutMs = 300): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const t0 =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();

      function finish(
        why: "raf" | "timeout" | "hidden" | "message" | "safety-tick" | "ceiling"
      ): void {
        if (done) { return; }
        done = true;
        try {
          // Keep lightweight breadcrumbs for debugging
          outer.dataset.viewerAfterpaint = `${label ?? ""}:${why}`;
          const now =
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();
          const ms = Math.round(now - t0);
          outer.dataset.viewerAfterpaintMs = String(ms);

          void logStep(`${label ?? ""} -> ${why} (${ms}ms)`, { outer, caller: label });
        } catch { }
        resolve();
      }
      try {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => finish("raf"));
        });
      } catch { }

      // Primary watchdog: if rendering takes longer than timeoutMs, force-finish
      window.setTimeout(() => finish("timeout"), timeoutMs);

      // Ceiling guard: absolute upper bound (4× timeout or 1200ms minimum)
      // prevents spinner from hanging forever in edge cases
      window.setTimeout(() => finish("ceiling"), Math.max(timeoutMs * 4, 1200));
    });
  };
}

// NAV: function getSvg
function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg");
}

// NAV: function withSvgAtUnitScale
function withSvgAtUnitScale<T>(outer: HTMLDivElement, fn: (svg: SVGSVGElement) => T): T | null {
  const svg = getSvg(outer);
  if (!svg) {
    return null;
  }
  const prev = svg.style.transform;
  const prevOrigin = svg.style.transformOrigin;
  svg.style.transform = "none";
  svg.style.transformOrigin = "top left";
  try {
    return fn(svg);
  } finally {
    svg.style.transform = prev;
    svg.style.transformOrigin = prevOrigin;
  }
}


// Best-effort "wait until the browser can paint" (bounded)
// NAV: function waitForPaint
async function waitForPaint(timeoutMs = 450): Promise<void> {
  try {
    await new Promise<void>(r => window.setTimeout(r, 0)); // macrotask
    if (document.visibilityState === 'visible') {
      await Promise.race([
        new Promise<void>(r =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() => r())
          )
        ),
        new Promise<void>(r => window.setTimeout(r, timeoutMs)),
      ]);
    }
  } catch { }
}


// URL-driven debug flags: #log or #diag 
// NAV: function readDebugFlag
function readDebugFlag(name: string, fallback = false): boolean {
  try {
    const read = (s: string) => {
      const params = new URLSearchParams(s);
      const v = params.get(name);
      if (v !== null) {
        const t = v.toLowerCase();
        return t === "" || t === "1" || t === "true" || t === "on" || t === "yes";
      }
      // also allow presence-only tokens in hash, e.g. "#log"
      const tokens = s.toLowerCase().split(/[&;,]/).map(x => x.trim());
      if (tokens.includes(name.toLowerCase())) { return true; }
      return null;
    };

    // prefer hash (doesn't cause navigations), then querystring
    const hash = typeof location !== "undefined" ? location.hash.replace(/^#/, "") : "";
    const qs = typeof location !== "undefined" ? location.search.replace(/^\?/, "") : "";

    const h = hash ? read(hash) : null;
    if (h !== null) { return h; }

    const q = qs ? read(qs) : null;
    if (q !== null) { return q; }
  } catch { }
  return fallback;
}

// NAV: function logStep
async function logStep(
  message: string,
  opts: { outer?: HTMLDivElement | null; caller?: string } = {}
): Promise<void> {
  if (!isLogOn()) { return; }

  const { outer = null, caller } = opts;

  // Fixed DevTools console column widths (tweak as needed)
  const CALLER_COL = 20;
  const FN_COL = 20;
  const PHASE_COL = 8;

  // Local helper: truncate to the column width and pad to that width.
  const pad = (s: string, w: number): string =>
    (s.length > w ? s.slice(0, w) : s).padEnd(w, " ");

  try {
    // Prefer provided wrapper; otherwise find our wrapper element by data attribute.
    let fn = "(none)";
    let phase = "(none)";
    const wrap: HTMLElement | null =
      outer ??
      (typeof document !== "undefined"
        ? document.querySelector<HTMLElement>('[data-viewer-wrapper="1"]')
        : null);

    if (wrap) {
      const df = wrap.dataset?.viewerFunc;
      const dp = wrap.dataset?.viewerPhase;
      if (typeof df === "string" && df.length > 0) { fn = df; }
      if (typeof dp === "string" && dp.length > 0) { phase = dp; }
    }

    // Always render all columns with fixed widths.
    const callerChunk = `[${pad(caller ?? "", CALLER_COL)}]`;
    const fnChunk = `[${pad(fn === "(none)" ? "" : fn, FN_COL)}]`;
    const phaseChunk = `[${pad(phase === "(none)" ? "" : phase, PHASE_COL)}]`;

    const composed = `${callerChunk} ${fnChunk} ${phaseChunk} ${message}`;

    // eslint-disable-next-line no-console
    console.log(composed);

    if (wrap) {
      wrap.dataset.viewerLastLog = `${Date.now()}:${composed.slice(0, 80)}`;
    }
  } catch { }
}

// NAV: function drawBandGuides
function drawBandGuides(
  svg: SVGSVGElement,
  bands: Band[],
  startIndex: number,
  nextStartIndex: number
): void {
  // ---- config
  const STROKE_W = 2; // even width -> draw on integer pixels
  const COLOR_TOP = "rgba(0,128,255,0.85)"; // blue
  const COLOR_BOT = "rgba(255,0,0,0.85)";   // red

  // remove old guides
  const olds = svg.querySelectorAll("[data-band-guides='1']");
  olds.forEach((n) => n.remove());

  if (!svg || bands.length === 0) { return; }

  // width in SVG coords
  const vb = svg.viewBox?.baseVal ?? null;
  const x1 = 0;
  const x2 = vb ? vb.width : (svg.width.baseVal?.value ?? 2000);

  // snap helper: odd stroke -> +0.5, even stroke -> +0
  const snapY = (y: number): number =>
    Math.round(y) + (STROKE_W % 2 === 1 ? 0.5 : 0);

  // container group
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("data-band-guides", "1");
  svg.appendChild(g);

  const first = Math.max(0, startIndex);
  const lastExclusive = nextStartIndex >= 0 ? nextStartIndex : bands.length;

  for (let i = first; i < lastExclusive; i++) {
    const b = bands[i];
    if (!b || typeof b.top !== "number" || typeof b.bottom !== "number") { continue; }

    // TOP (blue, solid) — snapped with stroke-aware rule
    const topY = snapY(b.top);
    const lt = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lt.setAttribute("x1", String(x1));
    lt.setAttribute("y1", String(topY));
    lt.setAttribute("x2", String(x2));
    lt.setAttribute("y2", String(topY));
    lt.setAttribute("stroke", COLOR_TOP);
    lt.setAttribute("stroke-width", String(STROKE_W));
    lt.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(lt);

    // BOTTOM (red, solid) — same snapping
    const botY = snapY(b.bottom);
    const lb = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lb.setAttribute("x1", String(x1));
    lb.setAttribute("y1", String(botY));
    lb.setAttribute("x2", String(x2));
    lb.setAttribute("y2", String(botY));
    lb.setAttribute("stroke", COLOR_BOT);
    lb.setAttribute("stroke-width", String(STROKE_W));
    lb.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(lb);

    // ---------- band index label ----------
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.textContent = String(i); // same index as logs

    // Small inset from left, slightly below the top line
    const LABEL_X = x1 + 8;
    const LABEL_Y = topY + 10;

    label.setAttribute("x", String(LABEL_X));
    label.setAttribute("y", String(LABEL_Y));
    label.setAttribute("fill", "black");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "monospace");
    label.setAttribute("pointer-events", "none");

    // Outline so it stays readable over notes
    label.setAttribute("paint-order", "stroke");
    label.setAttribute("stroke", "white");
    label.setAttribute("stroke-width", "2");

    g.appendChild(label);
  }
}


// Wait for web fonts to be ready (bounded; prevents rare long hangs)
// NAV: function waitForFonts
async function waitForFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      await Promise.race([
        fonts.ready,
        new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
      ]);
    }
  } catch { }
}


// Track the *visible* viewport height (accounts for mobile URL/tool bars)
// NAV: function useVisibleViewportHeight
function useVisibleViewportHeight() {
  const vpRef = useRef<number>(0);
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const update = () => {
      // prefer visualViewport when available, otherwise fall back to doc height
      const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
      const vvH = vv ? Math.floor(vv.height) : 0;
      const docH = Math.floor(document.documentElement?.clientHeight || 0);
      const h = (vvH && vvH > 0) ? vvH : docH;
      if (h && h !== vpRef.current) {
        vpRef.current = h;
        force();
      }
    };
    update();

    // visualViewport when present
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);

    // always also listen to window.resize (desktop / Safari / VV quirks)
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return vpRef; // latest visible height in px
}

// NAV: function dynamicBandGapPx
function dynamicBandGapPx(): number {
  // Tighten the merge threshold: only bridge true micro-gaps from rounding/jitter.
  const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
  // Old: 4/3. New: 2/1 keeps systems separate on cramped pages.
  return dpr >= 2 ? 2 : 1;
}

// NAV: function scanSystemsPx
function scanSystemsPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Band[] {
  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "scanSystemsPx";
  try {
    const hostTop = outer.getBoundingClientRect().top;

    interface Box { top: number; bottom: number; height: number; width: number }
    const boxes: Box[] = [];

    // Single-root: query graphics directly from the provided svgRoot.
    // (We previously iterated page roots, but scores we tested are a single big SVG.)
    const SELECTORS = "g,path,rect,line,polyline,polygon,text,use,circle,ellipse";
    const graphics = Array.from(svgRoot.querySelectorAll<SVGGraphicsElement>(SELECTORS));

    // Collect candidate boxes (no MIN_W / MIN_H gating — those skipped note stems).
    for (const el of graphics) {
      try {
        const r = el.getBoundingClientRect();
        if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) {
          continue;
        }

        boxes.push({
          top: r.top - hostTop,
          bottom: r.bottom - hostTop,
          height: r.height,
          width: r.width
        });
      } catch { }
    }

    boxes.sort((a, b) => a.top - b.top);

    // Merge boxes into bands using the dynamic packing gap threshold.
    const THRESH = dynamicBandGapPx();
    const bands: Band[] = [];
    for (const b of boxes) {
      const last = bands.length > 0 ? bands[bands.length - 1] : undefined;
      if (!last) {
        bands.push({
          top: b.top,
          bottom: b.bottom,
          height: b.height
        });
        continue;
      }

      // Integerize to kill sub-px wobbles; inclusive test complements THRESH choice.
      const gapPx = Math.floor(b.top) - Math.ceil(last.bottom);
      if (gapPx > THRESH) {
        bands.push({
          top: b.top,
          bottom: b.bottom,
          height: b.height
        });
      } else {
        last.top = Math.min(last.top, b.top);
        last.bottom = Math.max(last.bottom, b.bottom);
        last.height = last.bottom - last.top;
      }
    }

    void logStep(`bands: ${bands.length}`, { outer, caller: prevFuncTag });

    return bands;
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
  }
}

// Typed SVG factory (TS strict-friendly)
// NAV: function createSvgEl
function createSvgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  ns = "http://www.w3.org/2000/svg"
): SVGElementTagNameMap[K] {
  return document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
}

// Return a *new* Band[] whose top/bottom are expanded for annotation headroom.
// Pads are capped by the page gutters so we never ask for more space than exists.
// NAV: function derivePaddedBands
function derivePaddedBands(
  raw: Band[],
  topGutterPx: number,
  bottomGutterPx: number
): Band[] {
  const padTop = Math.min(REFLOW.PAD_PX_BASE, Math.max(0, topGutterPx));
  const padBot = Math.min(REFLOW.PAD_PX_BASE, Math.max(0, bottomGutterPx));
  if ((padTop | padBot) === 0) { return raw.slice(); }

  const out: Band[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    const top = b.top - padTop;
    const bottom = b.bottom + padBot;
    out[i] = {
      top,
      bottom,
      height: bottom - top,
    } as Band;
  }
  return out;
}

// NAV: function validateBandSpacing
function validateBandSpacing(
  outer: HTMLDivElement,
  bands: Band[],
  {
    minGapAlertPx = 2,   // log if the inter-system gap is smaller than this
  }: { minGapAlertPx?: number } = {}
): void {
  if (!bands.length) { return; }

  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "validateBandSpacing";


  let overlaps = 0;
  let tightGaps = 0;

  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i]!;
    const b = bands[i + 1]!;
    const gap = Math.floor(b.top) - Math.ceil(a.bottom);
    if (gap < 0) { overlaps++; }
    else if (gap < minGapAlertPx) { tightGaps++; }
  }

  if (overlaps > 0 || tightGaps > 0) {
    if (isDiagOn()) {
      // Emit per-incident detail (kept short).
      for (let i = 0; i + 1 < bands.length; i++) {
        const a = bands[i]!;
        const b = bands[i + 1]!;
        const gap = Math.floor(b.top) - Math.ceil(a.bottom);
        if (gap < 0) {
          void logStep(
            `OVERLAP: bands[${i}] bottom=${Math.ceil(a.bottom)} > bands[${i + 1}] top=${Math.floor(b.top)} (delta ${gap})`,
            { outer, caller: prevFuncTag }
          );
        } else if (gap < minGapAlertPx) {
          void logStep(
            `TIGHT: bands[${i}]→[${i + 1}] gap=${gap}px (<${minGapAlertPx})`,
            { outer, caller: prevFuncTag }
          );
        }
      }
    }
  }
  try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
}

// Scan measure groups from the current OSMD SVG, union staves within the same measure,
// and return unified per-measure rectangles relative to the wrapper host.
// Runs AFTER pagination transform so boxes align with what you see.
// NAV: function scanMeasuresPx
function scanMeasuresPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Array<{ id: string; rect: Rect }> {
  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "scanMeasuresPx";

  try {
    const hostTop = outer.getBoundingClientRect().top;
    const hostLeft = outer.getBoundingClientRect().left;

    // Collect any group that looks like a measure; OSMD commonly emits ids with "measure"
    const MEASURE_SEL = "g[id*='measure' i], g[class*='measure' i]";
    const groups = Array.from(svgRoot.querySelectorAll<SVGGElement>(MEASURE_SEL));

    if (isDiagOn()) {
      logStep(`raw measure-like groups: ${groups.length}`, { outer, caller: prevFuncTag });
    }

    // Map string id-key -> union rect
    const map = new Map<string, Rect>();

    const unionInto = (key: string, r: DOMRect) => {
      const x = r.left - hostLeft;
      const y = r.top - hostTop;
      const w = r.width;
      const h = r.height;
      if (!(Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0)) { return; }

      const rect: Rect = { x, y, w, h };
      const prev = map.get(key);
      if (!prev) { map.set(key, rect); return; }

      const x2 = Math.max(prev.x + prev.w, rect.x + rect.w);
      const y2 = Math.max(prev.y + prev.h, rect.y + rect.h);
      const nx = Math.min(prev.x, rect.x);
      const ny = Math.min(prev.y, rect.y);
      map.set(key, { x: nx, y: ny, w: x2 - nx, h: y2 - ny });
    };

    for (const g of groups) {
      try {
        // Normalize a stable key per measure: prefer the numeric prefix if present.
        // Common patterns: "measure-12", "measure-12-1", etc. Fall back to id text.
        const raw = g.getAttribute("id") || g.getAttribute("class") || "";
        const m = raw.match(/measure[-_\s]?(\d+)/i);
        const key = m ? `measure-${m[1]}` : raw || `(anon-measure)`;

        const r = g.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          unionInto(key, r);
        }
      } catch { }
    }

    // Emit sorted by y then x for deterministic draw order
    const rows = Array.from(map.entries())
      .map(([id, rect]) => ({ id, rect }))
      .sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

    if (isDiagOn()) {
      // Log a small, non-spammy sample: first 3 and last 3
      const sample = rows.length <= 6
        ? rows
        : [...rows.slice(0, 3), ...rows.slice(-3)];

      for (const { id, rect } of sample) {
        logStep(
          `id: ${id} @ x${Math.round(rect.x)} y${Math.round(rect.y)} w${Math.round(rect.w)} h${Math.round(rect.h)}`,
          { outer, caller: prevFuncTag }
        );
      }
    }

    logStep(`merged measures: ${rows.length}`, { outer, caller: prevFuncTag });

    return rows;
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
  }
}

// NAV: function pedalEndpointKeyToString
function pedalEndpointKeyToString(k: PedalEndpointKey): string {
  // dxRel stringified to reduce float noise in map keys.
  // Keep enough precision to distinguish user intent.
  return `${k.measureNumber}|${k.noteId}|${k.dxRel.toFixed(6)}`;
}

// NAV: function endpointFromPedalAnchor
function endpointFromPedalAnchor(
  measureNumber: number,
  ref: PedalAnchorRef
): PedalEndpointKey {
  return {
    measureNumber,
    noteId: ref.noteId,
    dxRel: ref.dxRel,
  };
}

// Pure geometry helper: computes the measure-box rectangles for the
// *current page* using the same logic drawMeasureBoxes used before.
// No DOM/side effects — just numbers we can reuse (e.g. for annotations).
// NAV: function computeMeasureBoxRectsForPage
function computeMeasureBoxRectsForPage(
  measuresIn: ReadonlyArray<{ id: string; rect: Rect }>,
  geomIn: ReadonlyMap<string, MeasureGeom>,
  bands: readonly Band[],
  startIndex: number,
  nextStartIndex: number, // -1 on last page
  ySnap: number,
  topGutterPx: number,
  maskTopWithinMusicPx: number
): MeasureBoxRect[] {
  const rects: MeasureBoxRect[] = [];

  if (!measuresIn.length || !bands.length) {
    return rects;
  }

  // Same translate applied to the score SVG in applyPage:
  const pageTy = -ySnap + Math.max(0, topGutterPx);

  // Shift measures into the current page-local coordinate space
  const measures = measuresIn.map((m) => ({
    id: m.id,
    rect: {
      x: m.rect.x,
      y: m.rect.y + pageTy,
      w: m.rect.w,
      h: m.rect.h,
    },
  }));

  // Build seps[] exactly as in the original drawMeasureBoxes

  const seps: number[] = [];
  const topG = Math.max(0, topGutterPx);

  const firstBand = Math.max(
    0,
    Math.min(startIndex | 0, Math.max(0, bands.length - 1))
  );
  const lastBandInclRaw =
    (nextStartIndex >= 0 ? nextStartIndex : bands.length) - 1;
  const lastBandIncl = Math.max(
    firstBand,
    Math.min(lastBandInclRaw, Math.max(0, bands.length - 1))
  );

  const firstBandTopPL =
    (bands[firstBand] ? Math.round(bands[firstBand]!.top) : 0) -
    Math.ceil(ySnap) +
    topG;

  seps.push(Math.max(topG, firstBandTopPL)); // sep[0]

  if (lastBandIncl > firstBand) {
    for (let i = firstBand; i < lastBandIncl; i++) {
      const bCurr = bands[i];
      const bNext = bands[i + 1];
      if (!bCurr || !bNext) {
        continue;
      }

      // Convert to page-local coords
      const bottomCurr = Math.round(bCurr.bottom) - Math.ceil(ySnap) + topG;
      const topNext = Math.round(bNext.top) - Math.ceil(ySnap) + topG;

      // Midpoint seam between systems i and i+1 (rounded to px)
      const seam = Math.round((bottomCurr + topNext) / 2);
      seps.push(seam);
    }
  }

  // Bottom limit (page-local) — ensures the last tile closes at the mask cut
  const bottomLimit = Math.max(0, Math.floor(topG + maskTopWithinMusicPx));
  seps.push(bottomLimit); // sep[last]

  // Ensure non-decreasing separators (defensive against rounding)
  for (let i = 1; i < seps.length; i++) {
    const prev = seps[i - 1]!;
    const curr = seps[i]!;
    if (curr < prev) {
      seps[i] = prev;
    }
  }

  // Fallback: at least two separators
  if (seps.length < 2) {
    seps.length = 0;
    seps.push(topG, bottomLimit);
  }

  const pageTop = seps[0]!;
  const pageBottom = seps[seps.length - 1]!;
  const lastTileIndex = seps.length - 2;

  // Bucket measures by tile (system) exactly the way you were doing it

  type BucketItem = { m: (typeof measures)[number]; k: number };
  const buckets = new Map<number, BucketItem[]>();

  for (const m of measures) {
    const rectTopPL = Math.round(m.rect.y);
    const rectBotPL = Math.round(
      m.rect.y + Math.max(1, Math.round(m.rect.h))
    );

    // Page filter by vertical overlap with the page window
    const ovPage = Math.max(
      0,
      Math.min(rectBotPL, pageBottom) - Math.max(rectTopPL, pageTop)
    );
    if (ovPage <= 0) {
      continue;
    }

    // Robust tile pick by vertical overlap against seps[]
    let kBest = -1;
    let bestOv = 0;

    for (let t = 0; t <= lastTileIndex; t++) {
      const y0 = seps[t];
      const y1 = seps[t + 1];
      if (y0 === undefined || y1 === undefined) {
        continue;
      }
      const ov = Math.max(
        0,
        Math.min(rectBotPL, y1) - Math.max(rectTopPL, y0)
      );
      if (ov > bestOv) {
        bestOv = ov;
        kBest = t;
      }
    }

    if (kBest < 0 || bestOv === 0) {
      continue;
    }

    const arr = buckets.get(kBest);
    const item: BucketItem = { m, k: kBest };
    if (arr) {
      arr.push(item);
    } else {
      buckets.set(kBest, [item]);
    }
  }

  // Geometry lookup: same normalization strategy as before

  const normKey = (id: string): string => {
    // Accept "measure-12", "measure_12", "measure 12", or plain "12" → normalize to "measure-12"
    const m = id.match(/measure[-_\s]?(\d+)/i) || id.match(/^(\d+)$/);
    return m ? `measure-${m[1]}` : id;
  };

  const getGeom = (id: string): MeasureGeom | undefined => {
    const idExact = id;
    const idNorm = normKey(id);
    if (geomIn.has(idExact)) {
      return geomIn.get(idExact)!;
    }
    if (geomIn.has(idNorm)) {
      return geomIn.get(idNorm)!;
    }

    const num = id.match(/\d+/)?.[0] ?? "";
    if (num) {
      const mk = `measure-${num}`;
      if (geomIn.has(mk)) {
        return geomIn.get(mk)!;
      }
      // LAST RESORT: scan for any key that contains that exact number token
      for (const [k, v] of geomIn as Map<string, MeasureGeom>) {
        if (new RegExp(`(^|\\D)${num}(\\D|$)`).test(k)) {
          return v;
        }
      }
    }
    return undefined;
  };

  // Walk tiles in order, compute rects exactly as before

  for (let k = 0; k <= lastTileIndex; k++) {
    const items = buckets.get(k);
    if (!items || items.length === 0) {
      continue;
    }

    // Sort by OSMD measure id number, then x, same as the original
    items.sort((a, b) => {
      const an = a.m.id.match(/measure[-_\s]?(\d+)/i)?.[1];
      const bn = b.m.id.match(/measure[-_\s]?(\d+)/i)?.[1];
      const ai = an ? Number(an) : Number.POSITIVE_INFINITY;
      const bi = bn ? Number(bn) : Number.POSITIVE_INFINITY;
      if (ai !== bi) {
        return ai - bi;
      }
      return a.m.rect.x - b.m.rect.x;
    });

    const bandTopK = seps[k]!;
    const bandBotK = seps[k + 1]!;

    for (let i = 0; i < items.length; i++) {
      const { m } = items[i]!;
      const g = getGeom(m.id);
      if (!g) {
        continue;
      }

      // Geometry is pre-translate; drawing is post-translate → shift to page-local
      const mtDraw = g.top + pageTy;
      const mbDraw = g.bottom + pageTy;

      // Require overlap with this tile’s band window
      if (mbDraw <= bandTopK || mtDraw >= bandBotK) {
        continue;
      }

      // Horizontal (barline-derived)
      const l = Math.round(g.interval.left) + 0.5;
      const rEdge = Math.round(g.interval.right) + 0.5;
      const x = Math.min(l, rEdge);
      const w = Math.max(1, Math.round(Math.abs(rEdge - l)) - 1);

      // Pads capped by headroom
      const availTop = Math.max(0, mtDraw - bandTopK);
      const availBot = Math.max(0, bandBotK - mbDraw);
      const padTop = Math.min(REFLOW.PAD_PX_BASE, availTop);
      const padBot = Math.min(REFLOW.PAD_PX_BASE, availBot);

      const top = Math.max(bandTopK, Math.round(mtDraw - padTop));
      const bot = Math.min(bandBotK, Math.round(mbDraw + padBot));

      // Pixel-perfect y/h
      const y = Math.round(Math.min(top, bot)) + 0.5;
      const h = Math.max(1, Math.round(Math.abs(bot - top)) - 1);

      // parse a measureNumber from m.id
      // Handles ids like "measure-12", "measure_12", "measure 12", or plain "12".
      const matchFromMeasure = m.id.match(/measure[-_\s]?(\d+)/i);
      const matchPlain = m.id.match(/^(\d+)$/);
      const raw = matchFromMeasure?.[1] ?? matchPlain?.[1] ?? "";
      const parsed = Number(raw);
      const measureNumber =
        Number.isFinite(parsed) && parsed > 0 ? parsed : -1;

      rects.push({
        id: m.id,
        x,
        y,
        w,
        h,
        measureNumber,
      });
    }
  }

  return rects;
}

// Draw/refresh a lightweight SVG overlay of measure rectangles (stroke-only),
// snapping vertical bounds to per-system page separators so boxes tile cleanly.
// STRICT TS SAFE (noUncheckedIndexedAccess compatible).
// NAV: function drawMeasureBoxes
function drawMeasureBoxes(
  outer: HTMLDivElement,
  svgRoot: SVGSVGElement,
  measuresIn: ReadonlyArray<{ id: string; rect: Rect }>,
  geomIn: ReadonlyMap<string, MeasureGeom>,
  bands: readonly Band[],
  startIndex: number,
  nextStartIndex: number, // -1 on last page
  ySnap: number,
  topGutterPx: number,
  maskTopWithinMusicPx: number,
  precomputedRects?: ReadonlyArray<MeasureBoxRect>
): void {
  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "drawMeasureBoxes";

  // Remove any previous layer
  outer
    .querySelectorAll("[data-viewer-measureboxes='1']")
    .forEach((n) => n.remove());

  // Quick guards (same intent as before)
  if (!outer || !svgRoot || bands.length === 0) {
    logStep("boxes: 0 (early-guard bands/svg/outer)", {
      outer,
      caller: prevFuncTag,
    });
    try {
      outer.dataset.viewerFunc = prevFuncTag;
    } catch {
      // ignore
    }
    return;
  }

  if (!measuresIn.length) {
    logStep("boxes: 0 (no measures-pre)", { outer, caller: prevFuncTag });
    try {
      outer.dataset.viewerFunc = prevFuncTag;
    } catch {
      // ignore
    }
    return;
  }

  // Core geometry: same math as the original implementation,
  // now factored into a shared helper.
  // If refined rects are supplied, use them; otherwise, fall back to raw geometry
  const rects: ReadonlyArray<MeasureBoxRect> =
    precomputedRects ??
    computeMeasureBoxRectsForPage(
      measuresIn,
      geomIn,
      bands,
      startIndex,
      nextStartIndex,
      ySnap,
      topGutterPx,
      maskTopWithinMusicPx
    );

  if (!rects.length) {
    logStep("boxes: 0 (no rects from helper)", { outer, caller: prevFuncTag });
    try {
      outer.dataset.viewerFunc = prevFuncTag;
    } catch {
      // ignore
    }
    return;
  }

  // Build overlay SVG exactly as before
  const layer = createSvgEl("svg");
  layer.setAttribute("data-viewer-measureboxes", "1");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "20",
  } as CSSStyleDeclaration);

  const ow = outer.clientWidth || 0;
  const oh = outer.clientHeight || 0;
  layer.setAttribute("width", String(ow));
  layer.setAttribute("height", String(oh));
  layer.setAttribute("viewBox", `0 0 ${ow} ${oh}`);

  const g = createSvgEl("g");
  layer.appendChild(g);

  let drawnCount = 0;

  for (let i = 0; i < rects.length; i++) {
    const { id, x, y, w, h } = rects[i]!;

    // SVG rect
    const r = createSvgEl("rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    r.setAttribute("fill", "none");
    r.setAttribute("stroke", "rgba(0,0,0,0.7)");
    r.setAttribute("stroke-width", "1");
    r.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(r);

    // Diagnostic measure label (now *above* the box so it doesn’t block annotations)
    const measureNum = Number(id);
    if (Number.isFinite(measureNum)) {
      const textEl = createSvgEl("text");
      textEl.textContent = String(measureNum);

      // Upper-left corner, just *outside* the box
      const labelX = x + 2;
      // Clamp so labels don’t disappear when a box is very near the top
      const labelY = Math.max(8, y - 2);

      textEl.setAttribute("x", String(labelX));
      textEl.setAttribute("y", String(labelY));
      textEl.setAttribute("font-size", "10");
      textEl.setAttribute("fill", "red");
      textEl.setAttribute("stroke", "black");
      textEl.setAttribute("stroke-width", "0.5");
      textEl.setAttribute("dominant-baseline", "baseline"); // optional, default is fine too

      g.appendChild(textEl);
    }

    drawnCount++;
  }

  // append the overlay once (after all tiles are drawn)
  outer.appendChild(layer);

  logStep(`boxes: ${drawnCount}`, { outer, caller: prevFuncTag });
  try {
    outer.dataset.viewerFunc = prevFuncTag;
  } catch { }
}


// Remove the measure overlay layer if present.
// NAV: function clearMeasureBoxes
function clearMeasureBoxes(outer: HTMLDivElement): void {
  outer.querySelectorAll("[data-viewer-measureboxes='1']").forEach(n => n.remove());
}

// Filled annotation overlay (per-measure), using the exact same geometry
// as measure boxes. Separate layer so we can style/clear independently.
// NAV: function drawAnnotationBoxes
function drawAnnotationBoxes(
  outer: HTMLDivElement,
  rects: ReadonlyArray<MeasureBoxRect>,
  getAnnotationsForMeasure: GetAnnotationsForMeasure,
  osmdZoom = 1,
  noteAnchorsByMeasure?: Record<string, NoteAnchor[]>,
  staffLineGlyphsByMeasure?: Record<string, GlyphRect[]>,
): void {
  if (!outer || rects.length === 0) {
    return;
  }

  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "drawAnnotationBoxes";
  logStep(`called`, { outer, caller: prevFuncTag });

  const layer = createSvgEl("svg");
  layer.setAttribute("data-viewer-annotations", "1");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "18", // under measure boxes, over the score
  } as CSSStyleDeclaration);

  const ow = outer.clientWidth || 0;
  const oh = outer.clientHeight || 0;
  layer.setAttribute("width", String(ow));
  layer.setAttribute("height", String(oh));
  layer.setAttribute("viewBox", `0 0 ${ow} ${oh}`);

  const g = createSvgEl("g");
  layer.appendChild(g);

  // For each measure box, remember the right edge of the *previous* measure
  // on the same system, so we can extend pedal lines up to the real barline.
  const prevMeasureRightById: Record<string, number> = {};
  {
    let lastBoxOnSystem: MeasureBoxRect | null = null;

    for (const b of rects) {
      if (!lastBoxOnSystem) {
        lastBoxOnSystem = b;
        continue;
      }

      // Heuristic: same system if vertical centers are close.
      const lastMidY = lastBoxOnSystem.y + lastBoxOnSystem.h / 2;
      const thisMidY = b.y + b.h / 2;
      const sameSystem = Math.abs(thisMidY - lastMidY) < b.h * 0.4;

      if (sameSystem) {
        prevMeasureRightById[b.id] = lastBoxOnSystem.x + lastBoxOnSystem.w;
      } else {
        lastBoxOnSystem = b;
        continue;
      }

      lastBoxOnSystem = b;
    }
  }

  // ==========================================================
  // Staff metrics helper (uses vf-measure staff-line glyphs)
  // ==========================================================
  type StaffMetrics = {
    trebleMidY: number;
    bassMidY: number;
    betweenY: number;
    staffSpacePx: number; // distance between adjacent staff lines (px)
  };

  const computeStaffMetricsForMeasure = (boxId: string): StaffMetrics | null => {
    const glyphs = staffLineGlyphsByMeasure?.[boxId] ?? [];
    if (!glyphs.length) {
      return null;
    }

    // Keep only staff lines (vf-measure). In your logs these are the horizontal staff lines.
    const staffLines = glyphs.filter((gr) => {
      const tag = gr.glyphTag?.toLowerCase() ?? "";
      return tag.includes("vf-measure");
    });

    if (staffLines.length < 10) {
      // Expect ~10 staff lines (5 treble + 5 bass) for grand staff
      return null;
    }

    // Sort by y (top -> bottom), dedupe near-identical y values.
    const ysSorted = staffLines
      .map((gr) => gr.y)
      .filter((y) => Number.isFinite(y))
      .sort((a, b) => a - b);

    const ys: number[] = [];
    const EPS = 0.75; // px tolerance for dedupe
    for (const y of ysSorted) {
      const last = ys[ys.length - 1];
      if (last === undefined || Math.abs(y - last) > EPS) {
        ys.push(y);
      }
    }

    if (ys.length < 10) {
      return null;
    }

    // Use first 5 as treble lines, last 5 as bass lines.
    const treble = ys.slice(0, 5);
    const bass = ys.slice(ys.length - 5);

    // Staff-space: median adjacent diff within each staff (should be stable)
    const diffs: number[] = [];
    for (let i = 0; i < 4; i++) {
      diffs.push(treble[i + 1]! - treble[i]!);
      diffs.push(bass[i + 1]! - bass[i]!);
    }
    const diffsSorted = diffs
      .filter((d) => Number.isFinite(d) && d > 0.1)
      .sort((a, b) => a - b);

    if (!diffsSorted.length) {
      return null;
    }

    const staffSpacePx =
      diffsSorted[Math.floor(diffsSorted.length / 2)] ?? diffsSorted[0]!;
    if (!(staffSpacePx > 0 && Number.isFinite(staffSpacePx))) {
      return null;
    }

    // Midline = 3rd staff line (index 2) in each staff.
    const trebleMidY = treble[2]!;
    const bassMidY = bass[2]!;

    // Between default = geometric midpoint between midlines.
    const betweenY = (trebleMidY + bassMidY) / 2;

    return { trebleMidY, bassMidY, betweenY, staffSpacePx };
  };

  // Resolve a PedalAnchorRef to an X coordinate in px for this measure, or null if it can't be resolved.
  // NAV: __ function resolvePedalAnchorX
  function resolvePedalAnchorX(
    ref: PedalAnchorRef | null | undefined,
    boxId: string,
    noteAnchorsByMeasureIn?: Record<string, NoteAnchor[]>,
  ): number | null {
    if (!ref) {
      return null;
    }

    if (typeof ref.noteId !== "string" || ref.noteId.length === 0) {
      console.error("[pedal] Invalid pedal anchor: missing/invalid noteId", {
        ref,
        boxId,
      });
      if (isDiagOn()) {
        throw new Error("Invalid pedal anchor: noteId");
      }
      return null;
    }

    if (typeof ref.dxRel !== "number" || !Number.isFinite(ref.dxRel)) {
      console.error("[pedal] Invalid pedal anchor: missing/invalid dxRel", {
        ref,
        boxId,
      });
      if (isDiagOn()) {
        throw new Error("Invalid pedal anchor: dxRel");
      }
      return null;
    }

    if (!noteAnchorsByMeasureIn) {
      console.error(
        "[pedal] noteAnchorsByMeasure missing; cannot resolve pedal anchor",
        { boxId },
      );
      if (isDiagOn()) {
        throw new Error("noteAnchorsByMeasure missing");
      }
      return null;
    }

    const anchorsForMeasure = noteAnchorsByMeasureIn[boxId];
    if (!anchorsForMeasure || anchorsForMeasure.length === 0) {
      console.error(
        "[pedal] No note anchors found for measure; cannot resolve pedal anchor",
        { boxId },
      );
      if (isDiagOn()) {
        throw new Error("No note anchors for measure");
      }
      return null;
    }

    const anchorNote = anchorsForMeasure.find((a) => a.id === ref.noteId);
    if (!anchorNote) {
      console.error("[pedal] Anchor noteId not found in this measure", {
        boxId,
        noteId: ref.noteId,
      });
      if (isDiagOn()) {
        throw new Error("Anchor noteId not found");
      }
      return null;
    }

    const noteH = anchorNote.h;
    if (!(noteH > 0 && Number.isFinite(noteH))) {
      console.error("[pedal] Bad anchor note geometry (noteH)", {
        boxId,
        noteId: ref.noteId,
        noteH,
      });
      if (isDiagOn()) {
        throw new Error("Bad note geometry");
      }
      return null;
    }

    const dxPx = ref.dxRel * noteH;
    const anchorPxX = anchorNote.x + dxPx;

    if (!Number.isFinite(anchorPxX)) {
      console.error("[pedal] Computed pedal X is not finite", {
        boxId,
        ref,
        noteH,
        anchorPxX,
      });
      if (isDiagOn()) {
        throw new Error("Computed pedal X not finite");
      }
      return null;
    }

    return anchorPxX;
  }

  // Compute vertical baselines for pedal runs, but only per *system* (line).
  // NAV: __ function computePedalBaselinesForRects
  function computePedalBaselinesForRects(
    rectsIn: ReadonlyArray<MeasureBoxRect>,
    getAnnotationsForMeasureIn: GetAnnotationsForMeasure,
  ): Record<string, number> {
    const byMeasureId: Record<string, number> = {};

    if (!rectsIn.length) {
      return byMeasureId;
    }

    const heights = rectsIn.map((r) => r.h);
    const sortedHeights = [...heights].sort((a, b) => a - b);
    const medianH =
      sortedHeights[Math.floor(sortedHeights.length / 2)] ?? rectsIn[0]!.h;
    const SYSTEM_TOL = medianH * 0.6;

    const sortedBoxes = [...rectsIn].sort((a, b) => {
      const dy = a.y - b.y;
      if (Math.abs(dy) > SYSTEM_TOL) {
        return dy;
      }
      return a.x - b.x;
    });

    type BoxWithPedal = { box: MeasureBoxRect; hasActivePedal: boolean };
    type Pedalish = { kind: string; active?: boolean | null };

    const boxesWithPedal: BoxWithPedal[] = sortedBoxes.map((box) => {
      const ann = getAnnotationsForMeasureIn(box.measureNumber);
      let hasActivePedal = false;

      if (ann && Array.isArray(ann.items)) {
        for (const raw of ann.items as Pedalish[]) {
          if (raw.kind === "pedal" && raw.active === true) {
            hasActivePedal = true;
            break;
          }
        }
      }

      return { box, hasActivePedal };
    });

    const systems: BoxWithPedal[][] = [];
    for (const entry of boxesWithPedal) {
      const { box } = entry;

      let placed = false;
      for (const sys of systems) {
        const refBox = sys[0]!.box;
        if (Math.abs(box.y - refBox.y) <= SYSTEM_TOL) {
          sys.push(entry);
          placed = true;
          break;
        }
      }

      if (!placed) {
        systems.push([entry]);
      }
    }

    for (const sys of systems) {
      const hasAnyPedal = sys.some((e) => e.hasActivePedal);
      if (!hasAnyPedal) {
        continue;
      }

      let systemBottom = -Infinity;
      for (const e of sys) {
        if (e.hasActivePedal) {
          const bottom = e.box.y + e.box.h;
          if (bottom > systemBottom) {
            systemBottom = bottom;
          }
        }
      }

      if (!Number.isFinite(systemBottom)) {
        continue;
      }

      const baseline = systemBottom;
      for (const e of sys) {
        if (e.hasActivePedal) {
          byMeasureId[e.box.id] = baseline;
        }
      }
    }

    return byMeasureId;
  }

  const pedalBaselineByMeasureId = computePedalBaselinesForRects(
    rects,
    getAnnotationsForMeasure,
  );

  for (const box of rects) {
    const annotation = getAnnotationsForMeasure(box.measureNumber);
    if (!annotation) {
      continue;
    }

    const items = Array.isArray(annotation.items) ? annotation.items : [];
    if (!items.length) {
      continue;
    }

    for (const item of items) {
      // =======================
      // FINGERING ITEMS (note-anchored)
      // =======================
      if (item.kind === "fingering") {
        const anchor = item.anchor;

        if (!anchor || !noteAnchorsByMeasure || !noteAnchorsByMeasure[box.id]) {
          continue;
        }

        const anchorsForMeasure = noteAnchorsByMeasure[box.id]!;
        const anchorNote = anchorsForMeasure.find((a) => a.id === anchor.noteId);

        if (!anchorNote) {
          continue;
        }

        const noteH = anchorNote.h;
        if (!(noteH > 0 && Number.isFinite(noteH))) {
          continue;
        }

        const dxPx = anchor.dxRel * noteH;
        const dyPx = anchor.dyRel * noteH;

        const pxX = anchorNote.x + dxPx;
        let pxY = anchorNote.y + dyPx;

        // ------------------------------------------------------------
        // Fingering readability: if we're too close to a staff line,
        // nudge into the nearest staff space (render-only adjustment).
        // ------------------------------------------------------------
        if (staffLineGlyphsByMeasure) {
          const metrics = computeStaffMetricsForMeasureFromStaffLines(
            box.id,
            staffLineGlyphsByMeasure
          );

          if (metrics && metrics.staffSpacePx > 0 && Number.isFinite(metrics.staffSpacePx)) {
            const s = metrics.staffSpacePx;

            // Five-line staff: lines are at midY + k*s for k in [-2,-1,0,1,2]
            const trebleLines = [
              metrics.trebleMidY - 2 * s,
              metrics.trebleMidY - 1 * s,
              metrics.trebleMidY,
              metrics.trebleMidY + 1 * s,
              metrics.trebleMidY + 2 * s,
            ];

            const bassLines = [
              metrics.bassMidY - 2 * s,
              metrics.bassMidY - 1 * s,
              metrics.bassMidY,
              metrics.bassMidY + 1 * s,
              metrics.bassMidY + 2 * s,
            ];

            const allLines = [...trebleLines, ...bassLines];

            // Find nearest staff line
            let nearest = allLines[0]!;
            let bestAbs = Math.abs(pxY - nearest);

            for (let i = 1; i < allLines.length; i++) {
              const y = allLines[i]!;
              const d = Math.abs(pxY - y);
              if (d < bestAbs) {
                bestAbs = d;
                nearest = y;
              }
            }

            // If too close to a line, push into the space.
            const snapThresholdPx = 0.20 * s; // tune: 0.15–0.30
            if (bestAbs < snapThresholdPx) {
              const dir = pxY < nearest ? -1 : 1;
              pxY = nearest + dir * 0.50 * s;
            }
          }
        }

        const BASE_FONT_PX = 14;
        const MIN_FONT_PX = 8;
        const MAX_FONT_PX = 30;

        let fontPx = BASE_FONT_PX;

        const currentH = anchorNote.h;

        // baseNoteHNorm is stored at OSMD zoom=1; convert to px for this render pass
        const baseH =
          typeof anchor.baseNoteHNorm === "number" &&
            Number.isFinite(anchor.baseNoteHNorm) &&
            anchor.baseNoteHNorm > 0
            ? anchor.baseNoteHNorm
            : currentH;

        if (
          currentH > 0 &&
          Number.isFinite(currentH) &&
          baseH > 0 &&
          Number.isFinite(baseH)
        ) {
          const relScale = currentH / baseH;
          let candidate = BASE_FONT_PX * relScale;

          if (candidate < MIN_FONT_PX) {
            candidate = MIN_FONT_PX;
          }
          if (candidate > MAX_FONT_PX) {
            candidate = MAX_FONT_PX;
          }

          fontPx = candidate;
        }

        const t = createSvgEl("text");
        t.textContent = item.text;
        t.setAttribute("x", String(pxX));
        t.setAttribute("y", String(pxY));
        t.setAttribute("fill", "black");
        t.setAttribute("font-size", String(fontPx));
        t.setAttribute("font-family", "sans-serif");
        t.setAttribute("font-weight", "700");               // add knob for this
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "middle");
        t.setAttribute("dy", "0");

        g.appendChild(t);
        continue;
      }

      // =======================
      // TEXT ITEMS (staff-anchored)
      // =======================
      if (item.kind === "text") {
        const anchor = item.anchor;
        if (!anchor) {
          continue;
        }

        const metrics = computeStaffMetricsForMeasure(box.id);
        if (!metrics) {
          continue;
        }

        // Horizontal: relative to measure box
        const xRel = typeof anchor.xRel === "number" ? anchor.xRel : 0.5;
        const pxX = box.x + xRel * box.w;

        // Baseline: treble / bass / between
        const mode = typeof anchor.mode === "string" ? anchor.mode : "between";

        let baseY = metrics.betweenY;
        if (mode === "treble") {
          baseY = metrics.trebleMidY;
        } else if (mode === "bass") {
          baseY = metrics.bassMidY;
        } else if (mode === "between") {
          // Optional blend factor if present
          const tBlend =
            typeof anchor.betweenT === "number" && Number.isFinite(anchor.betweenT)
              ? anchor.betweenT
              : 0.5;
          const tClamped = Math.max(0, Math.min(1, tBlend));
          baseY = metrics.trebleMidY * (1 - tClamped) + metrics.bassMidY * tClamped;
        }

        // Vertical offset in staff spaces -> px (uses CURRENT staff spacing)
        const dyRel = typeof anchor.dyRel === "number" ? anchor.dyRel : 0;
        const pxY = baseY + dyRel * metrics.staffSpacePx;

        // Font sizing: scale based on staff-space change vs creation-time
        const BASE_FONT_PX = 16;
        const MIN_FONT_PX = 8;
        const MAX_FONT_PX = 36;

        let fontPx = BASE_FONT_PX;

        const baseStaffSpacePx =
          typeof anchor.baseStaffSpaceNorm === "number" &&
            Number.isFinite(anchor.baseStaffSpaceNorm) &&
            anchor.baseStaffSpaceNorm > 0
            ? anchor.baseStaffSpaceNorm
            : metrics.staffSpacePx;

        if (baseStaffSpacePx > 0 && Number.isFinite(baseStaffSpacePx)) {
          const relScale = metrics.staffSpacePx / baseStaffSpacePx;
          let candidate = BASE_FONT_PX * relScale;

          if (candidate < MIN_FONT_PX) {
            candidate = MIN_FONT_PX;
          }
          if (candidate > MAX_FONT_PX) {
            candidate = MAX_FONT_PX;
          }

          fontPx = candidate;
        }

        const t = createSvgEl("text");
        t.textContent = item.text;
        t.setAttribute("x", String(pxX));
        t.setAttribute("y", String(pxY));
        t.setAttribute("fill", "black");
        t.setAttribute("font-size", String(fontPx));
        t.setAttribute("font-family", "sans-serif");
        t.setAttribute("font-weight", "700");
        t.setAttribute("text-anchor", "left");
        t.setAttribute("dominant-baseline", "middle");
        t.setAttribute("dy", "0");

        g.appendChild(t);
        continue;
      }

      // =======================
      // PEDAL ITEMS
      // =======================
      if (item.kind === "pedal") {
        const leftRef = item.left ?? null;
        const rightRef = item.right ?? null;

        const leftXFromAnchor = resolvePedalAnchorX(
          leftRef,
          box.id,
          noteAnchorsByMeasure,
        );
        const rightXFromAnchor = resolvePedalAnchorX(
          rightRef,
          box.id,
          noteAnchorsByMeasure,
        );

        const isActive = item.active === true;

        if (!isActive && leftXFromAnchor === null && rightXFromAnchor === null) {
          continue;
        }

        let x1: number;
        let x2: number;

        if (leftXFromAnchor !== null && rightXFromAnchor !== null) {
          x1 = leftXFromAnchor;
          x2 = rightXFromAnchor;
        } else if (leftXFromAnchor !== null) {
          x1 = leftXFromAnchor;
          x2 = box.x + box.w;
        } else if (rightXFromAnchor !== null) {
          x1 = box.x;
          x2 = rightXFromAnchor as number;
        } else if (isActive) {
          x1 = box.x;
          x2 = box.x + box.w;
        } else {
          continue;
        }

        if (x2 < x1) {
          const tmp = x1;
          x1 = x2;
          x2 = tmp;
        }

        if (isActive && leftXFromAnchor === null) {
          const prevRight = prevMeasureRightById[box.id];
          if (prevRight !== undefined) {
            x1 = prevRight - 1 * osmdZoom;
          } else {
            const EDGE_OVERSHOOT = 4 * osmdZoom;
            x1 = box.x - EDGE_OVERSHOOT;
          }
        }

        const rightLimit = box.x + box.w;
        if (x2 > rightLimit) {
          x2 = rightLimit;
        }

        if (x2 < x1) {
          const tmp = x1;
          x1 = x2;
          x2 = tmp;
        }

        const PEDAL_MARGIN_FROM_BOTTOM = 3 * osmdZoom;
        const PEDAL_TICK_HEIGHT = 7 * osmdZoom;

        const runBottomY = pedalBaselineByMeasureId[box.id] ?? (box.y + box.h);

        const pedalY = runBottomY - PEDAL_MARGIN_FROM_BOTTOM;
        const tickTopY = pedalY - PEDAL_TICK_HEIGHT;

        const hasLeftTick = leftRef !== null;
        const hasRightTick = rightRef !== null;

        let d = "";

        if (hasLeftTick) {
          d += `M ${x1} ${tickTopY} L ${x1} ${pedalY} `;
        } else {
          d += `M ${x1} ${pedalY} `;
        }

        d += `L ${x2} ${pedalY} `;

        if (hasRightTick) {
          d += `L ${x2} ${tickTopY}`;
        }

        const PEDAL_STROKE_PX = 1.4;

        const path = createSvgEl("path");
        path.setAttribute("d", d.trim());
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "black");
        path.setAttribute("stroke-width", String(PEDAL_STROKE_PX * osmdZoom));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");

        g.appendChild(path);
        continue;
      }

      // Future item kinds can fall through here and be ignored safely.
    }
  }

  outer.appendChild(layer);
  try {
    outer.dataset.viewerFunc = prevFuncTag;
  } catch {
    // ignore
  }
}

// Remove the annotation overlay layer if present.
// NAV: function clearAnnotationBoxes
function clearAnnotationBoxes(outer: HTMLDivElement): void {
  outer.querySelectorAll("[data-viewer-annotations='1']").forEach((n) => n.remove());
}

// Deterministic page starts from measured system rectangles (strict, bottom-based).
// NAV: function computePageStarts
function computePageStarts(
  outer: HTMLDivElement,
  bands: Band[],
  viewportH: number,
  topGutterPx: number,
  bottomGutterPx: number
): number[] {
  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "computePageStarts";
  try {
    if (bands.length === 0 || viewportH <= 0) {
      void logStep("starts: 1 (fallback [0])", { outer, caller: prevFuncTag });
      return [0];
    }

    // Same “usable height” model as applyPage
    // 1) DPR tolerance (you already had this)
    const TOL = (window.devicePixelRatio || 1) >= 2 ? 2 : 1;

    // 2) Bottom peek pad matches REFLOW guards used elsewhere
    const bottomPeekPad =
      (window.devicePixelRatio || 1) >= 2
        ? REFLOW.BOTTOM_PEEK_PAD_HI_DPR
        : REFLOW.BOTTOM_PEEK_PAD_LO_DPR;

    // 3) Top gutter comes from the viewer’s prop/state in this closure
    const topPad = Math.max(0, topGutterPx);

    // 4) Final usable page height for packing
    const botPad = Math.max(0, bottomGutterPx);
    const pageHeightUsable = Math.max(
      1,
      Math.floor(viewportH - topPad - botPad - bottomPeekPad) - TOL
    );

    const starts: number[] = [];
    let i = 0;

    while (i < bands.length) {
      // Start a new page at band i
      starts.push(i);

      // Snap page to the actual top of the first system
      const ySnap = Math.ceil(bands[i]!.top);

      // Greedily include next systems while their measured bottom still fits
      let j = i;
      while (
        j + 1 < bands.length &&
        (bands[j + 1]!.bottom - ySnap) <= pageHeightUsable
      ) {
        j += 1;
      }
      i = j + 1;
    }

    // Breadcrumbs to verify in DevTools
    outer.dataset.viewerUsableH = String(pageHeightUsable);

    void logStep(`starts: ${starts.length} pageHeightUsable: ${pageHeightUsable}`,
      { outer, caller: prevFuncTag });
    return starts.length ? starts : [0];
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
  }
}

// NAV: function hasZoomProp
function hasZoomProp(o: unknown): o is { Zoom: number } {
  if (typeof o !== "object" || o === null) { return false; }
  const maybe = o as { Zoom?: unknown };
  return typeof maybe.Zoom === "number";
}


// NAV: -----------------perf blocks

function perfMark(n: string) { try { performance.mark(n); } catch { } }

function perfMeasure(n: string, a: string, b: string) {
  try { performance.measure(n, { start: a, end: b }); } catch { }
}

function perfLastMs(name: string) {
  const e = performance.getEntriesByName(name);
  return Math.round(e[e.length - 1]?.duration || 0);
}

function perfBlock<T>(
  uid: string,
  work: () => T,
  after?: (ms: number) => void
): T {
  const start = `${uid} start`;
  const end = `${uid} end`;
  const runtime = `${uid} runtime`;
  perfMark(start);
  try {
    return work();
  } finally {
    perfMark(end);
    perfMeasure(runtime, start, end);
    const ms = perfLastMs(runtime);
    try { after?.(ms); } catch { }
    try {
      performance.clearMarks(start);
      performance.clearMarks(end);
      performance.clearMeasures(runtime);
    } catch { }
  }
}

async function perfBlockAsync<T>(
  uid: string,
  work: () => Promise<T>,
  after?: (ms: number) => void
): Promise<T> {
  const start = `${uid} start`;
  const end = `${uid} end`;
  const runtime = `${uid} runtime`;
  perfMark(start);
  try {
    return await work();
  } finally {
    perfMark(end);
    perfMeasure(runtime, start, end);
    const ms = perfLastMs(runtime);
    try { after?.(ms); } catch { }
    try {
      performance.clearMarks(start);
      performance.clearMarks(end);
      performance.clearMeasures(runtime);
    } catch { }
  }
}


// NAV: -----------------measure/page mapping helpers

// NAV: function rebuildMeasureToPageMapping
function rebuildMeasureToPageMapping(
  bands: ReadonlyArray<Band>,
  starts: ReadonlyArray<number>,
  geometry: ReadonlyMap<string, MeasureGeom>
): number[] {
  const bandCount = bands.length;
  const geomSize = geometry.size;

  if (bandCount === 0 || geomSize === 0) {
    return [];
  }

  // 1) band → page
  const bandToPage: number[] = new Array(bandCount).fill(-1);
  for (let p = 0; p < starts.length; p++) {
    const startBand = starts[p]!;
    const endBand =
      p + 1 < starts.length ? starts[p + 1]! : bandCount;
    for (let b = startBand; b < endBand; b++) {
      bandToPage[b] = p;
    }
  }

  // 2) measure (by id) → page
  const measureToPage: number[] = [];
  for (const [id, geom] of geometry.entries()) {
    const mNum = Number(id);
    if (!Number.isFinite(mNum)) { continue; }

    const bandIndex = geom.tileIndex;
    const pageIndex = bandToPage[bandIndex] ?? -1;

    measureToPage[mNum] = pageIndex;
  }

  return measureToPage;
}

// Given a measure→page mapping and a target page index, choose
// an "anchor" measure on that page.
// 
// Phase 1 implementation: choose the earliest (lowest measure number)
// on the given page.
// 
// The name is intentionally generic so we can later change the strategy
// (e.g., choose the middle measure on that page).
// NAV: function findAnchorMeasure
function findAnchorMeasure(
  measureToPage: ReadonlyArray<number>,
  pageIndex: number
): number | null {
  let lowest = Number.POSITIVE_INFINITY;

  // Scan for all measures that map to the given page.
  for (let m = 0; m < measureToPage.length; m++) {
    if (measureToPage[m] === pageIndex && m < lowest) {
      lowest = m;
    }
  }

  return Number.isFinite(lowest) ? lowest : null;
}

// NAV: function clampUnitInterval
function clampUnitInterval(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

// Given a tap inside a measure box, find a nearby point that does NOT land on
// top of a "hard" glyph (noteheads, rests, stems, etc.). Thin horizontal staff
// lines are treated as *soft* constraints: we prefer points that land between
// them, but don't block them outright. Returns normalized coords, or falls
// back to the original point if nothing better is found.
// NAV: function findSafePointRelForTap
function findSafePointRelForTap(
  box: MeasureBoxRect,
  xPage: number,
  yPage: number,
  glyphs: readonly GlyphRect[]
): PointRel | null {
  // If we have no glyph data, accept as-is (nothing to avoid).
  if (!glyphs.length) {
    const xRel0 = clampUnitInterval((xPage - box.x) / box.w);
    const yRel0 = clampUnitInterval((yPage - box.y) / box.h);
    return { xRel: xRel0, yRel: yRel0 };
  }

  const boxLeft = box.x + 1;
  const boxRight = box.x + box.w - 1;
  const boxTop = box.y + 1;
  const boxBottom = box.y + box.h - 1;

  // Clamp starting point into the measure box
  const startX = Math.max(boxLeft, Math.min(xPage, boxRight));
  const startY = Math.max(boxTop, Math.min(yPage, boxBottom));

  const toRel = (x: number, y: number): PointRel => ({
    xRel: clampUnitInterval((x - box.x) / box.w),
    yRel: clampUnitInterval((y - box.y) / box.h),
  });

  const pointInRect = (x: number, y: number, r: GlyphRect): boolean =>
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  // Slightly padded rect hit-test for "hard" glyphs (noteheads, stems, rests).
  // This makes taps *near* a note count as "on" the note so we nudge away.
  const pointInPaddedRect = (x: number, y: number, r: GlyphRect, pad: number): boolean =>
    x >= r.x - pad &&
    x <= r.x + r.w + pad &&
    y >= r.y - pad &&
    y <= r.y + r.h + pad;


  // Heuristic: detect very thin horizontal staff lines.
  const isThinHorizontalStaffLine = (g: GlyphRect): boolean => {
    const STAFF_LINE_MAX_H = 3;            // up to ~3px tall
    const STAFF_LINE_MIN_W = box.w * 0.5;  // spans at least half the measure
    return g.h <= STAFF_LINE_MAX_H && g.w >= STAFF_LINE_MIN_W;
  };

  // "Hard" glyphs: noteheads, rests, stems, etc.
  const hitsHardGlyph = (x: number, y: number): boolean => {
    const HARD_GLYPH_PAD_PX = 3; // tweakable: how "near" counts as hitting the glyph

    for (const g of glyphs) {
      if (isThinHorizontalStaffLine(g)) { continue; }
      if (!pointInPaddedRect(x, y, g, HARD_GLYPH_PAD_PX)) { continue; }
      return true;
    }
    return false;
  };

  // Count how many staff-line rects this point lies on.
  const staffLineCountAt = (x: number, y: number): number => {
    let count = 0;
    for (const g of glyphs) {
      if (!isThinHorizontalStaffLine(g)) { continue; }
      if (pointInRect(x, y, g)) {
        count++;
      }
    }
    return count;
  };

  type Candidate = { x: number; y: number; staffLines: number; dy: number };

  // Seed with a dummy value; we track separately whether we actually accepted
  // any candidate that *doesn't* hit a hard glyph.
  let best: Candidate = {
    x: startX,
    y: startY,
    staffLines: 0,
    dy: 0,
  };

  let foundBest = false;

  const considerCandidate = (x: number, y: number): void => {
    if (x < boxLeft || x > boxRight || y < boxTop || y > boxBottom) { return; }
    if (hitsHardGlyph(x, y)) { return; }

    const staffLines = staffLineCountAt(x, y);
    const dy = Math.abs(y - startY);

    if (
      !foundBest ||
      staffLines < best.staffLines ||
      (staffLines === best.staffLines && dy < best.dy)
    ) {
      best = { x, y, staffLines, dy };
      foundBest = true;
    }
  };

  // 1) Consider the original point (but only if it doesn't hit a hard glyph).
  considerCandidate(startX, startY);

  // 2) If the original point hits a hard glyph, look at the specific glyphs it
  //    collides with and try just above/below each one.
  const collidingGlyphs = hitsHardGlyph(startX, startY)
    ? glyphs.filter((g) => pointInRect(startX, startY, g))
    : [];

  const AVOID_MARGIN_PX = 20;                        // how far above/below glyph we try first
  const SEARCH_STEP_PX = 3;                         // finer step to catch spaces between staff lines
  const MAX_OFFSET_PX = Math.max(12, box.h * 0.4);  // don’t wander too far

  for (const g of collidingGlyphs) {
    const centerX = Math.max(boxLeft, Math.min(startX, boxRight));

    const aboveY = g.y - AVOID_MARGIN_PX;
    considerCandidate(centerX, aboveY);

    const belowY = g.y + g.h + AVOID_MARGIN_PX;
    considerCandidate(centerX, belowY);
  }

  // 3) Vertical search: walk up/down from the original tap in small steps.
  for (
    let offset = SEARCH_STEP_PX;
    offset <= MAX_OFFSET_PX;
    offset += SEARCH_STEP_PX
  ) {
    considerCandidate(startX, startY - offset);
    considerCandidate(startX, startY + offset);
  }

  // 4) If we found any acceptable candidate, use the best one.
  if (best !== null) {
    return toRel(best!.x, best!.y);
  }

  // 5) Last resort: fall back to the original point.
  return toRel(startX, startY);
}

type StaffMetrics = {
  trebleMidY: number;
  bassMidY: number;
  staffSpacePx: number;
};

// NAV: function computeStaffMetricsForMeasureFromStaffLines
function computeStaffMetricsForMeasureFromStaffLines(
  measureId: string,
  staffLinesByMeasure: Record<string, GlyphRect[]> | undefined
): StaffMetrics | null {
  const glyphs = staffLinesByMeasure?.[measureId] ?? [];
  if (!glyphs.length) {
    return null;
  }

  // Keep only staff-line glyphs (your diagnostics show these as 'vf-measure')
  const ys = glyphs
    .filter((g) => (g.glyphTag ?? "").toLowerCase().includes("vf-measure"))
    .map((g) => g.y)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);

  if (ys.length < 5) {
    return null;
  }

  // De-dup close y's (some renderers can repeat)
  const uniq: number[] = [];
  const EPS = 0.25;
  for (const y of ys) {
    const last = uniq[uniq.length - 1];
    if (last === undefined || Math.abs(y - last) > EPS) {
      uniq.push(y);
    }
  }

  // Typical piano system: 10 lines (5 treble + 5 bass)
  if (uniq.length >= 10) {
    const treble = uniq.slice(0, 5);
    const bass = uniq.slice(-5);

    const trebleMidY = treble[2]!;
    const bassMidY = bass[2]!;

    const trebleSpaces = [
      treble[1]! - treble[0]!,
      treble[2]! - treble[1]!,
      treble[3]! - treble[2]!,
      treble[4]! - treble[3]!,
    ].filter((d) => d > 0 && Number.isFinite(d));

    const bassSpaces = [
      bass[1]! - bass[0]!,
      bass[2]! - bass[1]!,
      bass[3]! - bass[2]!,
      bass[4]! - bass[3]!,
    ].filter((d) => d > 0 && Number.isFinite(d));

    const allSpaces = [...trebleSpaces, ...bassSpaces].sort((a, b) => a - b);
    const staffSpacePx =
      allSpaces.length > 0
        ? allSpaces[Math.floor(allSpaces.length / 2)]!
        : 0;

    if (!(staffSpacePx > 0) || !Number.isFinite(staffSpacePx)) {
      return null;
    }

    return { trebleMidY, bassMidY, staffSpacePx };
  }

  // Fallback: single staff (use the 3rd line as "mid"; bass == treble)
  const staff = uniq.slice(0, 5);
  if (staff.length < 5) {
    return null;
  }

  const midY = staff[2]!;
  const spaces = [
    staff[1]! - staff[0]!,
    staff[2]! - staff[1]!,
    staff[3]! - staff[2]!,
    staff[4]! - staff[3]!,
  ].filter((d) => d > 0 && Number.isFinite(d)).sort((a, b) => a - b);

  const staffSpacePx =
    spaces.length > 0 ? spaces[Math.floor(spaces.length / 2)]! : 0;

  if (!(staffSpacePx > 0) || !Number.isFinite(staffSpacePx)) {
    return null;
  }

  return { trebleMidY: midY, bassMidY: midY, staffSpacePx };
}


// NAV: -----------------note anchor helpers

// Build a stable list of note anchors for a given measure from its glyph cloud.
// We treat any glyph whose tag contains "notehead" as a candidate.
// Note: this operates in the same page-local coordinate system as GlyphRect
// and MeasureBoxRect.
// NAV: function buildNoteAnchorsForMeasure
function buildNoteAnchorsForMeasure(
  glyphs: readonly GlyphRect[]
): NoteAnchor[] {
  if (!glyphs.length) {
    return [];
  }

  const tagOf = (g: GlyphRect): string => (g.glyphTag ?? "").toLowerCase();

  // ------------------------------------------------------------
  // 0) Collect notehead-tagged glyph rects (notes + rests + junk)
  // ------------------------------------------------------------
  const noteGlyphs = glyphs
    .filter((g) => tagOf(g).includes("notehead"))
    // Sort for stable indexing: left-to-right, then top-to-bottom
    .sort((a, b) => {
      const EPS = 0.0001;

      const cmp = (u: number, v: number): number => {
        const d = u - v;
        if (Math.abs(d) <= EPS) { return 0; }
        return d < 0 ? -1 : 1;
      };

      let c = cmp(a.x, b.x);
      if (c !== 0) { return c; }

      c = cmp(a.y, b.y);
      if (c !== 0) { return c; }

      c = cmp(a.w, b.w);
      if (c !== 0) { return c; }

      return cmp(a.h, b.h);
    });

  if (!noteGlyphs.length) {
    return [];
  }

  const medianOf = (xs: number[]): number => {
    const n = xs.length;
    if (n === 0) { return 0; }
    const mid = Math.floor(n / 2);
    return (n % 2 === 1) ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  };

  // Candidates for baselines: must look like a notehead (not tall rest, not flat ghost)
  const baselineCandidates = noteGlyphs.filter((g) => {
    const w = g.w;
    const h = g.h;
    if (!(w > 0) || !(h > 0)) { return false; }

    const tallRatio = h / w;
    const wideRatio = w / h;
    const aspect = Math.max(tallRatio, wideRatio);

    // exclude tall rests
    if (tallRatio > 1.25) { return false; }
    // exclude flat rectangles / ghosts
    if (wideRatio > 1.35) { return false; }

    // keep only plausible notehead-ish aspect
    return aspect <= 1.35;
  });

  // If we have no candidates, fall back to noteGlyphs (rare)
  const shapeSet = baselineCandidates.length > 0 ? baselineCandidates : noteGlyphs;

  // --- Drop tiny/degenerate specks by absolute pixels (safe) ---
  const ABS_TINY_A = 12;
  const ABS_TINY_W = 3;
  const ABS_TINY_H = 3;

  const nonTinyShapeSet = shapeSet.filter((g) => {
    const w = g.w;
    const h = g.h;
    const a = w * h;
    if (a <= ABS_TINY_A) { return false; }
    if (w <= ABS_TINY_W && h <= ABS_TINY_H) { return false; }
    return true;
  });

  const candidateSet = nonTinyShapeSet.length > 0 ? nonTinyShapeSet : shapeSet;

  // --- Cue/grace suppression: compute baselines from the LARGER noteheads ---
  // Sort candidate areas, drop the bottom 40% (small cluster), keep the rest.
  const candAreasSorted = candidateSet.map((g) => g.w * g.h).slice().sort((a, b) => a - b);
  const cutIdx = Math.floor(candAreasSorted.length * 0.40);
  const areaCut = candAreasSorted[Math.min(cutIdx, Math.max(0, candAreasSorted.length - 1))] ?? 0;

  const baseline = candidateSet.filter((g) => (g.w * g.h) >= areaCut);

  const dimsH = baseline.map((g) => g.h).slice().sort((a, b) => a - b);
  const dimsW = baseline.map((g) => g.w).slice().sort((a, b) => a - b);
  const areas = baseline.map((g) => g.w * g.h).slice().sort((a, b) => a - b);

  // --- Two-cluster support (grace/cue + normal noteheads) ---
  // Split baseline areas into lower/upper halves and compute medians for each.
  const areasSorted = areas; // already sorted
  const midIdx = Math.floor(areasSorted.length / 2);

  const lowHalf = areasSorted.slice(0, Math.max(1, midIdx));
  const highHalf = areasSorted.slice(midIdx);

  const medA_small = Math.max(1, medianOf(lowHalf));
  const medA_big = Math.max(1, medianOf(highHalf));

  const medH = Math.max(1, medianOf(dimsH));
  const medW = Math.max(1, medianOf(dimsW));
  const medA = Math.max(1, medianOf(areas));

  const n = baseline.length;

  // When we only have 1–2 samples, our “typical size” band must be wider.
  const areaLo = n <= 2 ? 0.45 : 0.65;
  const areaHi = n <= 2 ? 2.60 : 1.55;

  // ------------------------------------------------------------
  // 2) Classify each notehead-tagged glyph
  // ------------------------------------------------------------
  const classifyNotehead = (
    g: GlyphRect
  ): { kind: NoteAnchorKind; confidence: number } => {
    const w = g.w;
    const h = g.h;
    if (!(w > 0) || !(h > 0)) {
      return { kind: "unknown", confidence: 0 };
    }

    const area = w * h;
    const aspect = Math.max(w / h, h / w); // 1.0 = square-ish

    // ============================================================
    // 0) High-confidence REST rule (tall + not huge + non-squareish)
    // ============================================================
    const tallRatio = h / w;
    const CLEAR_TALL_REST_RATIO = 1.18;

    const tallEnough = tallRatio >= CLEAR_TALL_REST_RATIO;

    const notHugeForMeasure = area <= medA * (n <= 2 ? 2.40 : 1.55);
    const nonSquareish = aspect >= 1.10;

    if (tallEnough && notHugeForMeasure && nonSquareish) {
      return { kind: "rest", confidence: 0.90 };
    }

    // ============================================================
    // 1) Common filled noteheads (square-ish / slightly oval-ish)
    // ============================================================

    const areaOkSmall =
      area >= medA_small * areaLo && area <= medA_small * areaHi;

    const areaOkBig =
      area >= medA_big * areaLo && area <= medA_big * areaHi;

    const areaOk = areaOkSmall || areaOkBig;

    const squareish = aspect <= 1.30;
    if (squareish && areaOk) {
      return { kind: "note", confidence: 0.78 };
    }

    // ============================================================
    // 2) Whole noteheads: wider ovals
    // ============================================================
    const ovalish = aspect > 1.20 && aspect <= 2.20;

    const ovalSizeOk =
      h >= medH * (n <= 2 ? 0.55 : 0.75) && h <= medH * (n <= 2 ? 2.00 : 1.55) &&
      w >= medW * (n <= 2 ? 0.70 : 0.90) && w <= medW * (n <= 2 ? 2.60 : 2.05);

    const ovalAreaOk =
      area >= medA * (n <= 2 ? 0.45 : 0.70) && area <= medA * (n <= 2 ? 3.00 : 2.40);

    if (ovalish && ovalSizeOk && ovalAreaOk) {
      return { kind: "note", confidence: 0.72 };
    }

    // ============================================================
    // 3) Tiny/degenerate glyphs → "unknown" (layout artifacts)
    // ============================================================
    const tinyByArea = area < medA * 0.18;
    const tinyByDims = (w < medW * 0.35) || (h < medH * 0.35);

    if (tinyByArea && tinyByDims) {
      return { kind: "unknown", confidence: 0.20 };
    }

    // ============================================================
    // 4) Default: if it wasn't a note, treat it as a rest
    // ============================================================
    return { kind: "rest", confidence: 0.70 };
  };

  // ------------------------------------------------------------
  // 3) Emit anchors (+ safe DIAG payload)
  // ------------------------------------------------------------
  const anchors: NoteAnchor[] = [];
  for (let i = 0; i < noteGlyphs.length; i++) {
    const g = noteGlyphs[i]!;
    const cls = classifyNotehead(g);

    const w = g.w;
    const h = g.h;

    const area = (w > 0 && h > 0) ? (w * h) : 0;
    const aspect = (w > 0 && h > 0) ? Math.max(w / h, h / w) : 0;
    const tallRatio = (w > 0) ? (h / w) : 0;

    anchors.push({
      id: `n${i}`,
      x: g.x + w / 2,
      y: g.y + h / 2,
      w,
      h,
      kind: cls.kind,
      confidence: cls.confidence,

      // --- DIAG payload (safe, always defined) ---
      glyphTag: tagOf(g),
      tallRatio,
      aspect,
      area,
    });
  }

  return anchors;
}


// NAV: -----------------component

// NAV: function ScoreViewer
export default function ScoreViewer({
  src,
}: Props) {

  // NAV: ------------------------- dependencies

  // Pull annotation helpers from the provider.
  // This is the ONLY source of truth for annotation data.
  const {
    getAnnotationsForMeasure,
    saveAnnotationsForMeasure,
    saveAnnotationsForMeasures,
    annotationsByMeasure,
    isLoading: annotationsLoading,
    isAuthenticated,
    ensureUserSongRow,
  } = useAnnotations();

  // Always use the latest getAnnotationsForMeasure, even from stable callbacks / pipeline
  const getAnnotationsForMeasureRef = useRef<GetAnnotationsForMeasure>(
    // Default: no annotations
    () => undefined
  );
  useEffect(() => {
    getAnnotationsForMeasureRef.current = getAnnotationsForMeasure;
  }, [getAnnotationsForMeasure]);


  // NAV: ------------------------- top-level state

  const [showGlyphDebug, setShowGlyphDebug] = useState(false);
  useEffect(() => {
    // Run only on the client, after hydration
    if (isDiagOn()) {
      setShowGlyphDebug(true);
    }
  }, []);

  // True once the initial OSMD layout has finished at least once
  const [layoutReady, setLayoutReady] = useState(false);

  const [measurePreviewRect, setMeasurePreviewRect] = useState<SimpleRect | null>(null);
  const measurePreviewHostRef = useRef<HTMLDivElement | null>(null);

  // Currently selected measure + tap position inside it (for upcoming annotation UI)
  const [selectedMeasureNumber, setSelectedMeasureNumber] = useState<number | null>(null);
  const [selectedPointRel, setSelectedPointRel] = useState<PointRel | null>(null);

  // Forces re-render of halo overlay when page geometry changes.
  // measurePreviewRect is already state and tends to change with page interactions.
  // pageNumber (or similar) is even better if you have it; see notes below.
  const [haloEpoch, setHaloEpoch] = React.useState(0);

  React.useEffect(() => {
    if (!isEditModeRef.current || !isAuthenticated) {
      return;
    }
    // Bump once after React commits the new page layout.
    setHaloEpoch((x) => x + 1);
  }, [
    isAuthenticated,
    showGlyphDebug,
    // Pick ONE of these that you know changes on page turns:
    // - currentPageIndex
    // - pageStartIdxsRef.current is NOT reactive (won't work)
    // - any existing state you use to drive paging
  ]);


  // NAV: ------------------------- constants

  const LEFT_PADDING_PX = 6;      // tunable
  const MIN_BOX_WIDTH_PX = 4;     // safety net to avoid degenerate boxes


  // NAV: ------------------------- annotation creation

  type PendingPedalStart = {
    measureNumber: number;
    anchor: PedalAnchorRef;
  };

  const [pendingPedalStart, setPendingPedalStart] =
    React.useState<PendingPedalStart | null>(null);

  // Guards against touch double-fire when starting/finishing pedal creation.
  const beginPedalInFlightRef = React.useRef<boolean>(false);
  const finalizePedalInFlightRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingPedalStart !== null) {
          setPendingPedalStart(null);
          // Optional: clear selection too, to avoid any stray UI state.
          setSelectedMeasureNumber(null);
          setSelectedPointRel(null);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    pendingPedalStart,
    setPendingPedalStart,
    setSelectedMeasureNumber,
    setSelectedPointRel,
  ]);

  // NAV: __ function promptAndSaveAnnotation
  const promptAndSaveAnnotation = React.useCallback(
    async (measureNumber: number, point: PointRel): Promise<void> => {
      if (!isEditModeRef.current) {
        return;
      }

      // NAV: ____ const computePedalAnchorRef
      const computePedalAnchorRef = (
        measureNumberIn: number,
        pointIn: PointRel
      ): PedalAnchorRef | null => {
        const rects = pageMeasureRectsRef.current ?? [];
        const box =
          rects.find((r) => r.measureNumber === measureNumberIn) ?? null;

        if (!box) {
          return null;
        }

        const tipX = box.x + pointIn.xRel * box.w;
        const tipY = box.y + pointIn.yRel * box.h;

        const anchorsForMeasure =
          measureNoteAnchorsRef.current?.[box.id] ?? [];

        if (anchorsForMeasure.length === 0) {
          return null;
        }

        // Nearest notehead/rest in this measure
        let best = anchorsForMeasure[0] as NoteAnchor;
        let bestDistSq =
          (tipX - best.x) * (tipX - best.x) +
          (tipY - best.y) * (tipY - best.y);

        for (let i = 1; i < anchorsForMeasure.length; i++) {
          const cand = anchorsForMeasure[i]!;
          const dx = tipX - cand.x;
          const dy = tipY - cand.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            best = cand;
            bestDistSq = distSq;
          }
        }

        const dx = tipX - best.x;
        const h = best.h;

        if (!(h > 0) || !Number.isFinite(h)) {
          return null;
        }

        const xRel =
          box.w > 0 ? clampUnitInterval((tipX - box.x) / box.w) : pointIn.xRel;

        return {
          noteId: best.id,
          dxRel: dx / h,
          xRel,
        };
      };

      // NAV: ____ const computeFingeringAnchorRef
      const computeFingeringAnchorRef = (
        measureNumberIn: number,
        pointIn: PointRel
      ): FingeringAnchorRef | null => {
        const rects = pageMeasureRectsRef.current ?? [];
        const box =
          rects.find((r) => r.measureNumber === measureNumberIn) ?? null;

        if (!box) {
          return null;
        }

        const tipX = box.x + pointIn.xRel * box.w;
        const tipY = box.y + pointIn.yRel * box.h;

        const anchorsForMeasure =
          measureNoteAnchorsRef.current?.[box.id] ?? [];

        if (anchorsForMeasure.length === 0) {
          return null;
        }

        // Nearest notehead/rest in this measure
        let best = anchorsForMeasure[0] as NoteAnchor;
        let bestDistSq =
          (tipX - best.x) * (tipX - best.x) +
          (tipY - best.y) * (tipY - best.y);

        for (let i = 1; i < anchorsForMeasure.length; i++) {
          const cand = anchorsForMeasure[i]!;
          const dx = tipX - cand.x;
          const dy = tipY - cand.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            best = cand;
            bestDistSq = distSq;
          }
        }

        const dx = tipX - best.x;
        const dy = tipY - best.y;
        const h = best.h;

        if (!(h > 0) || !Number.isFinite(h)) {
          return null;
        }

        const z = osmdZoomRef.current ?? 1;
        // Store note height normalized to OSMD zoom=1 so initial font sizing is consistent
        const baseNoteHNorm = z > 0 ? h / z : h;

        return {
          noteId: best.id,
          dxRel: dx / h,
          dyRel: dy / h,
          baseNoteHNorm,
        };
      };

      // NAV: ____ const computeTextAnchorRef
      const computeTextAnchorRef = (
        measureNumberIn: number,
        pointIn: PointRel
      ): TextAnchorRef | null => {
        const rects = pageMeasureRectsRef.current ?? [];
        const box =
          rects.find((r) => r.measureNumber === measureNumberIn) ?? null;

        if (!box) {
          return null;
        }

        const tipX = box.x + pointIn.xRel * box.w;
        const tipY = box.y + pointIn.yRel * box.h;

        // IMPORTANT: computeStaffMetricsForMeasure must be able to find staff-line glyphs for box.id
        const metrics = computeStaffMetricsForMeasureFromStaffLines(
          box.id,
          staffLineGlyphsByMeasureRef.current
        );
        if (!metrics) {
          return null;
        }

        const modeRaw = window.prompt(
          "Staff text anchor: (M)iddle-between, (T)reble, or (B)ass?",
          "m"
        );
        if (modeRaw === null) {
          return null;
        }

        const modeKey = modeRaw.trim().toLowerCase();
        let mode: TextAnchorMode = "between";
        if (modeKey.startsWith("t")) {
          mode = "treble";
        } else if (modeKey.startsWith("b")) {
          mode = "bass";
        } else {
          mode = "between";
        }

        const staffSpacePx = metrics.staffSpacePx;
        if (!(staffSpacePx > 0) || !Number.isFinite(staffSpacePx)) {
          return null;
        }

        const xRel =
          box.w > 0 ? clampUnitInterval((tipX - box.x) / box.w) : pointIn.xRel;

        let baseY: number;
        if (mode === "treble") {
          baseY = metrics.trebleMidY;
        } else if (mode === "bass") {
          baseY = metrics.bassMidY;
        } else {
          const t = 0.5;
          baseY = metrics.trebleMidY * (1 - t) + metrics.bassMidY * t;
        }

        const dyPx = tipY - baseY;
        const dyRel = dyPx / staffSpacePx;

        const z = osmdZoomRef.current ?? 1;
        // Store staff-space normalized to OSMD zoom=1 so initial size is consistent
        const baseStaffSpaceNorm = z > 0 ? staffSpacePx / z : staffSpacePx;


        const anchor: TextAnchorRef = {
          mode,
          xRel,
          dyRel,
          baseStaffSpaceNorm,
        };

        if (mode === "between") {
          anchor.betweenT = 0.5;
        }

        return anchor;
      };

      const PEDAL_X_EPS = 0.002; // allow "touching" without counting as overlap

      // NAV: ____ const pedalIntervalForMeasure
      const pedalIntervalForMeasure = (
        it: AnnotationPedalItem
      ): { a: number; b: number } | null => {
        const lx = it.left?.xRel;
        const rx = it.right?.xRel;

        // Middle-measure fragment: occupies the whole measure.
        if (it.left === undefined && it.right === undefined) {
          return { a: 0, b: 1 };
        }

        // Single-measure pedal
        if (lx !== undefined && rx !== undefined) {
          const a = Math.min(lx, rx);
          const b = Math.max(lx, rx);
          return { a, b };
        }

        // Start-measure fragment
        if (lx !== undefined) {
          return { a: lx, b: 1 };
        }

        // End-measure fragment
        if (rx !== undefined) {
          return { a: 0, b: rx };
        }

        // If we somehow have anchors but no xRel, we can't do geometry-free overlap checks.
        return null;
      };

      const intervalsOverlap = (
        x: { a: number; b: number },
        y: { a: number; b: number }
      ): boolean => {
        // Allow adjacency: [0.2,0.4] touching [0.4,0.6] is OK.
        return x.a < y.b - PEDAL_X_EPS && y.a < x.b - PEDAL_X_EPS;
      };

      // ==========================================================
      // If a pedal is pending, this drop selects the RIGHT endpoint
      // ==========================================================
      const updates: Record<number, MeasureAnnotation> = {};
      const start = pendingPedalStart;

      if (start !== null) {
        // Re-entrancy guard: touch devices can double-fire quickly
        if (finalizePedalInFlightRef.current) {
          return;
        }
        finalizePedalInFlightRef.current = true;

        // Clear immediately so a second invocation cannot "complete" again
        setPendingPedalStart(null);

        try {
          const endAnchor = computePedalAnchorRef(measureNumber, point);
          if (!endAnchor) {
            // Optional: restore so the user can try dropping the end again
            setPendingPedalStart(start);

            window.alert(
              "No note anchor found for pedal end. Try dropping closer to a notehead/rest."
            );
            return;
          }

          const startMeasure = start.measureNumber;
          const endMeasure = measureNumber;

          const lo = Math.min(startMeasure, endMeasure);
          const hi = Math.max(startMeasure, endMeasure);

          for (let m = lo; m <= hi; m++) {
            const isStart = m === startMeasure;
            const isEnd = m === endMeasure;

            let pedalItem: AnnotationPedalItem;

            if (startMeasure === endMeasure) {
              pedalItem = {
                kind: "pedal",
                left: start.anchor,
                right: endAnchor,
                active: true,
              };
            } else if (isStart) {
              pedalItem = {
                kind: "pedal",
                left: start.anchor,
                active: true,
              };
            } else if (isEnd) {
              pedalItem = {
                kind: "pedal",
                right: endAnchor,
                active: true,
              };
            } else {
              pedalItem = {
                kind: "pedal",
                active: true,
              };
            }

            const existing = getAnnotationsForMeasure(m);
            const existingItems: AnnotationItem[] = Array.isArray(existing?.items)
              ? existing!.items.slice()
              : [];

            const newIv = pedalIntervalForMeasure(pedalItem);
            if (newIv) {
              for (const it of existingItems) {
                if (it.kind !== "pedal") {
                  continue;
                }
                const oldIv = pedalIntervalForMeasure(it);
                if (!oldIv) {
                  continue;
                }
                if (intervalsOverlap(newIv, oldIv)) {
                  // Restore start so user can try again (same pattern you used on end-anchor failure)
                  setPendingPedalStart(start);

                  window.alert(
                    `Pedal overlaps an existing pedal span in measure ${m}. Choose a different start/end.`
                  );
                  return;
                }
              }
            }

            const nextPayload: MeasureAnnotation = {
              ...(existing ?? { items: [] as AnnotationItem[] }),
              items: [...existingItems, pedalItem],
            };

            updates[m] = nextPayload;
          }

          await saveAnnotationsForMeasures(updates);

          setSelectedMeasureNumber(null);
          setSelectedPointRel(null);
          return;
        } finally {
          finalizePedalInFlightRef.current = false;
        }
      }

      // ==========================================================
      // No pending pedal: choose what to create
      // ==========================================================
      const modeRaw = window.prompt(
        "Create: (F)ingering, (T)ext (staff), or (P)edal mark?",
        "f"
      );
      if (modeRaw === null) {
        return;
      }

      const mode = modeRaw.trim().toLowerCase();
      const isPedal = mode.startsWith("p");
      const isText = mode === "t" || mode.startsWith("text");
      const isFingering = mode.startsWith("f") || (!isPedal && !isText);

      if (isPedal) {
        if (beginPedalInFlightRef.current) {
          return;
        }
        beginPedalInFlightRef.current = true;

        try {
          const startAnchor = computePedalAnchorRef(measureNumber, point);
          if (!startAnchor) {
            window.alert(
              "No note anchor found for pedal start. Try dropping closer to a notehead/rest."
            );
            return;
          }

          const existing = getAnnotationsForMeasure(measureNumber);
          const existingItems: AnnotationItem[] = Array.isArray(existing?.items)
            ? existing!.items.slice()
            : [];

          const startX = startAnchor.xRel;

          for (const it of existingItems) {
            if (it.kind !== "pedal") {
              continue;
            }
            const iv = pedalIntervalForMeasure(it);
            if (!iv) {
              continue; // can't evaluate without xRel; ignore for now
            }
            if (startX > iv.a + PEDAL_X_EPS && startX < iv.b - PEDAL_X_EPS) {
              window.alert("That pedal start lands inside an existing pedal span. Choose a gap.");
              return;
            }
          }

          setPendingPedalStart({
            measureNumber,
            anchor: startAnchor,
          });

          setSelectedMeasureNumber(null);
          setSelectedPointRel(null);

          window.alert("Pedal start set. Now select the pedal end (second drop).");
          return;
        } finally {
          // Let subsequent interactions proceed
          beginPedalInFlightRef.current = false;
        }
      }

      if (isText) {
        const label = window.prompt("Text (e.g. rit., dolce, cresc.)?", "");
        if (label === null) {
          return;
        }

        const trimmed = label.trim();
        if (trimmed.length === 0) {
          return;
        }

        const anchorRef = computeTextAnchorRef(measureNumber, point);
        if (!anchorRef) {
          window.alert(
            "Could not compute text anchor for this measure (missing staff-line glyphs?)."
          );
          return;
        }

        const newItem: AnnotationTextItem = {
          kind: "text",
          text: trimmed,
          anchor: anchorRef,
        };

        const existing = getAnnotationsForMeasure(measureNumber);
        const existingItems: AnnotationItem[] = Array.isArray(existing?.items)
          ? existing!.items.slice()
          : [];

        const nextPayload: MeasureAnnotation = {
          ...(existing ?? { items: [] as AnnotationItem[] }),
          items: [...existingItems, newItem],
        };

        void saveAnnotationsForMeasure(measureNumber, nextPayload);

        setSelectedMeasureNumber(null);
        setSelectedPointRel(null);
        return;
      }

      if (!isFingering) {
        // Defensive: unknown input
        return;
      }
      // Fingering path
      {
        const label = window.prompt("Fingering (e.g. 1–5)?", "");
        if (label === null) {
          return;
        }

        const trimmed = label.trim();
        if (trimmed.length === 0) {
          return;
        }

        const anchorRef = computeFingeringAnchorRef(measureNumber, point);
        if (!anchorRef) {
          window.alert("No note anchor found for fingering. Drop closer to a notehead/rest.");
          return;
        }

        const newItem: AnnotationFingeringItem = {
          kind: "fingering",
          text: trimmed,
          anchor: anchorRef,
        };

        const existing = getAnnotationsForMeasure(measureNumber);
        const existingItems: AnnotationItem[] = Array.isArray(existing?.items)
          ? existing!.items.slice()
          : [];

        const nextPayload: MeasureAnnotation = {
          ...(existing ?? { items: [] as AnnotationItem[] }),
          items: [...existingItems, newItem],
        };

        void saveAnnotationsForMeasure(measureNumber, nextPayload);

        setSelectedMeasureNumber(null);
        setSelectedPointRel(null);
      }
    },
    [
      getAnnotationsForMeasure,
      saveAnnotationsForMeasure,
      saveAnnotationsForMeasures,
      pendingPedalStart,
      setPendingPedalStart,
      setSelectedMeasureNumber,
      setSelectedPointRel,
    ],
  );


  // NAV: ------------------------- event handlers

  const [glyphDebugRects, setGlyphDebugRects] =
    useState<Record<string, GlyphRect[]>>({});

  const openMeasurePreview = useCallback(
    (rect: SimpleRect): void => {
      setMeasurePreviewRect(rect);
      void logStep("openMeasurePreview: set rect");
    },
    []
  );

  const closeMeasurePreview = useCallback((): void => {
    // Let React unmount the overlay; no manual DOM surgery.
    setMeasurePreviewRect(null);
  }, []);

  // NAV: __ const handleViewerPointerDownCapture
  const handleViewerPointerDownCapture = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const target = ev.target as HTMLElement | null;
      const isHandle =
        !!target && !!target.closest("[data-annotation-handle='1']");

      // If the pointer-down started on the draggable annotation handle,
      // let the handle-specific logic take over.
      if (isHandle) {
        suppressPageTurnRef.current = true;
        suppressClickRef.current = true;
        return;
      }

      // --- Normal pointer-down path (not on the handle) ---

      // Reset for this gesture
      suppressPageTurnRef.current = false;
      pendingMeasureRectRef.current = null;
      suppressClickRef.current = false;

      if (!isEditModeRef.current) {
        return;
      }

      const rects = measureRectsRef.current;
      const outer = wrapRef.current;

      if (!outer || !rects.length) {
        return;
      }

      const outerBox = outer.getBoundingClientRect();
      const xPage = ev.clientX - outerBox.left;
      const yPage = ev.clientY - outerBox.top;

      for (const box of rects) {
        const withinX = xPage >= box.x && xPage <= box.x + box.w;
        const withinY = yPage >= box.y && yPage <= box.y + box.h;

        if (!withinX || !withinY) {
          continue;
        }

        // This gesture started inside a measure → treat as "edit", not "turn page"
        suppressPageTurnRef.current = true;
        suppressClickRef.current = true;

        pendingMeasureRectRef.current = {
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
        };

        const measureNumber = box.measureNumber;
        if (!(measureNumber > 0) || !Number.isFinite(measureNumber)) {
          setSelectedMeasureNumber(null);
          setSelectedPointRel(null);
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }

        // ✅ Phase 0: do NOT avoid glyph bounding boxes on initial placement.
        // Use the raw tap point (clamped only to unit interval).
        const xRel0 =
          box.w > 0 ? clampUnitInterval((xPage - box.x) / box.w) : 0.5;
        const yRel0 =
          box.h > 0 ? clampUnitInterval((yPage - box.y) / box.h) : 0.5;

        // Place the handle so the *caret tip* (not stem center) lands at the tap point.
        // Caret tip is above by HANDLE_TIP_HEIGHT + HANDLE_STEM_HEIGHT/2.
        const STEM_CENTER_TO_TIP_PX =
          HANDLE_TIP_HEIGHT + (HANDLE_STEM_HEIGHT / 2);

        const yRelAdjusted =
          box.h > 0
            ? clampUnitInterval(yRel0 - (STEM_CENTER_TO_TIP_PX / box.h))
            : yRel0;

        setSelectedMeasureNumber(measureNumber);
        setSelectedPointRel({ xRel: xRel0, yRel: yRelAdjusted });

        // Arm dragging immediately for this gesture (mouse/pen/touch).
        dragPointerIdRef.current = ev.pointerId;
        dragMeasureBoxRef.current = box;
        dragRelRef.current = { xRel: xRel0, yRel: yRelAdjusted };
        dragStartPageRef.current = { x: xPage, y: yPage };
        dragHasMovedRef.current = false;

        try {
          (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        } catch {
          // ignore
        }

        // ✅ Touch improvement: arm dragging immediately on touch down
        if (ev.pointerType === "touch") {
          dragPointerIdRef.current = ev.pointerId;
          dragMeasureBoxRef.current = box;
          dragRelRef.current = null;

          try {
            (outer as unknown as HTMLElement).setPointerCapture(ev.pointerId);
          } catch {
            // ignore
          }
        }

        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      // Click started outside any measure:
      // - do NOT arm/position the pointer
      // - allow the click to fall through for page turning
      setSelectedMeasureNumber(null);
      setSelectedPointRel(null);
    },
    [setSelectedMeasureNumber, setSelectedPointRel],
  );

  // NAV: __ const handleViewerPointerUpCapture
  const handleViewerPointerUpCapture = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      if (!isEditModeRef.current) {
        return;
      }

      if (!suppressPageTurnRef.current) {
        return;
      }

      const rect = pendingMeasureRectRef.current;

      // Eat this gesture so it does NOT become a page turn
      ev.preventDefault();
      ev.stopPropagation();

      // If this pointer-up ends an active drag, decide tap vs drag
      if (dragPointerIdRef.current === ev.pointerId) {
        // Capture needed refs *before* we clear drag state
        const outer = wrapRef.current;
        const rects = measureRectsRef.current;

        // Clear drag state
        dragPointerIdRef.current = null;
        dragMeasureBoxRef.current = null;
        dragStartPageRef.current = null;
        dragHasMovedRef.current = false;

        suppressPageTurnRef.current = false;
        pendingMeasureRectRef.current = null;

        ev.preventDefault();
        ev.stopPropagation();

        // If we can't compute a drop location, do nothing (pointer stays where it is).
        if (!outer || !rects.length) {
          return;
        }

        const outerBox = outer.getBoundingClientRect();

        // Pointer position in "page" coords (viewer-local)
        const pointerX = ev.clientX - outerBox.left;
        const pointerY = ev.clientY - outerBox.top;

        // Must match the move-capture math: caret tip is above by tip + half-stem
        const DRAG_ANCHOR_OFFSET = HANDLE_TIP_HEIGHT + (HANDLE_STEM_HEIGHT / 2);

        const tipX = pointerX;
        const tipY = pointerY - DRAG_ANCHOR_OFFSET;

        // Find the measure box under the drop tip
        // NOTE: We intentionally search ALL measures, not just the one the drag started in.
        let dropBox: PageMeasureRect | null = null;
        for (const b of rects) {
          const withinX = tipX >= b.x && tipX <= b.x + b.w;
          const withinY = tipY >= b.y && tipY <= b.y + b.h;
          if (withinX && withinY) {
            dropBox = b;
            break;
          }
        }

        // Dropped outside any measure → NO-OP (pointer remains visible)
        if (!dropBox) {
          return;
        }

        // Dropped inside a measure: reject if on a glyph bbox (NO-OP)
        // (We exclude staff lines already inside getAvoidanceGlyphsForMeasure.)
        type PageMeasureRectWithId = PageMeasureRect & { id: string };
        const dropBoxWithId = dropBox as PageMeasureRectWithId;

        const glyphRectsForMeasure = getAvoidanceGlyphsForMeasure(dropBoxWithId.id);

        const isBlocked =
          glyphRectsForMeasure.length > 0 &&
          pointHitsAnyRectWithMargin(
            tipX,
            tipY,
            glyphRectsForMeasure,
            AVOID_GLYPH_MARGIN_PX,
          );

        if (isBlocked) {
          return;
        }

        // Compute rel within the DROP measure box (not the start box)
        if (!(dropBox.w > 0) || !(dropBox.h > 0)) {
          return;
        }

        const rel: PointRel = {
          xRel: clampUnitInterval((tipX - dropBox.x) / dropBox.w),
          yRel: clampUnitInterval((tipY - dropBox.y) / dropBox.h),
        };

        const measureNumber = dropBox.measureNumber;
        if (!(measureNumber > 0) || !Number.isFinite(measureNumber)) {
          return;
        }

        // Commit using the actual drop measure + rel
        void promptAndSaveAnnotation(measureNumber, rel);

        // We intentionally do NOT open measure preview here.
        // Drag or tap both act as "drop" for the annotation pointer.
        return;
      }

      // Non-drag gesture: original behavior
      suppressPageTurnRef.current = false;
      pendingMeasureRectRef.current = null;

      if (!rect) {
        return;
      }

      openMeasurePreview(rect);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      openMeasurePreview,
      promptAndSaveAnnotation,
    ],
  );

  // NAV: __ const handleViewerClickCapture
  const handleViewerClickCapture = useCallback(
    (ev: React.MouseEvent<HTMLDivElement>): void => {
      if (!isEditModeRef.current) {
        return;
      }

      if (!suppressClickRef.current) {
        // This click did not come from a measure-start gesture.
        // Let it fall through to normal page-turn logic.
        return;
      }

      // This click is the follow-up to a measure tap/click.
      // Swallow it so the viewer's page-turn handler never sees it.
      suppressClickRef.current = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    []
  );


  // NAV: ------------------------- runtime state

  // Current page's measure rectangles (used for hit-testing in edit mode)
  const measureRectsRef = useRef<ReadonlyArray<MeasureBoxRect>>([]);

  // Per-measure glyph “cloud” in page-local coordinates
  const measureGlyphRectsRef = useRef<Record<string, GlyphRect[]>>({});
  // Per-page cache of note anchors, keyed by measureId (same ids as measureGlyphRectsRef)
  const measureNoteAnchorsRef = useRef<Record<string, NoteAnchor[]>>({});

  // Staff-line glyphs (vf-measure) per measure, used for staff-anchored text.
  const staffLineGlyphsByMeasureRef = useRef<Record<string, GlyphRect[]>>({});


  // Global pedal index derived from annotationsByMeasure.
  // Lives in a ref so we can use it in rendering + edit flows without rerender loops.
  const pedalMarkIndexRef = useRef<PedalMarkIndex>({
    marks: [],
    byStartKey: new Map<string, PedalMark>(),
  });

  const measureAllGlyphRectsRef = useRef<Record<string, GlyphRect[]>>({});

  // Staff lines / envelopes are "vf-measure" in your logs.
  // We do NOT want them to block annotation placement.
  const isStaffLineGlyph = (g: GlyphRect): boolean => {
    const tag = g.glyphTag?.toLowerCase() ?? "";
    return tag.includes("vf-measure");
  };

  // For placement/avoidance, we want:
  //   all glyphs that intersect the measure
  //   EXCEPT staff lines (vf-measure).
  // NAV: __ const getAvoidanceGlyphsForMeasure
  const getAvoidanceGlyphsForMeasure = useCallback(
    (measureId: string): GlyphRect[] => {
      const all: GlyphRect[] = measureAllGlyphRectsRef.current[measureId] ?? [];
      if (!all.length) {
        return [];
      }
      return all.filter((g: GlyphRect) => !isStaffLineGlyph(g));
    },
    [] // no dependencies; refs never change identity
  );

  const suppressPageTurnRef = useRef(false);

  // The measure rect we hit on pointer-down (if any).
  const pendingMeasureRectRef = useRef<SimpleRect | null>(null);

  // if true, the *next click* should be suppressed (for touch devices)
  const suppressClickRef = useRef(false);

  const measureToPageRef = useRef<number[]>([]);

  const topGutterPx = REFLOW.PAD_PX_BASE;
  const bottomGutterPx = REFLOW.PAD_PX_BASE;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  const systemBandsRef = useRef<Band[]>([]);
  const pageStartIdxsRef = useRef<number[]>([0]);
  const pageIdxRef = useRef<number>(0);
  const readyRef = useRef<boolean>(false);

  const DEFAULT_BUSY_MSG = "Please wait…";

  // Busy lock (blocks input while OSMD works)
  const [busy, setBusy] = useState<boolean>(false);
  const [busyMsg, setBusyMsg] = useState<string>(DEFAULT_BUSY_MSG);
  const [fatalReason, setFatalReason] = useState<null | "no-visual-viewport">(null);

  // Spinner ownership + fail-safe timer (used by zoom reflow)
  const spinnerOwnerRef = useRef<symbol | null>(null);
  const spinnerFailSafeRef = useRef<number | null>(null);

  // Debounce + reentry guards for resize/viewport changes
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const [isEditMode, setIsEditMode] = useState<boolean>(false);

  const toggleEditMode = useCallback((): void => {
    setIsEditMode((prev) => {
      const next = !prev;

      // keep the ref in sync
      isEditModeRef.current = next;

      // reflect edit-mode state on the outer container (if present)
      const outer = wrapRef.current;
      if (outer) {
        outer.dataset.viewerEdit = next ? "1" : "0";
      }

      // when leaving edit mode, clear any active measure-preview rectangle
      if (!next) {
        closeMeasurePreview();
      }

      return next;
    });
  }, [closeMeasurePreview]);

  const isEditModeRef = useRef<boolean>(false);

  // Cache the last page's box-draw inputs so we can redraw boxes
  // without repagination when edit mode toggles.
  // NAV: __ const lastBoxDrawArgsRef
  const lastBoxDrawArgsRef = useRef<{
    outer: HTMLDivElement;
    svgNN: SVGSVGElement;
    measures: readonly { id: string; rect: Rect }[];
    geometry: ReadonlyMap<string, MeasureGeom>;
    bandsNN: readonly Band[];
    startIndex: number;
    nextStartIndex: number;
    ySnap: number;
    topGutterPx: number;
    maskTopWithinMusicPx: number;
    rects: ReadonlyArray<MeasureBoxRect>;
  } | null>(null);

  // redraw the boxes for the current page when edit mode toggles
  useEffect(() => {
    // Keep ref in sync with latest state
    isEditModeRef.current = isEditMode;

    // If applyPage hasn't cached geometry yet, do nothing
    const args = lastBoxDrawArgsRef.current;
    if (!args) {
      return;
    }

    try {
      // Always clear boxes first
      clearMeasureBoxes(args.outer);

      // Draw boxes only if edit mode is ON
      if (isEditMode) {
        drawMeasureBoxes(
          args.outer,
          args.svgNN,
          args.measures,
          args.geometry,
          args.bandsNN,
          args.startIndex,
          args.nextStartIndex,
          args.ySnap,
          args.topGutterPx,
          args.maskTopWithinMusicPx,
          args.rects
        );
      }
    } catch { }
  }, [isEditMode]);


  // NAV: ------------------------- perf and init guards

  // Stable per-instance ID (for perf marks), plus a monotonic per-run sequence elsewhere
  const instanceIdRef = useRef<string>(`viewer-${Math.random().toString(36).slice(2, 8)}`);
  const perfSeqRef = useRef(0);
  const nextPerfUID = useCallback((run: string | number | undefined) => {
    perfSeqRef.current += 1;
    return `${instanceIdRef.current}#${run ?? "?"}@${perfSeqRef.current}`;
  }, []);

  // --- Init watchdog guards ---
  const initEpochRef = useRef(0);
  const initFinalizeTimerRef = useRef<number | null>(null);

  const vvTimerRef = useRef<number | null>(null);     // visualViewport debounce

  const handledWRef = useRef<number>(-1);
  const handledHRef = useRef<number>(-1);

  // add near handledWRef/handledHRef
  const reflowRunningRef = useRef(false);            // guards width reflow
  const reflowAgainRef = useRef<"none" | "width" | "height">("none");
  const reflowQueuedCauseRef = useRef<string>("");   // ← remember why a reflow was queued
  const repaginationRunningRef = useRef(false);      // guards height-only repagination


  // NAV: ------------------------- zoom-related refs

  // Track browser zoom relative to mount
  const baseScaleRef = useRef<number>(1);
  const zoomFactorRef = useRef<number>(1);

  // Track user pinch-zoom within the viewer
  const pinchStateRef = useRef<{
    active: boolean;
    startDist: number;
    startZoom: number;
  } | null>(null);

  // OSMD layout zoom factor (1 = OSMD default; affects glyph geometry and annotation scaling)
  const osmdZoomRef = useRef(1);

  // Timestamp of the last touchend, used to suppress synthetic mouse events
  const lastTouchEndRef = useRef<number>(0);

  const clampZoom = (z: number) => Math.max(0.5, Math.min(3, z));

  // NAV: __ const computeZoomFactor
  const computeZoomFactor = useCallback((): number => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const scaleNow = (vv && typeof vv.scale === "number") ? vv.scale : (window.devicePixelRatio || 1);
    const base = baseScaleRef.current || 1;
    const raw = scaleNow / base;
    if (!Number.isFinite(raw) || raw <= 0) { return 1; }
    // Clamp to a sane range so weird browser values don’t explode layout
    return Math.max(0.5, Math.min(3, raw));
  }, []);

  // NAV: __ const applyZoomFromRef
  const applyZoomFromRef = useCallback((): void => {
    const inst = osmdRef.current;
    if (!inst) { return; }

    const z = zoomFactorRef.current;
    if (typeof z !== "number" || !Number.isFinite(z)) { return; }

    const clamped = Math.max(0.5, Math.min(3, z));

    // Only touch Zoom if the instance actually exposes it
    if (hasZoomProp(inst)) {
      const curr = inst.Zoom;
      if (!Number.isFinite(curr) || Math.abs(curr - clamped) > 0.001) {
        try {
          inst.Zoom = clamped;              // changes OSMD zoom
          osmdZoomRef.current = clamped;  // record annotation zoom
        } catch { }
      }
    }
  }, []);


  // NAV: ------------------------- debug wiring

  useEffect(() => {
    // Install debug function
    window.debugShowMeasurePreview = (x: number, y: number, w: number, h: number) => {
      openMeasurePreview({ x, y, w, h });
    };

    return () => {
      // Remove debug function safely
      delete window.debugShowMeasurePreview;
    };
  }, [openMeasurePreview]);


  // NAV: ------------------------- render and layout pipeline

  // Render OSMD at a computed “layout width” derived from wrapper width and current zoom.
  // We temporarily pin the inner host <div> to that width (the “sandbox”), invoke osmd.render(),
  // then restore the host’s styles in finally. No persistent DOM/CSS changes.
  // Safe to call from both init and reflow paths.
  // NAV: __ const renderViewer
  const renderViewer = useCallback(
    async (
      outer: HTMLDivElement,
      osmd: OpenSheetMusicDisplay
    ): Promise<void> => {
      const host = svgHostRef.current;
      if (!host || !outer) { return; }

      const prevFuncTag = outer.dataset.viewerFunc ?? "";
      outer.dataset.viewerFunc = "renderViewer";

      // Use our zoom source of truth
      applyZoomFromRef();
      const zf = Math.min(3, Math.max(0.5, zoomFactorRef.current || 1));

      const hostW = Math.max(1, Math.floor(outer.clientWidth));
      // For internal pinch-zoom, keep layout width tied to CSS width;
      // zoomFactor only affects osmd.Zoom now.
      const rawLayoutW = hostW;

      const widthNudge = REFLOW.WIDTH_NUDGE;
      const MAX_LAYOUT_W = REFLOW.MAX_LAYOUT_W;
      const MIN_LAYOUT_W = REFLOW.MIN_LAYOUT_W;
      const layoutW = Math.max(MIN_LAYOUT_W, Math.min(rawLayoutW + widthNudge, MAX_LAYOUT_W));

      outer.dataset.viewerZf = String(zf);
      outer.dataset.viewerLayoutW = String(layoutW);

      // Capture prior inline styles (so we can restore them exactly)
      const svg = getSvg(outer);
      const prevLeft = host.style.left;
      const prevRight = host.style.right;
      const prevWidth = host.style.width;
      const prevSvgTO = svg?.style.transformOrigin ?? "";

      try {
        // Style sandbox: let width drive layout just for this call
        host.style.left = "0";
        host.style.right = "auto";
        host.style.width = `${layoutW}px`;
        void host.getBoundingClientRect(); // ensure style applies this frame

        // Let spinner/host paint before the heavy render
        await waitForPaint(300);

        await logStep(`layoutW: ${layoutW} hostW: ${hostW} zf: ${zf.toFixed(3)}`,
          { outer, caller: prevFuncTag });

        // Timed core render (isolates synchronous OSMD work)
        perfBlock(
          nextPerfUID(outer.dataset.viewerRun),
          () => { osmd.render(); },
          (ms) => {
            void logStep(`osmd.render() runtime: ${ms}ms`,
              { outer, caller: prevFuncTag });
          }
        );
      } catch (e) {
        void logStep(`render:error ${(e as Error)?.message ?? e}`,
          { outer, caller: prevFuncTag });
        throw e;
      } finally {
        try { outer.dataset.viewerFunc = prevFuncTag; } catch { }

        // Restore EXACT previous inline styles
        host.style.left = prevLeft;
        host.style.right = prevRight;
        host.style.width = prevWidth;

        // Restore prior transform anchor exactly (or remove if you prefer to let applyPage() set it)
        if (svg) { svg.style.transformOrigin = prevSvgTO; }
      }
    },
    [applyZoomFromRef, nextPerfUID]
  );


  // NAV: ------------------------- busy spinner

  const hideBusy = useCallback(() => {
    setBusy(false);
    setBusyMsg(DEFAULT_BUSY_MSG);
  }, []);

  // Spinner helpers config (used by both init + reflow)
  const SPINNER_FAILSAFE_MS = 9000 as const;

  const startSpinner = useCallback(
    async (
      opts?: string | { message?: string; gatePaint?: boolean }
    ): Promise<void> => {
      const msg =
        typeof opts === "string" || opts === undefined
          ? (opts ?? DEFAULT_BUSY_MSG)
          : (opts.message ?? DEFAULT_BUSY_MSG);

      const gatePaint =
        typeof opts === "object" && opts !== null
          ? Boolean(opts.gatePaint)
          : true;

      const token = Symbol("spin");
      spinnerOwnerRef.current = token;

      setBusyMsg(msg);
      setBusy(true);

      // Let overlay mount/paint (best-effort)
      if (gatePaint) {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (document.visibilityState === "visible") {
          await Promise.race([
            new Promise<void>((r) => requestAnimationFrame(() => r())),
            new Promise<void>((r) => setTimeout(r, 120)),
          ]);
        }
      }

      // (Re)arm fail-safe — silent on fire (per your request)
      if (spinnerFailSafeRef.current) {
        window.clearTimeout(spinnerFailSafeRef.current);
      }
      spinnerFailSafeRef.current = window.setTimeout(() => {
        spinnerOwnerRef.current = null;
        hideBusy();
      }, SPINNER_FAILSAFE_MS);
    },
    [hideBusy]
  );

  // NAV: __ const stopSpinner
  const stopSpinner = useCallback(
    async (): Promise<void> => {
      spinnerOwnerRef.current = null;
      if (spinnerFailSafeRef.current) {
        window.clearTimeout(spinnerFailSafeRef.current);
        spinnerFailSafeRef.current = null;
      }

      hideBusy();

      // Give the UI a beat to commit the un-busy frame
      await new Promise<void>((r) => setTimeout(r, 0));
      if (document.visibilityState === "visible") {
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => r())),
          new Promise<void>((r) => setTimeout(r, 180)),
        ]);
      }
    },
    [hideBusy]
  );


  // NAV: ------------------------- reflow plumbing

  // ---- callback ref proxies (used by queued window.setTimeouts) ----
  const reflowFnRef = useRef<ReflowCallback>(async () => { });
  const repagFnRef = useRef<() => void>(() => { });

  const vpHRef = useVisibleViewportHeight();

  const getViewportH = useCallback((outer: HTMLDivElement): number => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const vvH = vv ? Math.floor(vv.height) : 0;
    const outerH = outer.clientHeight || 0;
    const docH = Math.floor(document.documentElement?.clientHeight || 0);

    // If VV and wrapper disagree a lot (URL/tool bars mid-animation),
    // be conservative and take the smaller so we never overfill page 1.
    let base: number;
    if (vvH && outerH && Math.abs(vvH - outerH) > 24) {
      base = Math.min(vvH, outerH);
    } else {
      base = outerH || vvH || docH;
    }

    return Math.max(1, Math.floor(base) - Math.max(0, topGutterPx));
  }, [topGutterPx]
  );

  const bottomPeekPad = useCallback(
    () => ((window.devicePixelRatio || 1) >= 2
      ? REFLOW.BOTTOM_PEEK_PAD_HI_DPR
      : REFLOW.BOTTOM_PEEK_PAD_LO_DPR),
    []
  );

  const visiblePageHeight = useCallback(
    (outer: HTMLDivElement) => Math.max(1, getViewportH(outer) - bottomPeekPad()),
    [getViewportH, bottomPeekPad]
  );

  // --- Unify pagination height (memoized so identity is stable) ---
  const paginationHeight = useCallback(
    (outer: HTMLDivElement) => visiblePageHeight(outer) + REFLOW.PAGE_FILL_SLOP_PX,
    [visiblePageHeight]
  );


  // NAV: ------------------------- page geometry

  const measuresRef = useRef<ReadonlyArray<{ id: string; rect: Rect }>>([]);
  const barCandsRef = useRef<ReadonlyArray<BarCand>>([]);
  const geometryRef = useRef<ReadonlyMap<string, MeasureGeom>>(new Map());
  const pageMeasureRectsRef = useRef<MeasureBoxRect[]>([]);

  // Tracks the pointer currently dragging the annotation handle, if any.
  const dragPointerIdRef = useRef<number | null>(null);
  // Draggable annotation handle element (the caret wrapper)
  const annotationHandleRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether we are currently dragging the annotation handle
  // keep track of drag geometry without re-rendering
  type PageMeasureRect = (typeof pageMeasureRectsRef.current)[number];
  const dragMeasureBoxRef = useRef<PageMeasureRect | null>(null);
  // Live drag position in *relative* measure coordinates during a drag.
  // When not dragging, this may be null.
  const dragRelRef = useRef<{ xRel: number; yRel: number } | null>(null);

  const dragStartPageRef = useRef<{ x: number; y: number } | null>(null);
  const dragHasMovedRef = useRef<boolean>(false);

  // Build a “glyph cloud” for the measures on the current page.
  // For each visible SVG graphics element, we compute its page-local bounding box
  // and associate it with every measure box it intersects. Results are cached in
  // measureGlyphRectsRef by measureId.
  // NAV: __ const populateGlyphRectsForPage
  const populateGlyphRectsForPage = useCallback(
    (outer: HTMLDivElement, rects: ReadonlyArray<MeasureBoxRect>): void => {

      if (!rects.length) {
        // Clear when there are no measures on this page
        measureGlyphRectsRef.current = {};
        measureNoteAnchorsRef.current = {};
        measureAllGlyphRectsRef.current = {};
        if (showGlyphDebug) {
          setGlyphDebugRects({});
        }
        return;
      }

      const svg = getSvg(outer);
      if (!svg) {
        measureGlyphRectsRef.current = {};
        measureNoteAnchorsRef.current = {};
        measureAllGlyphRectsRef.current = {};
        if (showGlyphDebug) {
          setGlyphDebugRects({});
        }
        return;
      }

      const outerRect = outer.getBoundingClientRect();
      const perMeasure = new Map<string, GlyphRect[]>();
      for (const box of rects) {
        perMeasure.set(box.id, []);
      }

      const SELECTORS = "path,rect,circle,ellipse,polygon,polyline,line,text";
      const glyphNodes = svg.querySelectorAll<SVGGraphicsElement>(SELECTORS);

      const pageW = outerRect.width || 1;
      const pageH = outerRect.height || 1;

      for (const el of glyphNodes) {
        const r = el.getBoundingClientRect();

        if (
          !Number.isFinite(r.left) ||
          !Number.isFinite(r.top) ||
          !Number.isFinite(r.width) ||
          !Number.isFinite(r.height)
        ) {
          continue;
        }

        const w = r.width;
        const h = r.height;

        if (w <= 0 && h <= 0) {
          continue;
        }

        const effW = w === 0 ? 1 : w;
        const effH = h === 0 ? 1 : h;

        const gx = r.left - outerRect.left;
        const gy = r.top - outerRect.top;

        // Skip page-sized container boxes
        if (effW > pageW * 0.95 && effH > pageH * 0.95) {
          continue;
        }

        // climb up the DOM tree to find a vf-* class
        let glyphKind: string | undefined;
        let node: Element | null = el;
        while (node) {
          const cls = node.getAttribute("class") || "";
          if (cls) {
            const vfClass = cls
              .split(/\s+/)
              .find((c) => c.startsWith("vf-") || c.startsWith("vf_"));
            if (vfClass) {
              glyphKind = vfClass;
              break;
            }
          }
          node = node.parentElement;
        }

        // Fallbacks if we didn't find anything semantic
        if (!glyphKind) {
          glyphKind = el.tagName.toLowerCase(); // "path", "rect", etc.
        }

        const glyphRect: GlyphRect = {
          x: gx,
          y: gy,
          w: effW,
          h: effH,
          glyphTag: glyphKind,   // this is what refineMeasure... uses
        };

        for (const box of rects) {
          const intersects =
            glyphRect.x + glyphRect.w > box.x &&
            glyphRect.x < box.x + box.w &&
            glyphRect.y + glyphRect.h > box.y &&
            glyphRect.y < box.y + box.h;

          if (intersects) {
            const arr = perMeasure.get(box.id);
            if (arr) {
              arr.push(glyphRect);
            }
          }
        }
      }

      const next: Record<string, GlyphRect[]> = {};
      const nextAnchors: Record<string, NoteAnchor[]> = {};
      const nextAllGlyphs: Record<string, GlyphRect[]> = {};

      const boxById = new Map<string, MeasureBoxRect>();
      for (const b of rects) {
        boxById.set(b.id, b);
      }

      for (const [measureId, glyphs] of perMeasure.entries()) {
        if (glyphs.length) {
          // All glyphs (for avoidance / diagnostics)
          nextAllGlyphs[measureId] = glyphs.slice();  // shallow copy

          // Existing behavior
          next[measureId] = glyphs;

          // build note anchors for this measure from its glyphs
          const anchors = buildNoteAnchorsForMeasure(glyphs);
          if (anchors.length) {
            nextAnchors[measureId] = anchors;
          }
        }
      }

      // Cache glyphs + note anchors for this page
      measureGlyphRectsRef.current = next;
      measureNoteAnchorsRef.current = nextAnchors;
      measureAllGlyphRectsRef.current = nextAllGlyphs;

      if (showGlyphDebug) {
        setGlyphDebugRects(next);
      }

      if (isDiagOn()) {
        const summary = rects
          .map((box) => {
            const count = (perMeasure.get(box.id) ?? []).length;
            return `${box.id}:${count}`;
          })
          .join(" ");
        void logStep(`glyphRects: ${summary}`, {
          outer,
          caller: "populateGlyphRectsForPage",
        });
      }
    },
    [showGlyphDebug, setGlyphDebugRects]
  );


  // NAV: ------------------------- page application

  // Apply the chosen page to the viewport: translate the SVG to its start and mask/cut to hide any next-page peek.
  // May recompute page starts and re-apply to preserve whole systems; bounded recursion prevents oscillation.
  // NAV: __ const applyPage
  const applyPage = useCallback(
    (pageIdx: number): void => {
      const outer = wrapRef.current;
      if (!outer) {
        return;
      }

      // clear any existing measure preview when we change pages
      closeMeasurePreview();

      function bottomPeekPadPx(): number {
        return window.devicePixelRatio >= 2
          ? REFLOW.BOTTOM_PEEK_PAD_HI_DPR
          : REFLOW.BOTTOM_PEEK_PAD_LO_DPR;
      }

      // Visible height that the music can actually occupy on a page, after gutters/peek pad.
      function usablePageHeight(
        outer: HTMLDivElement,
        topPad: number,
        bottomPad: number
      ): number {
        const hVisible = visiblePageHeight(outer);
        const botPeek = bottomPeekPadPx();
        const usable =
          hVisible - Math.max(0, topPad) - Math.max(0, bottomPad) - botPeek;
        return Math.max(0, usable);
      }

      const prevFuncTag = outer.dataset.viewerFunc ?? "";
      outer.dataset.viewerFunc = "applyPage";

      try {
        const svg = getSvg(outer);
        const bands = systemBandsRef.current;
        const starts = pageStartIdxsRef.current;

        if (!svg || !bands.length || !starts.length) {
          return;
        }

        // TS strict: capture narrowed aliases so flow analysis stays stable below
        const svgNN: SVGSVGElement = svg;
        const bandsNN: Band[] = bands;

        // Clamp target page and remember it
        const pages = starts.length;
        const p = Math.max(0, Math.min(pageIdx, pages - 1));
        pageIdxRef.current = p;

        // Start band for this page
        const startIndex = starts[p] ?? 0;
        const startBand = bands[startIndex];
        if (!startBand) {
          return;
        }

        // NEXT page start (or -1 on last page) — this fixes the “line disappears” issue
        const nextStartIndex = p + 1 < pages ? starts[p + 1]! : -1;

        // Align the music so the start band sits at the top gutter
        const ySnap = Math.ceil(startBand.top);
        svg.style.transform = `translateY(${-ySnap + Math.max(0, topGutterPx)}px)`;
        svg.style.transformOrigin = "top left";
        svg.style.willChange = "transform";

        if (isDiagOn()) {
          drawBandGuides(svg, bands, startIndex, nextStartIndex);
        }

        // Visible height (raw) and usable height inside gutters/peek pad
        const PAGE_H_USABLE = usablePageHeight(
          outer,
          Math.max(0, topGutterPx),
          Math.max(0, bottomGutterPx)
        );

        // Last band we want to *show* on this page (based only on starts[])
        const lastIdxThisPage =
          nextStartIndex >= 0 ? nextStartIndex - 1 : bands.length - 1;

        // --- MASK: cut exactly at the next system’s top, or just past the last on final page
        let maskTopWithinMusicPx = PAGE_H_USABLE;
        if (nextStartIndex >= 0) {
          // Non-last page: stop just above the next system so nothing peeks
          const nextTopRel = bands[nextStartIndex]!.top - ySnap;
          maskTopWithinMusicPx = Math.min(
            PAGE_H_USABLE,
            Math.max(0, Math.floor(nextTopRel) - 1)
          );
        } else {
          // Last page: allow a safety pad to avoid shaving hairpins/slurs
          const lastRel = bands[lastIdxThisPage]!.bottom - ySnap;
          maskTopWithinMusicPx = Math.min(
            PAGE_H_USABLE,
            Math.max(0, Math.ceil(lastRel) + REFLOW.MASK_BOTTOM_SAFETY_PX)
          );
        }

        // Breadcrumbs for debugging
        outer.dataset.viewerPage = String(p);
        outer.dataset.viewerPages = String(pages);
        outer.dataset.viewerH = String(PAGE_H_USABLE);
        outer.dataset.viewerMaskTop = String(maskTopWithinMusicPx);
        outer.dataset.viewerTy = String(-ySnap + Math.max(0, topGutterPx));
        outer.dataset.viewerStarts = starts.slice(0, 12).join(",");
        outer.dataset.viewerTopGutter = String(Math.max(0, topGutterPx));
        outer.dataset.viewerBotGutter = String(Math.max(0, bottomGutterPx));

        // Create/update mask & cutters
        let mask = outer.querySelector<HTMLDivElement>("[data-viewer-mask='1']");
        if (!mask) {
          mask = document.createElement("div");
          mask.dataset.viewerMask = "1";
          Object.assign(mask.style, {
            position: "absolute",
            left: "0",
            right: "0",
            top: "0",
            bottom: "0",
            background: "#fff",
            pointerEvents: "none",
            zIndex: "10",
          } as CSSStyleDeclaration);
          outer.appendChild(mask);
        }
        mask.style.top = `${Math.max(0, topGutterPx) + maskTopWithinMusicPx
          }px`;

        let bottomCutter = outer.querySelector<HTMLDivElement>(
          "[data-viewer-bottomcutter='1']"
        );
        const needsMask = maskTopWithinMusicPx < PAGE_H_USABLE;

        const lastForLog =
          nextStartIndex >= 0 ? nextStartIndex - 1 : bands.length - 1;
        if (isDiagOn()) {
          void logStep(
            `pages: ${p + 1}/${pages} startIndex: ${startIndex} lastForLog: ${lastForLog} ` +
            `nextStartIndex: ${nextStartIndex >= 0 ? `${nextStartIndex}` : "end"
            } ` +
            `ySnap: ${ySnap} PAGE_H_USABLE: ${PAGE_H_USABLE} maskTopWithinMusicPx: ${maskTopWithinMusicPx} needsMask: ${needsMask}`,
            { outer, caller: prevFuncTag }
          );
        }
        const first = startIndex;
        const last = lastForLog;
        const list = Array.from(
          { length: last - first + 1 },
          (_, j) => first + j
        ).join(",");
        logStep(`pageBands: [${list}]`, { outer, caller: prevFuncTag });

        if (!bottomCutter) {
          bottomCutter = document.createElement("div");
          bottomCutter.dataset.viewerBottomcutter = "1";
          Object.assign(bottomCutter.style, {
            position: "absolute",
            left: "0",
            right: "0",
            bottom: "0",
            background: "#fff",
            pointerEvents: "none",
            zIndex: "6",
          } as CSSStyleDeclaration);
          outer.appendChild(bottomCutter);
        }
        bottomCutter.style.height = `${Math.max(0, bottomGutterPx)}px`;
        bottomCutter.style.display = "block";

        let topCutter = outer.querySelector<HTMLDivElement>(
          "[data-viewer-topcutter='1']"
        );
        if (!topCutter) {
          topCutter = document.createElement("div");
          topCutter.dataset.viewerTopcutter = "1";
          Object.assign(topCutter.style, {
            position: "absolute",
            left: "0",
            right: "0",
            top: "0",
            background: "#fff",
            pointerEvents: "none",
            zIndex: "6",
          } as CSSStyleDeclaration);
          outer.appendChild(topCutter);
        }
        topCutter.style.height = `${Math.max(0, topGutterPx)}px`;

        // --- Measure rectangles + annotation overlay ---
        // Always redraw after pagination transform so overlays match what you see.
        try {
          const measuresForPage = measuresRef.current ?? [];
          const geomForPage =
            geometryRef.current ?? new Map<string, MeasureGeom>();

          // LOCAL helper: refine barline-to-barline boxes using per-measure glyph geometry.
          // For each measure:
          //   - Look at all glyphs we associated with this measure.
          //   - Drop obvious staff lines and measure-wide “envelope” paths.
          //   - Drop obvious preamble (clef, key sig, time sig, barlines, braces, etc.).
          //   - Prefer noteheads + rests as “structural” anchors.
          //   - Position the box LEFT_PADDING_PX to the left of that glyph,
          //     clamped to the original barline envelope.
          // NAV: ____ refineMeasureBoxRectsWithGlyphs
          const refineMeasureBoxRectsWithGlyphs = (
            rawRects: ReadonlyArray<MeasureBoxRect>,
            glyphsByMeasure: Record<string, GlyphRect[]> | undefined
          ): MeasureBoxRect[] => {
            if (!rawRects.length) {
              return [];
            }

            // Single source of truth for "what can drive a measure box".
            const isStructuralContentGlyph = (g: GlyphRect): boolean => {
              const { w, h, glyphTag } = g;

              // Geometry sanity
              if (!Number.isFinite(w) || !Number.isFinite(h)) {
                return false;
              }

              const tag = glyphTag?.toLowerCase() ?? "";

              // ---- Whitelist: genuine per-measure musical content -------------------
              // Notes + rests
              if (tag.includes("notehead")) { return true; }

              // Note structure
              if (tag.includes("stem")) { return true; }
              if (tag.includes("beam")) { return true; }
              if (tag.includes("flag")) { return true; }

              // Accidentals, fermatas, etc.
              if (tag.includes("modifiers")) { return true; }

              // Everything else: ignore (staff lines, barlines, braces, etc.)
              return false;
            };

            const result: MeasureBoxRect[] = [];

            // structural glyphs per measure, to be cached globally.
            const structuralByMeasure: Record<string, GlyphRect[]> = {};

            // staff-line glyphs per measure (vf-measure), cached globally.
            const staffLinesByMeasure: Record<string, GlyphRect[]> = {};

            for (const raw of rawRects) {
              const barLeft = raw.x;
              const barRight = raw.x + raw.w;

              if (
                !Number.isFinite(barLeft) ||
                !Number.isFinite(barRight) ||
                barRight <= barLeft
              ) {
                // Defensive: leave this box alone
                result.push(raw);
                continue;
              }

              const glyphs = glyphsByMeasure?.[raw.id] ?? [];

              // Cache staff lines (vf-measure) BEFORE we filter glyphs down to "structural" only.
              const staffLines = glyphs.filter((g) => {
                const tag = g.glyphTag?.toLowerCase() ?? "";
                return tag === "vf-measure";
              });

              if (staffLines.length) {
                staffLinesByMeasure[raw.id] = staffLines;
              }

              if (!glyphs.length) {
                result.push(raw);
                continue;
              }

              // Only keep whitelisted “structural” glyphs
              const structural = glyphs.filter(isStructuralContentGlyph);

              if (structural.length) {
                // Cache structural glyphs for this measure so we can reuse them
                structuralByMeasure[raw.id] = structural;
              }

              if (!structural.length) {
                // Nothing we trust → keep the original envelope box
                result.push(raw);
                continue;
              }

              // Leftmost structural glyph in page-local coords
              let firstContentX = structural[0]!.x;
              for (let i = 1; i < structural.length; i++) {
                const gx = structural[i]!.x;
                if (gx < firstContentX) {
                  firstContentX = gx;
                }
              }

              const proposedLeft = firstContentX - LEFT_PADDING_PX;
              let newLeft = proposedLeft;

              // Clamp to original barline envelope
              if (newLeft < barLeft) {
                newLeft = barLeft;
              }
              if (newLeft > barRight - MIN_BOX_WIDTH_PX) {
                newLeft = barRight - MIN_BOX_WIDTH_PX;
              }

              const newWidth = Math.max(MIN_BOX_WIDTH_PX, barRight - newLeft);

              if (isDiagOn()) {
                // eslint-disable-next-line no-console
                console.log("[REFINE DEBUG]", {
                  measureId: raw.id,
                  measureNumber: raw.measureNumber,
                  barLeft,
                  barRight,

                  glyphCount: glyphs.length,
                  structuralCount: structural.length,

                  firstContentX,
                  proposedLeft,
                  finalLeft: newLeft,
                  dxFromBar: newLeft - barLeft,

                  // Structural glyphs (as before)
                  structural: structural
                    .slice()
                    .sort((a, b) => {
                      if (a.x !== b.x) { return a.x - b.x; }
                      return a.y - b.y;
                    })
                    .map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, tag: g.glyphTag })),

                  allGlyphs: glyphs
                    .slice()
                    .sort((a, b) => {
                      if (a.x !== b.x) { return a.x - b.x; }
                      return a.y - b.y;
                    })
                    .map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, tag: g.glyphTag })),
                });
              }

              result.push({
                ...raw,
                x: newLeft,
                w: newWidth,
              });
            }

            // globally cache the structural glyphs so everyone else can use them.
            // After this, measureGlyphRectsRef.current contains ONLY structural glyphs
            // (noteheads, stems, beams, modifiers), NOT staff lines, envelopes, etc.
            measureGlyphRectsRef.current = structuralByMeasure;

            staffLineGlyphsByMeasureRef.current = staffLinesByMeasure;

            return result;
          };

          // 1) Compute barline-based "envelope" rects for THIS page
          const rawRects = computeMeasureBoxRectsForPage(
            measuresForPage,
            geomForPage,
            bandsNN,
            startIndex,
            nextStartIndex,
            ySnap,
            Math.max(0, topGutterPx),
            maskTopWithinMusicPx
          );

          if (isDiagOn()) {
            // For each measure box, find which band its vertical midpoint sits in.
            const bandSummary = rawRects
              .map((r) => {
                const midY = r.y + r.h / 2;
                const bandIdx = bandsNN.findIndex(
                  (b) => midY >= b.top - 0.5 && midY <= b.bottom + 0.5
                );
                return `${r.id}@${midY.toFixed(0)}→b${bandIdx}`;
              })
              .join(" ");

            void logStep(
              `pageRects: page=${p} startIndex=${startIndex} nextStartIndex=${nextStartIndex} ` +
              `maskTop=${maskTopWithinMusicPx.toFixed(0)} rects=${rawRects.length} ` +
              `${bandSummary}`,
              { outer, caller: "applyPage/pageRects" }
            );
          }

          // 2) Build per-measure glyph "cloud" from the rendered SVG for this page
          //    (uses rawRects as envelopes to associate glyphs to measures)
          populateGlyphRectsForPage(outer, rawRects);

          // 3) Refine rects using glyphs: now boxes start near the first "real" glyph
          const glyphsByMeasure = measureGlyphRectsRef.current;
          const rects = refineMeasureBoxRectsWithGlyphs(
            rawRects,
            glyphsByMeasure
          );

          // 4) Cache REFined rects for hit-testing / annotation logic
          pageMeasureRectsRef.current = rects;
          measureRectsRef.current = rects;

          // 5) Cache args (including refined rects) for edit-mode redraws
          lastBoxDrawArgsRef.current = {
            outer,
            svgNN,
            measures: measuresForPage,
            geometry: geomForPage,
            bandsNN,
            startIndex,
            nextStartIndex,
            ySnap,
            topGutterPx: Math.max(0, topGutterPx),
            maskTopWithinMusicPx,
            rects, // refined measure boxes for this page
          };

          // 6) Draw annotation fill layer (always visible, read + edit mode)
          clearAnnotationBoxes(outer);
          const getter = getAnnotationsForMeasureRef.current;
          if (rects.length && getter) {
            drawAnnotationBoxes(
              outer,
              rects,
              getter,
              osmdZoomRef.current,
              measureNoteAnchorsRef.current,    // per-page note anchors
              staffLineGlyphsByMeasureRef.current
            );
          }

          // 7) Draw stroke-only measure boxes when edit mode is active, using refined rects
          clearMeasureBoxes(outer);
          if (isEditModeRef.current) {
            drawMeasureBoxes(
              outer,
              svgNN,
              measuresForPage,
              geomForPage,
              bandsNN,
              startIndex,
              nextStartIndex,
              ySnap,
              Math.max(0, topGutterPx),
              maskTopWithinMusicPx,
              rects
            );
          }
        } catch {
          // viewer should not die over overlay drawing
          pageMeasureRectsRef.current = [];
        }

        // Stop layer promotion after page is applied
        svg.style.willChange = "auto";
      } finally {
        try {
          outer.dataset.viewerFunc = prevFuncTag;
        } catch {
          // ignore
        }
      }

      setHaloEpoch((x) => x + 1);

    },
    [
      visiblePageHeight,
      topGutterPx,
      bottomGutterPx,
      closeMeasurePreview,
      populateGlyphRectsForPage,
    ]
  );


  // NAV: ------------------------- annotation redraw effect

  // When annotations finish loading or change, re-render the current page
  // so that drawAnnotationBoxes runs again with fresh annotation data.
  useEffect(() => {
    // Only run once:
    //  - annotations are finished loading
    //  - we've successfully applied at least one page layout
    if (annotationsLoading || !layoutReady) {
      return;
    }

    const outer = wrapRef.current;
    if (!outer) {
      return;
    }

    const idx = buildPedalMarkIndex(annotationsByMeasure);
    pedalMarkIndexRef.current = idx;

    if (isDiagOn()) {
      void logStep(
        `[pedal-index] marks=${idx.marks.length} byStartKey=${idx.byStartKey.size}`,
        { outer }
      );
    }

    const currentPage = Math.max(0, pageIdxRef.current || 0);

    const prevFunc = outer.dataset.viewerFunc ?? "";
    outer.dataset.viewerFunc = "annotation redraw";

    try {
      void logStep(
        `page=${currentPage} measures=${Object.keys(
          annotationsByMeasure
        ).length}`,
        { outer }
      );
      applyPage(currentPage);
    } finally {
      outer.dataset.viewerFunc = prevFunc;
    }
  }, [annotationsLoading, annotationsByMeasure, layoutReady, applyPage]);


  // NAV: ------------------------- layout pipeline helpers

  // Hide the SVG host while we do heavy work, then restore previous styles.
  // NAV: __ const withHostHidden
  const withHostHidden = useCallback(async <T,>(
    outer: HTMLDivElement,
    work: () => Promise<T>
  ): Promise<T> => {
    const host = svgHostRef.current;
    let prevVis = "";
    let prevCv = "";
    if (host) {
      prevVis = host.style.visibility || "";
      prevCv = host.style.getPropertyValue("content-visibility") || "";
      host.style.removeProperty("content-visibility");
      host.style.visibility = "hidden";
      try { void host.getBoundingClientRect().width; } catch { }
    }
    try {
      return await work();
    } finally {
      if (host) {
        if (prevCv) { host.style.setProperty("content-visibility", prevCv); }
        else { host.style.removeProperty("content-visibility"); }
        if (prevVis) { host.style.visibility = prevVis; }
        else { host.style.removeProperty("visibility"); }
      }
    }
  }, []);

  // Full layout pipeline:
  // renderViewer()  → scanSystemsPx() → computePageStarts() → applyPage(0)
  // Optionally double-applies page 1 to settle masking; bounded by a paint gate.
  // Returns {bands, starts} for callers to stash.
  // NAV: __ const layoutViewer
  const layoutViewer = useCallback(async (
    outer: HTMLDivElement,
    osmd: OpenSheetMusicDisplay,
    opts?: {
      gateLabel?: string;     // label for after-paint breadcrumb
      gateMs?: number;        // paint gate timeout
      doubleApply?: boolean;  // whether to applyPage(0) twice (reflow=yes, init=no)
    }
  ): Promise<{ bands: Band[]; starts: number[] }> => {
    const { gateLabel = "apply:first", gateMs = 400, doubleApply = true } = opts ?? {};

    const prevFuncTag = outer.dataset.viewerFunc ?? "";
    outer.dataset.viewerFunc = "layoutViewer";
    outer.dataset.viewerPhase = "render";
    await logStep("phase starting", { outer, caller: prevFuncTag });

    // Hide the SVG host for the entire layout so we never show an intermediate,
    // unmasked OSMD render behind the translucent busy overlay. withHostHidden()
    // still wraps renderViewer(), but this outer guard keeps the host invisible
    // until applyPage() has finished.
    const hostForLayout = svgHostRef.current;
    let prevHostVis = "";
    let prevHostCv = "";
    if (hostForLayout) {
      prevHostVis = hostForLayout.style.visibility || "";
      prevHostCv = hostForLayout.style.getPropertyValue("content-visibility") || "";
      hostForLayout.style.removeProperty("content-visibility");
      hostForLayout.style.visibility = "hidden";
      try { void hostForLayout.getBoundingClientRect().width; } catch { }
    }

    const currentPageBeforeLayout = pageIdxRef.current ?? 0;

    let anchorMeasure: number | null = null;
    if (measureToPageRef.current.length > 0) {
      anchorMeasure = findAnchorMeasure(
        measureToPageRef.current,
        currentPageBeforeLayout
      );
    }

    try {
      const ap = makeAfterPaint(outer);

      await withHostHidden(outer, async () => {
        // Clear any stale overlays before a fresh render
        try { clearMeasureBoxes(outer); } catch { }

        const uid = nextPerfUID(outer.dataset.viewerRun);
        await perfBlockAsync(
          uid,
          async () => { await renderViewer(outer, osmd); },
          (ms) => { void logStep(`renderViewer runtime: ${ms}ms`, { outer, caller: prevFuncTag }); }
        );
      });

      await new Promise<void>((r) => setTimeout(r, 0)); // yield one task

      await logStep("phase finished", { outer, caller: prevFuncTag });
      outer.dataset.viewerPhase = "scan";
      await logStep("phase starting", { outer, caller: prevFuncTag });

      const svgForPack = getSvg(outer);
      if (!svgForPack) {
        outer.dataset.viewerFatal = "no-svg";
        outer.dataset.viewerErr = "OSMD did not produce an <svg> element.";
        throw new Error("No SVG produced by OSMD render");
      }

      // Scan (raw) then derive padded bands capped by the gutters
      const rawBands = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => withSvgAtUnitScale(outer, (svg) => scanSystemsPx(outer, svg)) ?? [],
        (ms) => { void logStep(`scanSystemsPx() runtime: ${ms}ms`, { outer, caller: prevFuncTag }); }
      );

      const bands = derivePaddedBands(
        rawBands,
        Math.max(0, topGutterPx),
        Math.max(0, bottomGutterPx)
      );

      validateBandSpacing(outer, bands, { minGapAlertPx: 2 });

      // --- precompute measures & bar-cands once at unit scale (page-local px) ---
      {
        const res = withSvgAtUnitScale(outer, (svg) => {
          const measuresPre = scanMeasuresPx(outer, svg) ?? [];

          // Build barline candidates exactly like drawMeasureBoxes used to.
          const allGraphics = Array.from(
            svg.querySelectorAll<SVGGraphicsElement>("line, rect, path")
          );

          const outerRect = outer.getBoundingClientRect();
          const svgPoint = svg.createSVGPoint();
          const toPageLocal = (el: SVGGraphicsElement, x: number, y: number) => {
            const m = el.getScreenCTM();
            if (!m) { return { x: 0, y: 0 }; }
            svgPoint.x = x;
            svgPoint.y = y;
            const scr = svgPoint.matrixTransform(m);
            return { x: scr.x - outerRect.left, y: scr.y - outerRect.top };
          };

          const barCands: BarCand[] = [];
          for (const el of allGraphics) {
            let bbSvg: DOMRect | null = null;
            try { bbSvg = el.getBBox(); } catch { bbSvg = null; }
            if (!bbSvg) { continue; }

            // Convert bbox corners to page-local px (pre-translate)
            const p1 = toPageLocal(el, bbSvg.x, bbSvg.y);
            const p2 = toPageLocal(el, bbSvg.x + bbSvg.width, bbSvg.y + bbSvg.height);

            const bb = {
              x: Math.min(p1.x, p2.x),
              y: Math.min(p1.y, p2.y),
              width: Math.abs(p2.x - p1.x),
              height: Math.abs(p2.y - p1.y),
            };

            const cls = (el.getAttribute("class") || "").toLowerCase();
            const parentCls = (el.parentElement?.getAttribute("class") || "").toLowerCase();
            const hinted = cls.includes("stave") || cls.includes("bar")
              || parentCls.includes("stave") || parentCls.includes("bar");

            const thin = Math.round(bb.width) <= 4;

            barCands.push({
              el,
              bb,
              thin,
              yTop: bb.y,
              yBot: bb.y + bb.height,
              hinted,
            });
          }

          return { measuresPre, barCands };
        }) ?? { measuresPre: [], barCands: [] };

        measuresRef.current = res.measuresPre as ReadonlyArray<{ id: string; rect: Rect }>;
        barCandsRef.current = res.barCands as ReadonlyArray<BarCand>;

        // --- compute per-measure geometry once (pre-translate, page-local px)
        const measuresPre = measuresRef.current;
        const barCands = barCandsRef.current;

        // Build band seams in pre-translate coords: [sep0, sep1, ..., sepN]
        // We use band tops/bottoms to derive a non-decreasing seam array per system band.
        const seps: number[] = [];
        if (bands.length > 0) {
          seps.push(Math.round(bands[0]!.top));
          for (let i = 0; i < bands.length - 1; i++) {
            const bCurr = bands[i]!;
            const bNext = bands[i + 1]!;
            const seam = Math.round((Math.round(bCurr.bottom) + Math.round(bNext.top)) / 2);
            seps.push(seam);
          }
          seps.push(Math.round(bands[bands.length - 1]!.bottom));
          // monotone fix
          for (let i = 1; i < seps.length; i++) {
            if (seps[i]! < seps[i - 1]!) { seps[i] = seps[i - 1]!; }
          }
        }

        // Bucket measures into bands (systems) using overlap against [sep[k], sep[k+1]]
        type BucketItem = { m: { id: string; rect: Rect }; k: number };
        const buckets = new Map<number, BucketItem[]>();

        for (const m of measuresPre) {
          const rectTop = Math.round(m.rect.y);
          const rectBot = Math.round(m.rect.y + Math.max(1, Math.round(m.rect.h)));


          // choose band by maximum vertical overlap
          let kBest = -1, bestOv = 0;
          for (let k = 0; k < seps.length - 1; k++) {
            const y0 = seps[k]!;
            const y1 = seps[k + 1]!;
            const ov = Math.max(0, Math.min(rectBot, y1) - Math.max(rectTop, y0));
            if (ov > bestOv) { bestOv = ov; kBest = k; }
          }
          if (kBest < 0 || bestOv === 0) { continue; }
          const arr = buckets.get(kBest);
          const bi: BucketItem = { m, k: kBest };
          if (arr) { arr.push(bi); } else { buckets.set(kBest, [bi]); }
        }

        if (isDiagOn()) {
          const bucketSummary = Array.from(buckets.entries())
            .map(([k, arr]) =>
              `k=${k} count=${arr.length} ids=[${arr.map(bi => bi.m.id).join(",")}]`
            )
            .join(" | ");

          void logStep(
            `geom: buckets summary: ${bucketSummary}`,
            { outer, caller: prevFuncTag }
          );
        }

        // Collect inner-edge X positions of vertical barlines that belong to a given tile.
        // expectedBars = measures_in_tile + 1
        // NAV: ____ function computeMeasureIntervals
        function computeMeasureIntervals(
          yTop: number,
          yBot: number,
          expectedBars: number,
          leftBoundPx = -Infinity
        ): number[] {
          const y0 = Math.min(yTop, yBot);
          const y1 = Math.max(yTop, yBot);
          const tileH = Math.max(0, y1 - y0);
          if (tileH <= 0 || expectedBars <= 1) { return []; }

          // Staff corridor: ignore ornaments near the system edges
          const pad = Math.floor(tileH * 0.10);  // 0.06 caused additional lines to break
          const corTop = y0 + pad;
          const corBot = y1 - pad;
          const corrH = Math.max(1, corBot - corTop);

          // Allow a larger centered “hole” (grand-staff gap) but keep halves stringent
          const maxCenteredHoleFrac = 0.35;     // up to 35% if it's the central gap
          const minHalfCoverageFrac = 0.60;     // ≥60% coverage in each half
          const minOverallCoverageFrac = 0.55;  // was 0.65; fixed missing measure boxes when changed
          type Span = { t: number; b: number };

          // Bucket candidates by integer X and retain their vertical spans
          const BUCKETS = new Map<number, Span[]>();
          const put = (x: number, t: number, b: number): void => {
            const xr = Math.round(x);
            if (xr < leftBoundPx) { return; }       // ignore anything left of the music
            const arr = BUCKETS.get(xr);
            const s: Span = { t, b };
            if (arr) { arr.push(s); } else { BUCKETS.set(xr, [s]); }
          };

          // Scan graphics → keep verticals inside the corridor with realistic widths
          for (const c of barCands) {
            // widen width gate to admit thick/double bars rendered as rects
            const w = Math.round(c.bb.width);
            if (w < 1) { continue; }

            // Require candidate to meaningfully live in the corridor
            const cTop = Math.min(c.yTop, c.yBot);
            const cBot = Math.max(c.yTop, c.yBot);
            const insideTop = Math.max(corTop, cTop);
            const insideBot = Math.min(corBot, cBot);
            const insideH = Math.max(0, insideBot - insideTop);
            if (insideH < corrH * 0.55) { continue; } // a touch softer than before

            // Start from bbox edges by default
            let left = c.bb.x;
            let right = c.bb.x + c.bb.width;

            // If it's a nearly vertical <line>, prefer x1/x2
            const tag = c.el.tagName.toLowerCase();
            if (tag === "line") {
              const x1s = c.el.getAttribute("x1");
              const x2s = c.el.getAttribute("x2");
              if (x1s !== null && x2s !== null) {
                const x1 = Math.round(Number(x1s));
                const x2 = Math.round(Number(x2s));
                if (Number.isFinite(x1) && Number.isFinite(x2) && Math.abs(x1 - x2) <= 1) {
                  left = Math.min(x1, x2);
                  right = Math.max(x1, x2);
                }
              }
            }

            put(left, c.yTop, c.yBot);
            if (right !== left) { put(right, c.yTop, c.yBot); }
          }

          if (BUCKETS.size === 0) { return []; }

          // Merge helper inside corridor
          const mergeSpans = (spans: Span[]) => {
            const S = spans
              .map(s => ({ t: Math.max(corTop, Math.min(s.t, s.b)), b: Math.min(corBot, Math.max(s.t, s.b)) }))
              .filter(s => s.b > s.t)
              .sort((a, b) => a.t - b.t);

            const merged: Span[] = [];
            for (const s of S) {
              const last = merged.length ? merged[merged.length - 1] : null;
              if (!last || s.t > last.b) { merged.push({ t: s.t, b: s.b }); }
              else { last.b = Math.max(last.b, s.b); }
            }
            return merged;
          };

          // Evaluate buckets with grand-staff aware acceptance
          const xsRaw: number[] = [];
          for (const [x, spans] of BUCKETS) {
            const merged = mergeSpans(spans);
            if (merged.length === 0) { continue; }

            // overall coverage + largest hole
            let covered = 0;
            let maxHole = 0;
            let cursor = corTop;
            for (const m of merged) {
              if (m.t > cursor) { maxHole = Math.max(maxHole, m.t - cursor); }
              covered += (m.b - Math.max(m.t, cursor));
              cursor = Math.max(cursor, m.b);
            }
            if (cursor < corBot) { maxHole = Math.max(maxHole, corBot - cursor); }
            const overallOK = (covered >= corrH * minOverallCoverageFrac);

            // split by largest gap into halves and test each half's coverage
            let halvesOK = false;
            if (merged.length > 1) {
              // find largest internal gap to define a candidate staff gap
              let bestGap = -1, splitY = corTop;
              let lastB = merged[0]!.b;
              for (let i = 1; i < merged.length; i++) {
                const gap = merged[i]!.t - lastB;
                if (gap > bestGap) { bestGap = gap; splitY = (lastB + merged[i]!.t) / 2; }
                lastB = merged[i]!.b;
              }
              const topH = Math.max(1, splitY - corTop);
              const botH = Math.max(1, corBot - splitY);

              // coverage in each half
              const covHalf = (t0: number, t1: number) => {
                let c = 0;
                for (const m of merged) {
                  const a = Math.max(t0, m.t);
                  const b = Math.min(t1, m.b);
                  if (b > a) { c += (b - a); }
                }
                return c;
              };
              const topCov = covHalf(corTop, splitY);
              const botCov = covHalf(splitY, corBot);

              // accept if both halves are reasonably covered,
              // and allow a larger central hole if that's what created the split
              const centeredOK = (bestGap >= corrH * 0.10) && (bestGap <= corrH * maxCenteredHoleFrac);
              halvesOK = centeredOK &&
                (topCov >= topH * minHalfCoverageFrac) &&
                (botCov >= botH * minHalfCoverageFrac);
            }

            if (overallOK || halvesOK) {
              xsRaw.push(x);
            }
          }

          if (xsRaw.length === 0) { return []; }

          // Sort and cluster near-duplicates (collapse double/thick bars)
          xsRaw.sort((a, b) => a - b);

          const CLUSTER_EPS = 3; // px
          const xsClustered: number[] = [];

          let sum = xsRaw[0]!;
          let count = 1;

          for (let i = 1; i < xsRaw.length; i++) {
            const x = xsRaw[i]!;
            const mean = sum / count;
            if (Math.abs(x - mean) <= CLUSTER_EPS) {
              // keep extending current cluster
              sum += x;
              count++;
            } else {
              // close current cluster and start a new one
              xsClustered.push(Math.round(mean));
              sum = x;
              count = 1;
            }
          }

          // push the final cluster centroid
          xsClustered.push(Math.round(sum / count));

          // If we still have too many, prune conservatively by removing the tightest pair
          const xs = xsClustered.slice();
          while (xs.length > expectedBars) {
            let bestIdx = -1;
            let bestGap = Number.POSITIVE_INFINITY;
            for (let i = 0; i < xs.length - 1; i++) {
              const g = xs[i + 1]! - xs[i]!;
              if (g < bestGap) { bestGap = g; bestIdx = i; }
            }
            // remove the member of the tightest pair that yields larger neighborhood gap after removal
            if (bestIdx < 0) { break; }
            const leftPull = bestIdx > 0 ? xs[bestIdx]! - xs[bestIdx - 1]! : Number.POSITIVE_INFINITY;
            const rightPull = (bestIdx + 2 < xs.length) ? xs[bestIdx + 2]! - xs[bestIdx + 1]! : Number.POSITIVE_INFINITY;
            if (leftPull <= rightPull) { xs.splice(bestIdx, 1); }
            else { xs.splice(bestIdx + 1, 1); }
          }

          return xs;
        }

        // For vertical extent recompute we need toPageLocal + SVG nodes; reuse the scan svg
        const svgForV = withSvgAtUnitScale(outer, (svg) => svg) as SVGSVGElement | null;
        if (!svgForV) {
          geometryRef.current = new Map();
        } else {
          const outerRectV = outer.getBoundingClientRect();
          const svgPointV = svgForV.createSVGPoint();
          const toPageLocalV = (el: SVGGraphicsElement, x: number, y: number) => {
            const m = el.getScreenCTM();
            if (!m) { return { x: 0, y: 0 }; }
            svgPointV.x = x;
            svgPointV.y = y;
            const scr = svgPointV.matrixTransform(m);
            return { x: scr.x - outerRectV.left, y: scr.y - outerRectV.top };
          };

          // Precompute page-local bounding boxes for all relevant nodes ONCE.
          const nodesAll: SVGGraphicsElement[] = Array.from(
            svgForV.querySelectorAll<SVGGraphicsElement>(
              "path, rect, line, polyline, polygon, text, use, circle, ellipse"
            )
          );

          type NodeBB = { x0: number; x1: number; y0: number; y1: number };
          const nodeBBs: ReadonlyArray<NodeBB> = (() => {
            const rows: NodeBB[] = [];
            for (const el of nodesAll) {
              let bbSvg: DOMRect;
              try { bbSvg = el.getBBox(); } catch { continue; }
              const p1 = toPageLocalV(el, bbSvg.x, bbSvg.y);
              const p2 = toPageLocalV(el, bbSvg.x + bbSvg.width, bbSvg.y + bbSvg.height);
              const x0 = Math.min(p1.x, p2.x);
              const x1 = Math.max(p1.x, p2.x);
              const y0 = Math.min(p1.y, p2.y);
              const y1 = Math.max(p1.y, p2.y);

              rows.push({ x0, x1, y0, y1 });
            }
            return rows;
          })();

          // NAV: ____ function computeMeasureVerticalExtents
          function computeMeasureVerticalExtents(
            intervalLeft: number,
            intervalRight: number,
            eps: number,
            bandTop: number,
            bandBot: number
          ): { top: number; bottom: number } | null {
            const leftGate = Math.min(intervalLeft, intervalRight) - Math.max(0, Math.floor(eps));
            const rightGate = Math.max(intervalLeft, intervalRight) + Math.max(0, Math.floor(eps));
            const y0Band = Math.min(bandTop, bandBot);
            const y1Band = Math.max(bandTop, bandBot);
            if (y1Band <= y0Band) { return null; }

            let globalTop: number | null = null;
            let globalBot: number | null = null;

            // Single pass over precomputed page-local bounding boxes
            for (const bb of nodeBBs) {
              // horizontal gate
              if (bb.x1 <= leftGate + 1 || bb.x0 >= rightGate - 1) { continue; }

              // vertical gate + clip to band
              const clipTop = Math.max(y0Band, bb.y0);
              const clipBot = Math.min(y1Band, bb.y1);
              if (clipBot <= clipTop) { continue; }

              globalTop = globalTop === null ? clipTop : Math.min(globalTop, clipTop);
              globalBot = globalBot === null ? clipBot : Math.max(globalBot, clipBot);
            }

            if (globalTop === null || globalBot === null) { return null; }
            return { top: globalTop, bottom: globalBot };
          }

          const geomPairs: Array<[string, MeasureGeom]> = [];

          for (let k = 0; k < seps.length - 1; k++) {
            const items = (buckets.get(k) || []).slice();

            // Sort measures deterministically (same as draw)
            items.sort((a, b) => {
              const an = (a.m.id.match(/measure[-_\s]?(\d+)/i)?.[1]);
              const bn = (b.m.id.match(/measure[-_\s]?(\d+)/i)?.[1]);
              const ai = an ? Number(an) : Number.POSITIVE_INFINITY;
              const bi = bn ? Number(bn) : Number.POSITIVE_INFINITY;
              if (ai !== bi) { return ai - bi; }
              return a.m.rect.x - b.m.rect.x;
            });

            if (items.length === 0) {
              if (isDiagOn()) {
                await logStep(
                  `geom: tile k=${k} items=0 (no measures in bucket)`,
                  { outer, caller: prevFuncTag }
                );
              }
              continue;
            }

            const bandTop = seps[k]!;
            const bandBot = seps[k + 1]!;
            const expectedBars = items.length + 1;
            const musicLeft = Math.min(...items.map(it => Math.round(it.m.rect.x)));
            const LEFT_TOL = 2;
            const leftBoundPx = musicLeft - LEFT_TOL;

            // 1) Try bar-line–based intervals first
            let xs = computeMeasureIntervals(bandTop, bandBot, expectedBars, leftBoundPx);

            // 2) Fallback: if bar-line detection chokes, synthesize xs from measure rects
            if (xs.length < 2 && items.length > 0) {
              const firstRect = items[0]!.m.rect;
              const lastRect = items[items.length - 1]!.m.rect;

              const xsFallback: number[] = [];
              xsFallback.push(Math.round(firstRect.x)); // leftmost edge

              for (let i = 0; i < items.length - 1; i++) {
                const a = items[i]!.m.rect;
                const b = items[i + 1]!.m.rect;
                const boundary = Math.round((a.x + a.w + b.x) / 2);
                xsFallback.push(boundary);
              }

              xsFallback.push(Math.round(lastRect.x + lastRect.w)); // rightmost edge

              // Fallback for cases where barline scanning can't produce reliable interval boundaries.
              console.warn(
                `[measure-interval-fallback] tile=${k} measures=${items.length} xs=[${xsFallback.join(",")}] expectedBars=${expectedBars}`
              );

              xs = xsFallback;
            }

            // If even the fallback can’t give us a sensible set, skip as before.
            if (xs.length < 2) {
              continue;
            }

            // 3) Build intervals from whatever xs we ended up with
            const intervals: MeasureInterval[] = [];
            for (let i = 0; i < xs.length - 1; i++) {
              const l = xs[i]!, r = xs[i + 1]!;
              if (r > l) { intervals.push({ left: l, right: r }); }
            }

            // pair measures with intervals
            const N = Math.min(items.length, intervals.length);
            const EPS = 6;

            for (let i = 0; i < N; i++) {
              const { m } = items[i]!;
              const iv = intervals[i]!;
              const mm = computeMeasureVerticalExtents(iv.left, iv.right, EPS, bandTop, bandBot);
              if (!mm) {
                if (isDiagOn()) {
                  void logStep(
                    `geom: tile k=${k} id=${m.id} interval=[${iv.left},${iv.right}] mm=null`,
                    { outer, caller: prevFuncTag }
                  );
                }
                continue;
              }

              geomPairs.push([m.id, {
                id: m.id,
                tileIndex: k,
                interval: iv,
                top: Math.max(bandTop, Math.round(mm.top)),
                bottom: Math.min(bandBot, Math.round(mm.bottom)),
              }]);
            }
          }

          geometryRef.current = new Map<string, MeasureGeom>(geomPairs);
        }

        if (isDiagOn()) {
          await logStep(
            `measures(pre): ${res.measuresPre.length} bar-cands(pre): ${res.barCands.length} geom(pre): ${geometryRef.current.size}`,
            { outer, caller: prevFuncTag }
          );
        }
      }

      const visH = visiblePageHeight(outer);

      if (isDiagOn()) {
        await logStep(
          `bands: ${bands.length} visH: ${visH} topGutterPx: ${topGutterPx} bottomGutterPx: ${bottomGutterPx}`,
          { outer, caller: prevFuncTag }
        );
      }

      const starts = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => computePageStarts(outer, bands, visH, Math.max(0, topGutterPx), Math.max(0, bottomGutterPx)),
        (ms) => {
          void logStep(`computePageStarts() runtime: ${ms}ms`,
            { outer, caller: prevFuncTag }
          );
        }
      );

      const measureToPage = rebuildMeasureToPageMapping(
        bands,
        starts,
        geometryRef.current ?? new Map<string, MeasureGeom>()
      );
      measureToPageRef.current = measureToPage;

      if (isDiagOn()) {
        const sampleParts: string[] = [];
        for (let m = 0; m < measureToPage.length && sampleParts.length < 20; m++) {
          const pageIndex = measureToPage[m];
          if (pageIndex === null || pageIndex === undefined || pageIndex < 0) { continue; }
          sampleParts.push(`m${m}->p${pageIndex}`);
        }
        await logStep(`diag: measureToPageRef sample (first 20): ${sampleParts.join(", ")}`
        );
      }

      // --- Build measure→page mapping for this layout ---
      {
        const bandCount = bands.length;
        const geomSize = geometryRef.current.size;

        if (bandCount === 0 || geomSize === 0) {
          // Nothing to map in this layout
          measureToPageRef.current = [];
        } else {
          // 1) band → page
          const bandToPage: number[] = new Array(bandCount).fill(-1);
          for (let p = 0; p < starts.length; p++) {
            const startBand = starts[p]!;
            const endBand =
              p + 1 < starts.length ? starts[p + 1]! : bandCount;
            for (let b = startBand; b < endBand; b++) {
              bandToPage[b] = p;
            }
          }

          // 2) measure (by id) → page
          const measureToPage: number[] = [];
          for (const [id, geom] of geometryRef.current.entries()) {
            // Your current geometry ids are "1", "2", "3", ...
            const mNum = Number(id);
            if (!Number.isFinite(mNum)) { continue; }

            const bandIndex = geom.tileIndex;
            const pageIndex = bandToPage[bandIndex] ?? -1;

            // It's fine if index 0 is unused; measures start at 1.
            measureToPage[mNum] = pageIndex;
          }

          measureToPageRef.current = measureToPage;

          // Optional diag: show a few entries
          if (isDiagOn()) {
            const sampleParts: string[] = [];
            for (let m = 0; m < measureToPage.length && sampleParts.length < 20; m++) {
              const pageIndex = measureToPage[m];
              if (pageIndex === null || pageIndex === undefined || pageIndex < 0) { continue; }
              sampleParts.push(`m${m}->p${pageIndex}`);
            }
            await logStep(`diag: measureToPageRef sample (first 20): ${sampleParts.join(", ")}`,
              { outer, caller: prevFuncTag }
            );
          }
        }
      }

      await logStep("phase finished", { outer, caller: prevFuncTag });
      outer.dataset.viewerPhase = "apply";
      await logStep("phase starting", { outer, caller: prevFuncTag });

      pageStartIdxsRef.current = starts;
      systemBandsRef.current = bands;

      // Decide which page to show after this layout.
      // Default to 0 (initial load behavior).
      let targetPageIndex = 0; // default to page 0 (page 1)

      if (anchorMeasure !== null) {
        const map = measureToPageRef.current;
        const mapped = map[anchorMeasure];

        if (
          typeof mapped === "number" &&
          mapped >= 0 &&
          mapped < starts.length
        ) {
          targetPageIndex = mapped;
        }
      }

      await perfBlockAsync(
        nextPerfUID(outer.dataset.viewerRun),
        async () => {
          applyPage(targetPageIndex);

          // Mark that we've successfully laid out at least one page.
          if (!layoutReady) {
            setLayoutReady(true);
          }

          await Promise.race([
            ap(gateLabel, gateMs),
            new Promise<void>((r) => setTimeout(r, gateMs)),
          ]);

          if (doubleApply) {
            applyPage(targetPageIndex);
          }
        },
        (ms) => {
          void logStep(`applyPage() runtime: ${ms}ms`, { outer, caller: prevFuncTag });
        }
      );

      await logStep(`bands: ${bands.length} pages: ${starts.length}`, { outer, caller: prevFuncTag });

      return { bands, starts };

    } finally {
      // Restore host visibility / content-visibility to what they were before
      const hostForLayout = svgHostRef.current;
      if (hostForLayout) {
        if (prevHostCv) {
          hostForLayout.style.setProperty("content-visibility", prevHostCv);
        } else {
          hostForLayout.style.removeProperty("content-visibility");
        }

        if (prevHostVis) {
          hostForLayout.style.visibility = prevHostVis;
        } else {
          hostForLayout.style.removeProperty("visibility");
        }
      }

      try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
    }
  }, [nextPerfUID, renderViewer, withHostHidden, applyPage, visiblePageHeight, topGutterPx, bottomGutterPx, layoutReady]);


  // height-only repagination, no OSMD rendeer
  // NAV: __ const paginateViewer
  const paginateViewer = useCallback((): void => {
    const outer = wrapRef.current;
    if (!outer) { return; }

    // Determine which page we were on before this height-only repagination.
    const currentPageBeforePaginate = pageIdxRef.current ?? 0;

    // Optional anchor measure based on the previous pagination.
    let anchorMeasure: number | null = null;
    if (measureToPageRef.current.length > 0) {
      anchorMeasure = findAnchorMeasure(
        measureToPageRef.current,
        currentPageBeforePaginate
      );
    }

    // Remove stale boxes; applyPage() will redraw them for the new page window
    try { clearMeasureBoxes(outer); } catch { }

    // Prevent overlap
    if (repaginationRunningRef.current) { return; }
    repaginationRunningRef.current = true;

    const prevFuncTag = outer.dataset.viewerFunc ?? "";
    outer.dataset.viewerFunc = "paginateViewer";

    try {
      outer.dataset.viewerRecompute = String(Date.now());

      const bands = systemBandsRef.current;
      if (bands.length === 0) {
        void logStep("repag: bands=0 — exit", { outer, caller: prevFuncTag });
        return;
      }

      const visH = visiblePageHeight(outer);

      if (isDiagOn()) {
        void logStep(
          `bands: ${bands.length} visH: ${visH} topGutterPx: ${topGutterPx} bottomGutterPx: ${bottomGutterPx}`,
          { outer, caller: prevFuncTag }
        );
      }

      const starts = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => computePageStarts(outer, bands, visH, Math.max(0, topGutterPx), Math.max(0, bottomGutterPx)),
        (ms) => {
          void logStep(`computePageStarts() runtime: ${ms}ms`,
            { outer, caller: prevFuncTag }
          );
        }
      );

      pageStartIdxsRef.current = starts;
      outer.dataset.viewerPages = String(starts.length);

      // Rebuild measure→page mapping for this pagination
      const measureToPage = rebuildMeasureToPageMapping(
        bands,
        starts,
        geometryRef.current ?? new Map<string, MeasureGeom>()
      );
      measureToPageRef.current = measureToPage;

      // Optional diagnostics: compact page map
      if (isDiagOn()) {
        const lastBand = bands.length - 1;
        const parts: string[] = [];
        for (let p = 0; p < starts.length; p++) {
          const s = starts[p]!;
          const e = ((p + 1 < starts.length ? starts[p + 1]! : lastBand + 1) - 1);
          parts.push(`[p${p + 1} ${s}–${e}]`);
        }
        void logStep(`repag map: pages=${starts.length} ${parts.join(" ")}`, { outer, caller: prevFuncTag });

        const sampleParts: string[] = [];
        for (let m = 0; m < measureToPage.length && sampleParts.length < 20; m++) {
          const pageIndex = measureToPage[m];
          if (pageIndex === null || pageIndex === undefined || pageIndex < 0) { continue; }
          sampleParts.push(`m${m}->p${pageIndex}`);
        }
        void logStep(
          `repag measureToPage sample (first 20): ${sampleParts.join(", ")}`,
          { outer, caller: prevFuncTag }
        );
      }

      // Decide target page after repagination.
      // Default to 0 (old behavior) and override if anchor maps cleanly.
      let targetPageIndex = 0;

      if (anchorMeasure !== null) {
        const map = measureToPageRef.current;
        const mapped = map[anchorMeasure];

        if (
          typeof mapped === "number" &&
          mapped >= 0 &&
          mapped < starts.length
        ) {
          targetPageIndex = mapped;
        }
      }

      if (isDiagOn()) {
        void logStep(`repag anchorMeasure=${anchorMeasure ?? -1} targetPageIndex=${targetPageIndex}`);
      }

      perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => { applyPage(targetPageIndex); },
        (ms) => { void logStep(`applyPage runtime: ${ms}ms`, { outer, caller: prevFuncTag }); }
      );

    } catch (e) {
      // Visible breadcrumb + best-effort fallback so the UI doesn't look stuck
      const msg = (e as Error)?.message ?? String(e);
      outer.dataset.viewerErr = msg.slice(0, 180);
      void logStep(`repag:error ${msg}`, { outer, caller: prevFuncTag });

      if (!pageStartIdxsRef.current?.length) {
        pageStartIdxsRef.current = [0];
      }
      try { applyPage(0); } catch { }

    } finally {
      // Drain any queued work that accumulated while we were repaginating
      const queued = reflowAgainRef.current;
      reflowAgainRef.current = "none";
      reflowQueuedCauseRef.current = "";

      if (queued === "width") {
        setTimeout(() => { reflowFnRef.current(); }, 0);
      } else if (queued === "height") {
        setTimeout(() => { repagFnRef.current(); }, 0);
      }

      // Update “handled” height so future VV height changes compare against it
      handledHRef.current = outer.clientHeight || handledHRef.current;

      repaginationRunningRef.current = false;
      outer.dataset.viewerFunc = prevFuncTag;
    }
  }, [applyPage, visiblePageHeight, nextPerfUID, topGutterPx, bottomGutterPx]);


  // keep ref pointing to latest repagination callback
  useEffect(() => {
    repagFnRef.current = paginateViewer;
  }, [paginateViewer]);

  // Heavy path for when effective layout width changes (width/zoom/DPR etc.).
  // Shows spinner, bumps run#, calls layoutViewer(), drains any queued work.
  // Concurrency-safe via reflowRunningRef; may queue a follow-up if invoked again mid-run.
  // NAV: __ const reflowViewer
  const reflowViewer = useCallback(
    async function reflowViewer(): Promise<void> {
      const outer = wrapRef.current;
      const osmd = osmdRef.current;

      if (!outer) {
        console.warn("[reflowViewer][prep] early-bail outer=0 osmd=" + (osmd ? "1" : "0"));
        return;
      }

      const prevFuncTag = outer.dataset.viewerFunc ?? "";
      outer.dataset.viewerFunc = "reflowViewer";
      outer.dataset.viewerPhase = "prep";
      await logStep("phase starting", { outer, caller: prevFuncTag });

      let started = false;

      try {
        if (!osmd) {
          void logStep("early-bail outer=1 osmd=0", { outer, caller: prevFuncTag });
          return;
        }

        if (reflowRunningRef.current) {
          reflowAgainRef.current = "width";
          const run = Number(outer.dataset.viewerRun || "0");
          outer.dataset.viewerReflowQueued = String(run);
          outer.dataset.viewerReflowQueueWhy = "reflowRunning";
          outer.dataset.viewerReflowQueuedAt = String(Date.now());
          void logStep("reflow already in progress; queued follow-up", { outer, caller: prevFuncTag });
          return;
        }

        started = true;

        reflowRunningRef.current = true;

        const run = (Number(outer.dataset.viewerRun || "0") + 1);
        outer.dataset.viewerRun = String(run);

        const pages = Math.max(1, pageStartIdxsRef.current.length);
        const page = Math.max(1, Math.min(pageIdxRef.current + 1, pages));
        void logStep(`run: ${run} page: ${page}/${pages}`, { outer, caller: prevFuncTag });

        const currW = outer.clientWidth;
        const currH = outer.clientHeight;
        handledWRef.current = currW; // prime "handled" now, not only at the end
        handledHRef.current = currH;

        try {
          outer.dataset.viewerReflowTargetW = String(currW);
          outer.dataset.viewerReflowTargetH = String(currH);
        } catch { }

        await startSpinner({ message: DEFAULT_BUSY_MSG, gatePaint: true });
        await logStep("spinner started", { outer, caller: prevFuncTag });

        const { bands, starts } = await layoutViewer(outer, osmd, {
          gateLabel: "reflowViewer",
          gateMs: 400,
          doubleApply: true
        });
        outer.dataset.viewerBands = String(bands.length);
        outer.dataset.viewerPages = String(starts.length);

        await logStep("phase finished", { outer, caller: prevFuncTag });

      } finally {
        if (started) {
          try { outer.dataset.viewerPhase = "finally"; } catch { }
          await logStep("phase starting", { outer, caller: prevFuncTag });

          // we finished a run; drop the guard before hiding spinner
          reflowRunningRef.current = false;

          // spinner end + small paint gate
          await stopSpinner();
          await logStep("spinner stopped", { outer, caller: prevFuncTag });

          // clear breadcrumbs
          outer.dataset.viewerReflowTargetW = "";
          outer.dataset.viewerReflowTargetH = "";

          // drain any queued work
          const queued = reflowAgainRef.current;
          const cause = reflowQueuedCauseRef.current || "drain:finally";
          reflowAgainRef.current = "none";
          reflowQueuedCauseRef.current = "";

          if (queued === "width") {
            await logStep(`draining queued width reflow (cause=${cause})`, { outer, caller: prevFuncTag });
            setTimeout(() => { reflowFnRef.current(); }, 0);
          } else if (queued === "height") {
            await logStep(`draining queued height repagination (cause=${cause})`, { outer, caller: prevFuncTag });
            setTimeout(() => { repagFnRef.current(); }, 0);
          }

          await logStep("phase finished", { outer, caller: prevFuncTag });
        }
        try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
        try { outer.dataset.viewerPhase = ""; } catch { }
      }

    },
    [layoutViewer, startSpinner, stopSpinner]
  );

  // keep ref pointing to latest width-reflow callback
  useEffect(() => {
    reflowFnRef.current = reflowViewer;
  }, [reflowViewer]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) { return; }

    el.dataset.viewerProbeMounted = "1";
  }, []);

  // Record baseline zoom/scale at mount (used to compute relative zoom later)
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const initial = (vv && typeof vv.scale === "number") ? vv.scale : (window.devicePixelRatio || 1);
    baseScaleRef.current = initial || 1;
    zoomFactorRef.current = 1;
  }, []);

  // Reflow only for actual zoom; never start immediately, just queue safely.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;

    let lastScale = vv?.scale ?? 1;
    let lastDpr = window.devicePixelRatio || 1;
    let kick: number | null = null;

    const schedule = (why: "vv-scale" | "dpr") => {
      // Ignore before first layout is fully ready
      if (!readyRef.current) {
        void logStep(`ignored (pre-ready) reason=${why}`);
        return;
      }

      // Debounce a burst of zoom changes
      if (kick !== null) { window.clearTimeout(kick); }
      kick = window.setTimeout(() => {
        kick = null;

        const before = zoomFactorRef.current;
        zoomFactorRef.current = computeZoomFactor();

        // Only act if zoom actually changed
        if (Math.abs(zoomFactorRef.current - before) < 0.003) { return; }

        void logStep(`debounced zf=${zoomFactorRef.current.toFixed(3)} reason=${why}`);

        // NOTE:
        // We no longer trigger a reflow directly from zoom changes here.
        // Browser zoom also fires visualViewport resize events, and the
        // handleVVChange() effect already performs the width reflow based
        // on wrapper/viewport dimensions. By only updating zoomFactorRef
        // here, we avoid double reflows when scale + width change together
        // (e.g. after an internal pinch followed by a browser zoom).
        reflowQueuedCauseRef.current = `zoom:${why}`;
        // No reflowAgainRef mutation and no direct call to reflowFnRef here.
      }, 220);
    };

    const onVVScale = () => {
      const s = vv?.scale ?? 1;
      if (Math.abs(s - lastScale) > 0.003) {
        lastScale = s;
        schedule("vv-scale");
      }
    };

    const pollDPR = () => {
      const d = window.devicePixelRatio || 1;
      if (Math.abs(d - lastDpr) > 0.003) {
        lastDpr = d;
        schedule("dpr");
      }
    };

    vv?.addEventListener("resize", onVVScale);
    vv?.addEventListener("scroll", onVVScale);
    const t = window.setInterval(pollDPR, 400);

    return () => {
      vv?.removeEventListener("resize", onVVScale);
      vv?.removeEventListener("scroll", onVVScale);
      window.clearInterval(t);
      if (kick !== null) { window.clearTimeout(kick); }
    };
  }, [computeZoomFactor]);


  // NAV: ------------------------- initialization

  // One-time boot for the component:
  // - feature checks, dynamic import of OSMD
  // - load MusicXML (MXL/URL), wait for fonts
  // - first layout via layoutViewer, then height-only repagination
  // - marks ready & clears the spinner
  // NAV: __ function initViewer
  useEffect(function initViewer() {
    (async () => {
      const host = svgHostRef.current;
      const outer = wrapRef.current;
      if (!host || !outer) { return; }

      const prevFuncTag = outer.dataset.viewerFunc ?? "";
      outer.dataset.viewerFunc = "initViewer";
      outer.dataset.viewerPhase = "prep";
      await logStep("phase starting", { outer, caller: prevFuncTag });

      try {
        const epoch = ++initEpochRef.current;
        outer.dataset.viewerInitEpoch = String(epoch);

        // If a newer init started (src changed), abort this one quietly.
        const isStale = () => outer.dataset.viewerInitEpoch !== String(epoch);

        try {
          const hasVV =
            typeof window !== "undefined" &&
            !!window.visualViewport &&
            typeof window.visualViewport.scale === "number";

          const hasRO =
            typeof window !== "undefined" &&
            "ResizeObserver" in window &&
            typeof window.ResizeObserver === "function";

          outer.dataset.viewerCapVv = hasVV ? "1" : "0";
          outer.dataset.viewerCapRo = hasRO ? "1" : "0";

          await logStep(`hasVV: ${hasVV ? "yes" : "no"} hasRO: ${hasRO ? "yes" : "no"}`,
            { outer, caller: prevFuncTag });

          if (!hasVV) {
            outer.dataset.viewerPhase = "fatal:no-visual-viewport";
            outer.dataset.viewerFatal = "1";

            // Mark fatal in React state (drives overlay behavior & auto-clear guard)
            setFatalReason("no-visual-viewport");

            // Static, human-friendly message (no spinner)
            setBusyMsg(
              "Your browser doesn’t expose the Visual Viewport API, which we need for correct zoom & pagination.\nTry a current Chrome or Edge, or Safari 16+."
            );

            // Show blocking overlay; do NOT use startSpinner here
            setBusy(true);

            await logStep("fatal: visualViewport unavailable — aborting init",
              { outer, caller: prevFuncTag });
            return; // stop init right here
          }
          if (isStale()) { return; }

        } catch { }

        // --- Dynamic import OSMD ---
        const mod = await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => await import("opensheetmusicdisplay"),
          (ms) => {
            void logStep(`import("opensheetmusicdisplay") runtime: ${ms}ms`,
              { outer, caller: prevFuncTag });
          }
        );

        const { OpenSheetMusicDisplay: OSMDClass } =
          mod as typeof import("opensheetmusicdisplay");

        // Fresh instance
        if (osmdRef.current) {
          osmdRef.current?.clear();
          (osmdRef.current as { dispose?: () => void } | null)?.dispose?.();
          osmdRef.current = null;
        }

        const osmd = new OSMDClass(host, {
          backend: "svg" as const,
          autoResize: false,
          drawTitle: true,
          drawSubtitle: true,
          drawComposer: true,
          drawLyricist: true,
          drawMeasureNumbers: false, // do not set to 'true' or it can cause bands to overlap
        }) as OpenSheetMusicDisplay;

        osmdRef.current = osmd;

        await startSpinner({ message: DEFAULT_BUSY_MSG, gatePaint: true });
        await logStep("spinner started", { outer, caller: prevFuncTag });

        await logStep("phase finished", { outer, caller: prevFuncTag });
        outer.dataset.viewerPhase = "load";
        await logStep("phase starting", { outer, caller: prevFuncTag });

        let loadInput: string | Document | ArrayBuffer | Uint8Array = src;

        if (src.startsWith("/api/")) {
          const ab = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => {
              const res = await fetch(src, { cache: "no-store" });
              if (!res.ok) { throw new Error(`HTTP ${res.status}`); }

              const buf = await withTimeout(res.arrayBuffer(), 12000, "fetch timeout");
              outer.dataset.viewerZipBytes = String(buf.byteLength);
              return buf;
            },
            (ms) => {
              const bytes = outer.dataset.viewerZipBytes ?? "?";
              void logStep(`fetch() + arrayBuffer() runtime: ${ms}ms bytes: ${bytes}`,
                { outer, caller: prevFuncTag });
            }
          );

          const uzMod = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(import("unzipit"), 4000, "unzipit timeout"),
            (ms) => {
              void logStep(`import("unzipit") runtime: ${ms}ms`,
                { outer, caller: prevFuncTag });
            }
          );
          const { unzip } = uzMod as typeof import("unzipit");

          const { entries } = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(unzip(ab), 8000, "unzip timeout"),
            (ms) => {
              void logStep(`unzip() runtime: ${ms}ms`,
                { outer, caller: prevFuncTag });
            }
          );

          const container = entries["META-INF/container.xml"];
          if (!container) {
            await logStep("container.xml missing → abort", { outer, caller: prevFuncTag });
            throw new Error("MXL error: META-INF/container.xml missing");
          }

          const containerXml = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => {
              const s = await withTimeout(container.text(), 6000, "container.text timeout");
              outer.dataset.viewerContainerChars = String(s.length);
              return s;
            },
            (ms) => {
              const chars = outer.dataset.viewerContainerChars ?? "?";
              void logStep(`container.text() runtime: ${ms}ms chars: ${chars}`,
                { outer, caller: prevFuncTag });
            }
          );

          const cdoc = perfBlock(
            nextPerfUID(outer.dataset.viewerRun),
            () => new DOMParser().parseFromString(containerXml, "application/xml"),
            (ms) => {
              void logStep(`DOMParser().parseFromString() runtime: ${ms}ms`,
                { outer, caller: prevFuncTag });
            }
          );

          const rootEl =
            cdoc.querySelector('rootfile[full-path]') ||
            cdoc.querySelector('rootfile[path]') ||
            cdoc.querySelector('rootfile[href]');

          const fullPath =
            rootEl?.getAttribute("full-path") ||
            rootEl?.getAttribute("path") ||
            rootEl?.getAttribute("href") ||
            "";

          if (!fullPath) {
            await logStep("container rootfile path missing → abort", { outer, caller: prevFuncTag });
            throw new Error("MXL error: container.xml lacks a rootfile path");
          }

          if (!entries[fullPath]) {
            await logStep(`container rootfile not in ZIP (${fullPath}) → abort`, { outer, caller: prevFuncTag });
            throw new Error(`MXL error: rootfile entry not found in archive: ${fullPath}`);
          }

          const entry = entries[fullPath]!;
          const xmlText = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(entry.text(), 10000, "entry.text() timeout"),
            (ms) => { void logStep(`entry.text() runtime: ${ms}ms`, { outer, caller: prevFuncTag }); }
          );
          outer.dataset.viewerZipChosen = fullPath;
          outer.dataset.viewerZipChars = String(xmlText.length);

          const xmlDoc = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => new DOMParser().parseFromString(xmlText, "application/xml"),
            (ms) => {
              void logStep(`DOMParser().parseFromString runtime: ${ms}ms`,
                { outer, caller: prevFuncTag });
            }
          );

          if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
            throw new Error("xmlDoc.getElementsByTagName parsererror");
          }
          const hasPartwise = xmlDoc.getElementsByTagName("score-partwise").length > 0;
          const hasTimewise = xmlDoc.getElementsByTagName("score-timewise").length > 0;
          await logStep(`xmlDoc.getElementsByTagName() hasPartwise: ${String(hasPartwise)} hasTimewise: ${String(hasTimewise)}`,
            { outer, caller: prevFuncTag });
          if (!hasPartwise && !hasTimewise) {
            throw new Error("xmlDoc.getElementsByTagName() no partwise or timewise");
          }

          {
            let serializeMs = 0;
            const serialized = perfBlock(
              nextPerfUID(outer.dataset.viewerRun),
              () => new XMLSerializer().serializeToString(xmlDoc),
              (ms) => { serializeMs = ms; }
            );
            outer.dataset.viewerXmlChars = String(serialized.length);
            await logStep(`XMLSerializer().serializeToString runtime: ${serializeMs}ms chars: ${serialized.length}`,
              { outer, caller: prevFuncTag });
            loadInput = serialized;
          }
        } else {
          // Non-API source: pass `src` straight to OSMD.load(...)
          // - If `src` is a URL/path to a plain MusicXML file (e.g. "/scores/foo.musicxml" or "https://…"),
          //   OSMD.load(...) will fetch it internally.
          // - If `src` is already a MusicXML XML string, OSMD.load(...) will parse it directly.
          // - (We only take the manual fetch + unzip path for "/api/<star>" endpoints that return MXL/ZIP content.)
          // In other words: non-API = plain MusicXML, so no special handling here.
          loadInput = src;
        }

        await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => {
            await loadOSMD(osmd, loadInput);
          },
          (ms) => {
            void logStep(`loadOSMD() runtime: ${ms}ms`, { outer, caller: prevFuncTag });
          }
        );

        await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => { await waitForFonts(); },
          (ms) => { void logStep(`waitForFonts() runtime: ${ms}ms`, { outer, caller: prevFuncTag }); }
        );

        await logStep("phase finished", { outer, caller: prevFuncTag });

        const { bands, starts } = await layoutViewer(outer, osmd, {
          gateLabel: "initViewer",
          gateMs: 450,
          doubleApply: false
        });
        outer.dataset.viewerBands = String(bands.length);
        outer.dataset.viewerPages = String(starts.length);

        // Immediately recompute page starts using the *final* visible height.
        // Why: on first load, the browser/UI chrome (URL/tool bars) can settle a frame
        // or two later. This cheap pass does height-only pagination (no OSMD render),
        // resets to page 1, and ensures we’re not showing a split system at the bottom.
        paginateViewer();

        // Record the dimensions we just handled. The VisualViewport listener compares
        // future vv events against these to decide:
        //   - width changed -> full reflow (layoutViewer via reflowViewer)
        //   - height only   -> quick repagination
        // We capture them here once at the end of init; the width-reflow path updates
        // these itself at the start of each run.
        handledWRef.current = outer.clientWidth;
        handledHRef.current = outer.clientHeight;

        // Mark the viewer as “ready” so zoom/DPR listeners become active.
        // This is a one-time toggle per init and is never set in the reflow path.
        readyRef.current = true;

        // First page is applied and masking is in place — hide the overlay now.
        // In the reflow path the spinner is ended in its `finally` block.
        // because a fatal no-VV path sets busy directly and must keep the overlay visible.
        await stopSpinner();
        await logStep("spinner stopped", { outer, caller: prevFuncTag });

      } finally {
        try { outer.dataset.viewerPhase = "finally"; } catch { }
        await logStep("phase starting", { outer, caller: prevFuncTag });

        await logStep("phase finished", { outer, caller: prevFuncTag });

        try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
        try { outer.dataset.viewerPhase = ""; } catch { }
      }

    })().catch(async (err: unknown) => {
      // If init crashed after startSpinner, close the spinner immediately.
      // (Fatal no-visualViewport path never sets spinnerOwnerRef, so it stays up.)
      if (spinnerOwnerRef.current) {
        try { await stopSpinner(); } catch { }
      } else {
        hideBusy(); // fallback for any older/non-spinner busy state
      }

      const outerNow = wrapRef.current;
      const msg = err instanceof Error ? err.message :
        typeof err === "string" ? err :
          JSON.stringify(err);

      if (outerNow) {
        outerNow.setAttribute("data-viewer-step", "init-crash");
        outerNow.dataset.viewerErr = String(msg).slice(0, 180);
      }
    });

    return () => {
      try {
        if (initFinalizeTimerRef.current) {
          window.clearTimeout(initFinalizeTimerRef.current);
          initFinalizeTimerRef.current = null;
        }
      } catch { }

      if (osmdRef.current) {
        osmdRef.current?.clear();
        (osmdRef.current as { dispose?: () => void } | null)?.dispose?.();
        osmdRef.current = null;
      }
    };
    // Only re-init when source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);


  // NAV: ------------------------- paging helpers

  // Ignore page turns if the originating event target is inside a UI control.
  // NAV: __ const shouldIgnorePageTurn
  const shouldIgnorePageTurn = (e?: unknown): boolean => {
    if (!e) { return false; }

    // React SyntheticEvent may wrap the native event.
    const hasNativeEvent = (val: unknown): val is { nativeEvent: unknown } => {
      return typeof val === "object" && val !== null && "nativeEvent" in val;
    };

    const getTarget = (val: unknown): EventTarget | null => {
      if (typeof val === "object" && val !== null && "target" in val) {
        const t = (val as { target?: unknown }).target;
        if (t && (t instanceof EventTarget)) { return t; }
      }
      return null;
    };

    const baseEvent = hasNativeEvent(e) ? e.nativeEvent : e;
    const target = getTarget(baseEvent);

    if (!target) { return false; }

    // Only Elements support closest()
    if (target instanceof Element) {
      return Boolean(target.closest('[data-ignore-page-turn="true"]'));
    }

    return false;
  };

  // Core page-turn handler (goNext/goPrev). On rare layout shifts, retries next frame.
  // NAV: __ const turnPage
  const turnPage = useCallback(
    (dir: 1 | -1, e?: unknown) => {
      // If this was a touch/pen tap on a UI control, ignore it.
      if (shouldIgnorePageTurn(e)) { return; }

      if (busyRef.current) { return; }

      const starts = pageStartIdxsRef.current;
      const pages = starts.length;
      if (!pages) { return; }

      const beforePage = pageIdxRef.current;

      // Wrap-around paging:
      let targetPage: number;
      if (dir === 1 && beforePage === pages - 1) {
        targetPage = 0;
      } else if (dir === -1 && beforePage === 0) {
        targetPage = pages - 1;
      } else {
        targetPage = Math.max(0, Math.min(beforePage + dir, pages - 1));
      }

      if (targetPage === beforePage) { return; }

      const desiredStart = starts[targetPage] ?? starts[beforePage] ?? 0;

      const outer = wrapRef.current;
      const prevTag = outer?.dataset.viewerFunc ?? "";
      if (outer) { outer.dataset.viewerFunc = "turnPage"; }
      try {
        applyPage(targetPage);
      } finally {
        if (outer) { outer.dataset.viewerFunc = prevTag; }
      }

      window.requestAnimationFrame(() => {
        if (pageIdxRef.current !== beforePage) { return; }

        const outer = wrapRef.current;
        if (!outer) { return; }

        const fresh = computePageStarts(
          outer,
          systemBandsRef.current,
          paginationHeight(outer),
          Math.max(0, topGutterPx),
          Math.max(0, bottomGutterPx)
        );
        if (!fresh.length) { return; }

        pageStartIdxsRef.current = fresh;

        let idx: number;
        if (dir === 1) {
          idx = fresh.findIndex((s) => s >= desiredStart);
          if (idx < 0) { idx = fresh.length - 1; }
        } else {
          let firstGreater = fresh.findIndex((s) => s > desiredStart);
          if (firstGreater < 0) { firstGreater = fresh.length; }
          idx = Math.max(0, firstGreater - 1);
        }

        if (idx !== beforePage) {
          const prevTag = outer.dataset.viewerFunc ?? "";
          outer.dataset.viewerFunc = "turnPage/raf";
          try {
            applyPage(idx);
          } finally {
            outer.dataset.viewerFunc = prevTag;
          }
        }
      });
    },
    [applyPage, paginationHeight, topGutterPx, bottomGutterPx]
  );

  // Allow callers to pass through the triggering event.
  const goNext = useCallback((e?: unknown) => turnPage(1, e), [turnPage]);
  const goPrev = useCallback((e?: unknown) => turnPage(-1, e), [turnPage]);

  // Wheel & keyboard paging (disabled while busy)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current || busyRef.current) {
        return;
      }
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) {
        return;
      }
      e.preventDefault();
      if (e.deltaY > 0) {
        goNext(e);
      } else {
        goPrev(e);
      }
    };

    // NAV: __ const onKey
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current || busyRef.current) {
        return;
      }
      if (["PageDown", "ArrowDown", " "].includes(e.key)) {
        e.preventDefault();
        goNext(e);
      } else if (["PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        goPrev(e);
      } else if (e.key === "Home") {
        e.preventDefault();
        applyPage(0);
      } else if (e.key === "End") {
        e.preventDefault();
        const last = Math.max(0, pageStartIdxsRef.current.length - 1);
        applyPage(last);
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [applyPage, goNext, goPrev]);

  // Touch swipe paging + two-finger pinch zoom (disabled while busy)
  useEffect(() => {
    const outer = wrapRef.current;
    if (!outer) { return; }

    let startY = 0;
    let startX = 0;
    let startT = 0;
    let swipeActive = false;

    // Tunables for what counts as a "tap"
    const TAP_MAX_MS = 250;       // quick touch
    const TAP_MAX_MOVE_PX = 12;   // little to no movement

    const dist = (t0: Touch, t1: Touch) => {
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      return Math.hypot(dx, dy);
    };

    // NAV: __ const queueWidthReflowFromPinch
    const queueWidthReflowFromPinch = () => {
      // If heavy work is already in flight, just queue a follow-up and bail.
      if (reflowRunningRef.current || repaginationRunningRef.current || busyRef.current) {
        reflowAgainRef.current = "width";
        reflowQueuedCauseRef.current = "pinch";
        return;
      }

      // We’re idle → run a width reflow *now*.
      reflowAgainRef.current = "none";
      reflowQueuedCauseRef.current = "";
      reflowFnRef.current();
    };

    // NAV: __ const onTouchStart
    const onTouchStart = (e: TouchEvent) => {
      if (!readyRef.current || busyRef.current || e.touches.length === 0) {
        return;
      }

      // Two-finger start → begin pinch tracking and block native pinch-zoom
      if (e.touches.length === 2) {
        // IMPORTANT: this only works if touchstart is non-passive
        e.preventDefault();

        const [t0, t1] = [e.touches[0]!, e.touches[1]!];
        const d0 = dist(t0, t1);
        if (d0 <= 0 || !Number.isFinite(d0)) { return; }

        pinchStateRef.current = {
          active: true,
          startDist: d0,
          startZoom: zoomFactorRef.current || 1,
        };

        // While pinch is active, we don't want swipe/tap paging
        swipeActive = false;
        return;
      }

      // Single-finger start → normal tap/swipe path (if not pinching)
      if (pinchStateRef.current?.active) {
        // ignore single-finger events while pinch is active
        return;
      }

      swipeActive = true;
      startY = e.touches[0]?.clientY ?? 0;
      startX = e.touches[0]?.clientX ?? 0;
      startT = performance.now();
    };

    // NAV: __ const onTouchMove
    const onTouchMove = (e: TouchEvent) => {
      if (!readyRef.current || busyRef.current) {
        return;
      }

      const pinch = pinchStateRef.current;

      // Active pinch: update zoom factor from distance ratio
      if (pinch?.active && e.touches.length === 2) {
        e.preventDefault(); // try to prevent browser/page pinch zoom

        const [t0, t1] = [e.touches[0]!, e.touches[1]!];
        const dNow = dist(t0, t1);
        if (dNow <= 0 || !Number.isFinite(dNow)) { return; }

        const rawScale = dNow / pinch.startDist;
        if (!Number.isFinite(rawScale) || rawScale <= 0) { return; }

        // Ignore tiny "wiggles" so a two-finger tap doesn't trigger reflow
        const SCALE_EPS = 0.05; // 5% change before we consider it a real pinch
        if (Math.abs(rawScale - 1) < SCALE_EPS) {
          return;
        }

        const targetZoom = clampZoom(pinch.startZoom * rawScale);

        // Only bother if zoom actually changed a bit
        const currentZoom = zoomFactorRef.current || 1;
        if (Math.abs(targetZoom - currentZoom) < 0.01) {
          return;
        }

        zoomFactorRef.current = targetZoom;

        void logStep(
          `pinch: startZoom=${pinch.startZoom.toFixed(3)} ` +
          `rawScale=${rawScale.toFixed(3)} target=${targetZoom.toFixed(3)}`,
          { outer }
        );

        queueWidthReflowFromPinch();
        return;
      }

      // No pinch → preserve your existing behavior (just block scroll)
      if (!swipeActive) {
        return;
      }
      e.preventDefault();
    };

    // EDIT MODE: for short taps, decide between "edit tap" (inside measure → highlight)
    // and "page-turn tap" (outside all measures → goNext).
    // Non-edit: always treat as page-turn tap.
    // NAV: __ const onTouchEnd
    const onTouchEnd = (e: TouchEvent) => {
      // Mark the time of this touch gesture so we can ignore the follow-up mouse events
      lastTouchEndRef.current = performance.now();

      const pinch = pinchStateRef.current;

      // If a pinch was active and we lost one or both fingers, stop pinch and don't page.
      if (pinch?.active) {
        if (e.touches.length < 2) {
          pinchStateRef.current = null;
        }
        return;
      }

      if (!swipeActive || busyRef.current || !readyRef.current) {
        swipeActive = false;
        return;
      }
      swipeActive = false;

      const t = e.changedTouches[0];
      if (!t) { return; }

      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      const dt = performance.now() - startT;

      // 1) Tap-to-advance OR edit-tap (quick + tiny movement)
      if (Math.abs(dx) <= TAP_MAX_MOVE_PX && Math.abs(dy) <= TAP_MAX_MOVE_PX && dt <= TAP_MAX_MS) {
        // If we're NOT in edit mode, behave exactly as before.
        if (!isEditModeRef.current) {
          goNext(e);
          return;
        }

        // EDIT MODE: decide between "edit tap" and "page turn tap"
        const outerBox = outer.getBoundingClientRect();
        const xPage = t.clientX - outerBox.left;
        const yPage = t.clientY - outerBox.top;

        const rects = measureRectsRef.current;
        if (rects && rects.length) {
          for (const box of rects) {
            if (pointInMeasureRect(xPage, yPage, box)) {
              // Tap landed in a measure box → highlight, don't turn page.
              e.preventDefault();
              e.stopPropagation?.();

              const measureNumber = box.measureNumber;
              if (measureNumber > 0 && Number.isFinite(measureNumber)) {
                // Look up glyphs for avoidance (all except staff lines)
                const glyphsForMeasure = getAvoidanceGlyphsForMeasure(box.id);

                // Find a nearby non-glyph point inside this measure
                const safe = findSafePointRelForTap(
                  box,
                  xPage,
                  yPage,
                  glyphsForMeasure,
                );

                if (safe) {
                  setSelectedMeasureNumber(measureNumber);
                  setSelectedPointRel(safe);
                } else {
                  // Congested: keep measure selected but no point yet
                  setSelectedMeasureNumber(measureNumber);
                  setSelectedPointRel(null);
                }
              } else {
                setSelectedMeasureNumber(null);
                setSelectedPointRel(null);
              }

              openMeasurePreview({
                x: box.x,
                y: box.y,
                w: box.w,
                h: box.h,
              });

              return;
            }
          }
        }

        // Tap was NOT inside any measure rect → still treat as page-turn tap.
        setSelectedMeasureNumber(null);
        setSelectedPointRel(null);
        goNext(e);
        return;
      }

      // 2) Your existing swipe logic
      const THRESH = 40;
      const H_RATIO = 0.6;
      if (Math.abs(dy) >= THRESH && Math.abs(dx) <= Math.abs(dy) * H_RATIO) {
        if (dy < 0) {
          goNext(e);
        } else {
          goPrev(e);
        }
      }
    };

    outer.addEventListener("touchstart", onTouchStart, { passive: false });
    outer.addEventListener("touchmove", onTouchMove, { passive: false });
    outer.addEventListener("touchend", onTouchEnd, { passive: false });

    outer.style.overscrollBehavior = "contain";

    const cleanupOuter = outer;
    return () => {
      cleanupOuter.removeEventListener("touchstart", onTouchStart);
      cleanupOuter.removeEventListener("touchmove", onTouchMove);
      cleanupOuter.removeEventListener("touchend", onTouchEnd);
    };
  }, [goNext, goPrev, openMeasurePreview, getAvoidanceGlyphsForMeasure]);


  // Mouse single-click paging (disabled while busy)
  // NOTE: ignores double-click so we can reserve it for future edit mode
  // NOTE: In edit mode, pointerdown inside a measure calls preventDefault,
  // which suppresses these mouse events so we can show the measure overlay instead.
  // NAV: __ useEffect single-click
  useEffect(() => {
    const outer = wrapRef.current;
    if (!outer) { return; }

    let downX = 0;
    let downY = 0;
    let downT = 0;
    let armed = false;

    // same thresholds as touch so behavior matches
    const CLICK_MAX_MS = 250;
    const CLICK_MAX_MOVE_PX = 12;

    // NAV: ____ const onMouseDown
    const onMouseDown = (e: MouseEvent) => {
      if (!readyRef.current || busyRef.current) { return; }
      if (e.button !== 0) { return; }          // left click only

      // Ignore synthetic mouse events that immediately follow a touch tap
      // (common on mobile/tablet browsers)
      if (performance.now() - lastTouchEndRef.current < 400) {
        return;
      }

      armed = true;
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
    };

    // NAV: ____ const onMouseUp
    const onMouseUp = (e: MouseEvent) => {
      if (!armed) { return; }
      armed = false;

      if (!readyRef.current || busyRef.current) { return; }

      // if this was part of a double-click, ignore (we’ll use dblclick later for edit mode)
      if (e.detail >= 2) { return; }

      const dt = performance.now() - downT;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;

      const smallMove = Math.abs(dx) <= CLICK_MAX_MOVE_PX && Math.abs(dy) <= CLICK_MAX_MOVE_PX;
      if (smallMove && dt <= CLICK_MAX_MS) {
        e.preventDefault();
        goNext(e);
      }
    };

    outer.addEventListener("mousedown", onMouseDown);
    outer.addEventListener("mouseup", onMouseUp);

    return () => {
      outer.removeEventListener("mousedown", onMouseDown);
      outer.removeEventListener("mouseup", onMouseUp);
    };
  }, [goNext]);


  // NAV: ------------------------- viewport/reflow coordination

  // Recompute pagination when the visual viewport changes (URL bar, IME, orientation, etc.)
  // NAV: __ useEffect visual viewport change
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) { return; }

    const handleVVChange = () => {
      if (!readyRef.current) { return; }

      // debounce vv events
      if (vvTimerRef.current) { window.clearTimeout(vvTimerRef.current); }
      vvTimerRef.current = window.setTimeout(async () => {
        vvTimerRef.current = null;

        const outerNow = wrapRef.current;
        if (!outerNow) { return; }

        const prevFuncTag = outerNow.dataset.viewerFunc ?? "";
        outerNow.dataset.viewerFunc = "handleVVChange";

        try {
          // Current wrapper (host) size in CSS px
          const wrapW = outerNow.clientWidth;
          const wrapH = outerNow.clientHeight;

          // Current VisualViewport metrics (for diagnosis only)
          const vvW = Math.floor(vv?.width ?? 0);
          const vvH = Math.floor(vv?.height ?? 0);
          const vvScale = (vv?.scale ?? (window.devicePixelRatio || 1));

          // What we last handled (used to decide if work is needed)
          const handledWrapW = handledWRef.current;
          const handledWrapH = handledHRef.current;

          const widthChanged =
            handledWrapW === -1 || Math.abs(wrapW - handledWrapW) >= 1;
          const heightChanged =
            handledWrapH === -1 || Math.abs(wrapH - handledWrapH) >= 1;

          // Only log when we're going to act; keeps noise down long-term.
          if (widthChanged || heightChanged) {
            await logStep(
              `wrap: ${wrapW}×${wrapH} vv: ${vvW}×${vvH} scale: ${vvScale.toFixed(3)} ` +
              `handled: ${handledWrapW}×${handledWrapH} ΔW: ${widthChanged} ΔH: ${heightChanged}`,
              { outer: outerNow }
            );
          } else {
            return; // nothing to do
          }

          // Guard against heavy work overlapping
          const kind = widthChanged ? "width" : "height";
          if (busyRef.current) {
            reflowAgainRef.current = kind;
            reflowQueuedCauseRef.current = `vv:guard-busy:${kind}`;
            return;
          }
          if (reflowRunningRef.current) {
            reflowAgainRef.current = kind;
            reflowQueuedCauseRef.current = `vv:guard-reflow:${kind}`;
            return;
          }
          if (repaginationRunningRef.current) {
            reflowAgainRef.current = kind;
            reflowQueuedCauseRef.current = `vv:guard-repag:${kind}`;
            return;
          }

          // Do the work
          if (widthChanged) {
            // Horizontal change → full OSMD reflow + reset to page 1
            await reflowFnRef.current();
            handledWRef.current = wrapW;
            handledHRef.current = wrapH;
          } else {
            // Vertical-only change → cheap repagination (no spinner) + reset to page 1
            repagFnRef.current();
            handledHRef.current = wrapH;
          }
        } finally {
          outerNow.dataset.viewerFunc = prevFuncTag;
        }
      }, 200);
    };

    vv.addEventListener("resize", handleVVChange);
    vv.addEventListener("scroll", handleVVChange);
    return () => {
      vv.removeEventListener("resize", handleVVChange);
      vv.removeEventListener("scroll", handleVVChange);
      if (vvTimerRef.current) {
        window.clearTimeout(vvTimerRef.current);
        vvTimerRef.current = null;
      }
    };
  }, []);


  // Auto-clear busy if we linger too long *outside* heavy phases.
  // Heavy phases are exactly: "render" and "scan".
  // NAV: __ useEffect auto-clear
  useEffect(() => {
    if (!busy) { return; }

    const t = window.setTimeout(() => {
      const phase = wrapRef.current?.dataset.viewerPhase ?? "";
      const inHeavy = phase === "render" || phase === "scan";

      const isFatal =
        (wrapRef.current?.dataset.viewerFatal === "1") || Boolean(fatalReason);

      if (!inHeavy && !isFatal) {
        hideBusy();
        void logStep("busy:auto-clear");
      } else {
        void logStep(`busy:auto-clear:skipped phase=${phase} fatal=${String(isFatal)}`);
      }
    }, 20000);

    return () => window.clearTimeout(t);
  }, [busy, hideBusy, fatalReason]);  // ← include fatalReason in deps


  // POST-BUSY QUEUE DRAIN: if width/height work was queued while busy, run it now.
  // These kick off heavy paths; add a tiny breadcrumb, but don't await paint here.
  useEffect(() => {
    if (busy) { return; } // only act when the overlay turned off
    const queued = reflowAgainRef.current;
    reflowAgainRef.current = "none";

    if (queued === "width") {
      const cause = reflowQueuedCauseRef.current || "drain:post-busy";
      reflowQueuedCauseRef.current = "";
      window.setTimeout(() => {
        void logStep(`queue:drain:width cause=${cause}`);
        reflowFnRef.current();
      }, 0);
    } else if (queued === "height") {
      window.setTimeout(() => {
        void logStep("queue:drain:height");
        repagFnRef.current();
      }, 0);
    }
  }, [busy]);

  // Restore spinner after tab re-activation; pause spinner fail-safe while hidden.
  useEffect(() => {
    const onVisibility = () => {
      const outer = wrapRef.current;
      if (!outer) { return; }

      const phase = outer.dataset.viewerPhase || "";
      const inHeavy =
        phase === "render" || phase === "scan" || reflowRunningRef.current;

      if (document.visibilityState === "hidden") {
        // Pause the fail-safe so it can't hide the overlay while we're backgrounded.
        if (spinnerFailSafeRef.current) {
          window.clearTimeout(spinnerFailSafeRef.current);
          spinnerFailSafeRef.current = null;
        }
        return;
      }

      // Back to visible: if we’re mid-run and the overlay is down, bring it back.
      if (inHeavy && !busyRef.current) {
        setBusyMsg(DEFAULT_BUSY_MSG);
        setBusy(true);
        // Re-arm a conservative fail-safe.
        if (!spinnerFailSafeRef.current) {
          spinnerFailSafeRef.current = window.setTimeout(() => {
            spinnerOwnerRef.current = null;
            hideBusy();
          }, SPINNER_FAILSAFE_MS);
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hideBusy]);


  // NAV: ------------------------- styles

  const outerStyle: React.CSSProperties = {
    width: "100%",
    height: vpHRef.current > 0 ? vpHRef.current : "100vh",
    minHeight: 320,
    position: "relative",
    overflow: "hidden",
    background: "#fff",
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2px)",
    boxSizing: "border-box",
    isolation: "isolate",
  };

  const hostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    minWidth: 0,
  };

  // Busy overlay 
  const blockerStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    display: busy ? "grid" : "none",
    placeItems: "center",
    background: "rgba(0,0,0,0.45)",
    backdropFilter: "blur(2px)",
    cursor: fatalReason ? "default" : "wait",
  };

  const stopEvent = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };


  // NAV: ------------------------- annotation interactions

  // Small "halo" so a tap right on the edge still counts
  const MEASURE_HIT_TOLERANCE = 8; // tweak if you like

  function pointInMeasureRect(
    xPage: number,
    yPage: number,
    box: { x: number; y: number; w: number; h: number },
    tol = MEASURE_HIT_TOLERANCE
  ): boolean {
    return (
      xPage >= box.x - tol &&
      xPage <= box.x + box.w + tol &&
      yPage >= box.y - tol &&
      yPage <= box.y + box.h + tol
    );
  }

  // annotation handle position (page-local px)
  let handlePxX: number | null = null;
  let handlePxY: number | null = null;

  if (selectedMeasureNumber !== null && selectedPointRel !== null) {
    const box = pageMeasureRectsRef.current.find(
      (b) => b.measureNumber === selectedMeasureNumber
    );
    if (box) {
      handlePxX = box.x + selectedPointRel.xRel * box.w;
      handlePxY = box.y + selectedPointRel.yRel * box.h;
    }
  }

  // NAV: __ const handleAnnotationHandlePointerDown
  const handleAnnotationHandlePointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      if (!isEditModeRef.current) {
        return;
      }

      const outer = wrapRef.current;
      if (!outer) {
        return;
      }

      // Mark this pointer as the active drag pointer
      dragPointerIdRef.current = ev.pointerId;

      // Cache the current measure box so we don’t search on every move
      if (selectedMeasureNumber !== null) {
        dragMeasureBoxRef.current =
          pageMeasureRectsRef.current.find(
            (b) => b.measureNumber === selectedMeasureNumber
          ) ?? null;
      } else {
        dragMeasureBoxRef.current = null;
      }

      // Live rel-coords will be filled by move handler
      dragRelRef.current = null;

      // Treat this as an "edit" gesture, not a page-turn
      suppressPageTurnRef.current = true;
      suppressClickRef.current = true;

      try {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      ev.preventDefault();
      ev.stopPropagation();
    },
    [selectedMeasureNumber]
  );

  // NAV: __ const handleAnnotationHandlePointerUp
  const handleAnnotationHandlePointerUp = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const dragId = dragPointerIdRef.current;
      if (dragId === null || ev.pointerId !== dragId) {
        return;
      }

      dragPointerIdRef.current = null;

      try {
        (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      ev.preventDefault();
      ev.stopPropagation();

      // Clear suppression for the next gesture
      suppressPageTurnRef.current = false;
      suppressClickRef.current = false;

      const measureNumber = selectedMeasureNumber;
      const dragRel = dragRelRef.current;
      const box = dragMeasureBoxRef.current;

      // Reset drag-specific refs
      dragRelRef.current = null;
      dragMeasureBoxRef.current = null;

      if (
        measureNumber === null ||
        !dragRel ||
        !box
      ) {
        return;
      }

      const { xRel, yRel } = dragRel;

      // Clamp again defensively, just in case
      const clampedXRel = clampUnitInterval(xRel);
      const clampedYRel = clampUnitInterval(yRel);

      const finalRel = { xRel: clampedXRel, yRel: clampedYRel };

      // Commit into React state once
      setSelectedPointRel(finalRel);

      // And run your existing save flow
      void promptAndSaveAnnotation(measureNumber, finalRel);
    },
    [promptAndSaveAnnotation, selectedMeasureNumber, setSelectedPointRel]
  );

  // NAV: __ const handleViewerPointerMoveCapture
  const handleViewerPointerMoveCapture = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const dragId = dragPointerIdRef.current;
      if (dragId === null || ev.pointerId !== dragId) {
        return;
      }

      if (!isEditModeRef.current) {
        return;
      }

      const outer = wrapRef.current;
      const box = dragMeasureBoxRef.current;
      const handleNode = annotationHandleRef.current;

      if (!outer || !box || !handleNode) {
        return;
      }

      const outerBox = outer.getBoundingClientRect();

      // Pointer position in "page" coords (viewer-local)
      const pointerX = ev.clientX - outerBox.left;
      const pointerY = ev.clientY - outerBox.top;

      const start = dragStartPageRef.current;
      if (start) {
        const dx = pointerX - start.x;
        const dy = pointerY - start.y;
        if ((dx * dx + dy * dy) > (3 * 3)) {
          dragHasMovedRef.current = true;
        }
      }

      // We treat the pointer as being at the *bottom* of the stem.
      // Caret tip is above by HANDLE_TIP_HEIGHT + HANDLE_STEM_HEIGHT/2.
      const DRAG_ANCHOR_OFFSET = HANDLE_TIP_HEIGHT + (HANDLE_STEM_HEIGHT / 2);

      const tipX = pointerX;
      const tipY = pointerY - DRAG_ANCHOR_OFFSET;

      // ✅ Phase 0: free drag anywhere (no clamping, no glyph avoidance).
      // Move the handle wrapper so that the caret tip is at (tipX, tipY).
      handleNode.style.left = `${tipX - HANDLE_STEM_WIDTH / 2}px`;
      handleNode.style.top = `${tipY}px`;

      // Keep React state in sync ONLY when the tip is inside the original start-measure box.
      // IMPORTANT: do NOT clear selectedPointRel when outside, or the handle will unrender.
      const inBox =
        tipX >= box.x &&
        tipX <= box.x + box.w &&
        tipY >= box.y &&
        tipY <= box.y + box.h;

      if (inBox && box.w > 0 && box.h > 0) {
        const xRel = clampUnitInterval((tipX - box.x) / box.w);
        const yRel = clampUnitInterval((tipY - box.y) / box.h);

        dragRelRef.current = { xRel, yRel };
        setSelectedPointRel({ xRel, yRel });
      }
      // else: outside box → leave dragRelRef/selectedPointRel as-is so the handle stays mounted

      ev.preventDefault();
      ev.stopPropagation();
    },
    [setSelectedPointRel],
  );


  // NAV: ------------------------- render output (JSX)

  return (
    <div
      ref={wrapRef}
      onPointerDownCapture={handleViewerPointerDownCapture}
      onPointerUpCapture={handleViewerPointerUpCapture}
      onPointerMoveCapture={handleViewerPointerMoveCapture}
      onClickCapture={handleViewerClickCapture}
      onContextMenu={stopEvent}  // <-- prevent long-press menus (tablet) 
      style={{
        ...outerStyle,
        position: "relative", // <-- ensure absolute children anchor here
        userSelect: "none",
        WebkitUserSelect: "none",
        ["msUserSelect"]: "none",
        touchAction: "none",
      }}
    >
      {showGlyphDebug && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 200,
          }}
        >
          {Object.entries(glyphDebugRects).flatMap(([measureId, rects]) =>
            rects.map((r, i) => (
              <div
                key={measureId + ":" + i}
                style={{
                  position: "absolute",
                  left: r.x,
                  top: r.y,
                  width: r.w,
                  height: r.h,
                  border: "1px solid rgba(0,0,255,0.5)",
                  background: "rgba(0,0,255,0.15)",
                  pointerEvents: "auto", // only matters in diag mode
                }}
              />
            ))
          )}
        </div>
      )}

      {/* NOTE HALOS (edit mode) */}
      {isEditMode && isAuthenticated && (
        <div
          key={haloEpoch}
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 210,
          }}
        >
          {(measureRectsRef.current ?? []).flatMap((box) => {
            const anchors = measureNoteAnchorsRef.current?.[box.id] ?? [];

            // --------------------------------------------
            // A) Halos (notes only; keep blue)
            // --------------------------------------------
            const haloEls = anchors
              .filter((a) => a.kind === "note")
              .map((a) => {
                const rInner = Math.max(6, a.h * 0.55);
                const rOuter = Math.max(12, a.h * 1.10);

                const border = "rgba(0, 120, 255, 0.55)";
                const fill = "rgba(0, 120, 255, 0.12)";

                return (
                  <div
                    key={`${box.id}:${a.id}`}
                    style={{
                      position: "absolute",
                      left: a.x - rOuter,
                      top: a.y - rOuter,
                      width: rOuter * 2,
                      height: rOuter * 2,
                      borderRadius: "50%",
                      border: `2px solid ${border}`,
                      background: fill,
                      boxSizing: "border-box",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: rOuter - rInner,
                        top: rOuter - rInner,
                        width: rInner * 2,
                        height: rInner * 2,
                        borderRadius: "50%",
                        border: `1px dashed ${border}`,
                        background: "transparent",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                );
              });

            // --------------------------------------------
            // B) Exclusion DIAG (only the things you filtered out)
            // --------------------------------------------
            const diagEls = SHOW_NOTEHEAD_EXCLUSION_DIAG
              ? anchors
                .filter((a) => a.kind === "rest")
                .map((a) => {
                  const tag = typeof a.glyphTag === "string" ? a.glyphTag : "";
                  const tall = typeof a.tallRatio === "number" ? a.tallRatio.toFixed(2) : "?";
                  const asp = typeof a.aspect === "number" ? a.aspect.toFixed(2) : "?";
                  const area = typeof a.area === "number" ? Math.round(a.area) : "?";

                  const label = `${a.id} rest ${tag} tr=${tall} asp=${asp} A=${area}`;

                  return (
                    <div
                      key={`${box.id}:${a.id}:diag`}
                      style={{
                        position: "absolute",
                        left: a.x - a.w / 2,
                        top: a.y - a.h / 2,
                        width: a.w,
                        height: a.h,
                        boxSizing: "border-box",
                        border: "2px solid rgba(255, 140, 0, 0.85)",
                        background: "rgba(255, 140, 0, 0.06)",
                        pointerEvents: "none",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          top: -18,
                          padding: "2px 4px",
                          borderRadius: 4,
                          fontSize: 11,
                          lineHeight: "12px",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          color: "rgba(20, 20, 20, 0.92)",
                          background: "rgba(255, 240, 200, 0.92)",
                          border: "1px solid rgba(120, 90, 30, 0.45)",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
                          whiteSpace: "nowrap",
                          pointerEvents: "none",
                        }}
                      >
                        {label}
                      </div>
                    </div>
                  );
                })
              : [];

            // --------------------------------------------
            // C) Anchor labels + anchor bboxes (ALL anchors)
            // --------------------------------------------
            const anchorDebugEls = SHOW_ANCHOR_TAGS
              ? anchors.flatMap((a) => {
                const tag = typeof a.glyphTag === "string" ? a.glyphTag : "";
                const tr = typeof a.tallRatio === "number" ? a.tallRatio.toFixed(2) : "?";
                const label = `${a.id} ${a.kind} ${tag} tr=${tr}`;

                const bboxEl = (
                  <div
                    key={`${box.id}:${a.id}:abox`}
                    style={{
                      position: "absolute",
                      left: a.x - a.w / 2,
                      top: a.y - a.h / 2,
                      width: a.w,
                      height: a.h,
                      boxSizing: "border-box",
                      border: "1px solid rgba(0, 0, 0, 0.35)",
                      background: "transparent",
                      pointerEvents: "none",
                    }}
                  />
                );

                const labelEl = (
                  <div
                    key={`${box.id}:${a.id}:alabel`}
                    style={{
                      position: "absolute",
                      left: a.x + 6,
                      top: a.y - 18,
                      padding: "1px 3px",
                      borderRadius: 3,
                      fontSize: 11,
                      lineHeight: "12px",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      color: "rgba(20, 20, 20, 0.92)",
                      background: "rgba(255, 255, 255, 0.92)",
                      border: "1px solid rgba(0, 0, 0, 0.25)",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {label}
                  </div>
                );

                return [bboxEl, labelEl];
              })
              : [];

            return [...haloEls, ...diagEls, ...anchorDebugEls];
          })}
        </div>
      )}

      {/* OSMD host (SVG goes here) */}
      <div
        ref={svgHostRef}
        style={{
          ...hostStyle,
          userSelect: "none",
          WebkitUserSelect: "none",
          ["msUserSelect"]: "none",
          touchAction: "none",
        }}
        draggable={false}
      />
      {/* Input-blocking overlay while busy (spinner hidden for fatal states) */}
      <div
        aria-busy={fatalReason ? false : busy}
        role={fatalReason ? "alert" : "status"}
        aria-live={fatalReason ? "assertive" : "polite"}
        aria-atomic="true"
        style={blockerStyle}
        data-viewer-fatal={fatalReason ? "1" : "0"}
        onPointerDown={stopEvent}
        onPointerMove={stopEvent}
        onPointerUp={stopEvent}
        onTouchStart={stopEvent}
        onTouchMove={stopEvent}
        onWheel={stopEvent}
        onScroll={stopEvent}
        onMouseDown={stopEvent}
        onContextMenu={stopEvent}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.92)",
            borderRadius: 12,
            padding: "10px 14px",
            boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
            fontSize: 14,
            color: "#111",
            textAlign: "center",
            minWidth: 140,
          }}
        >
          {/* Spinner only for non-fatal busy states */}
          {!fatalReason && (
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: "2px solid rgba(0,0,0,0.4)",
                borderTopColor: "transparent",
                margin: "0 auto 8px",
                animation: "viewer-spin 0.9s linear infinite",
              }}
            />
          )}

          <div style={{ whiteSpace: "pre-wrap" }}>
            {busyMsg || DEFAULT_BUSY_MSG}
          </div>
        </div>
      </div>

      {/* EDIT / DONE toggle hotspot */}
      {isAuthenticated && (
        <button
          type="button"
          data-ignore-page-turn="true"
          // Touch/pen only: stop parent page-turn handlers *early*
          onPointerDownCapture={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onPointerUpCapture={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          // Your ORIGINAL handlers (leave PC behavior untouched)
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // If we are entering edit mode, ensure the user_song row exists first
            if (!isEditMode) {
              try {
                await ensureUserSongRow();
              } catch (err) {
                console.error("Failed to ensure user_song row", err);
                // If you want to block entering edit mode on failure, early-return here.
                // return;
              }
            }

            // Then toggle edit mode (Edit <-> Done)
            toggleEditMode();
          }}
          aria-pressed={isEditMode}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 100,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #999",
            background: isEditMode ? "#222" : "#f5f5f5",
            color: isEditMode ? "#fff" : "#111",
            fontSize: 14,
            cursor: "pointer",
            opacity: 0.9,
            pointerEvents: "auto", // be explicit
            touchAction: "none",   // helps prevent gesture interpretation
          }}
        >
          {isEditMode ? "Done" : "Edit"}
        </button>
      )}

      {/* DEBUG / preview root for cropped measure overlay*/}
      <div
        data-debug-measure-preview-root="1"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 50,
        }}
        ref={measurePreviewHostRef}
      >
        {measurePreviewRect && (
          <div
            style={{
              position: "absolute",
              left: measurePreviewRect.x,
              top: measurePreviewRect.y,
              width: measurePreviewRect.w,
              height: measurePreviewRect.h,
              border: "3px solid rgba(250, 50, 50, 0.8)",
              borderRadius: "4px",
              background: "rgba(255, 200, 200, 0.15)",
              boxShadow: "0 0 10px rgba(255, 0, 0, 0.4)",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Draggable annotation placement handle (caret-style) */}
        {isEditMode &&
          selectedMeasureNumber !== null &&
          selectedPointRel !== null &&
          handlePxX !== null &&
          handlePxY !== null && (
            <div
              data-annotation-handle="1"
              ref={annotationHandleRef}
              style={{
                position: "absolute",
                left: handlePxX - HANDLE_STEM_WIDTH / 2,
                top: handlePxY,
                width: HANDLE_STEM_WIDTH,
                height: HANDLE_TIP_HEIGHT + (HANDLE_STEM_HEIGHT / 2),
                zIndex: 60,
                pointerEvents: "none", // hit-testing only on the stem child
              }}
            >
              {/* STEM (the thing you actually grab) */}
              <div
                data-annotation-handle-stem="1"
                style={{
                  position: "absolute",
                  left: "50%",
                  top: HANDLE_TIP_HEIGHT,
                  transform: "translateX(-50%)",
                  width: HANDLE_STEM_WIDTH,
                  height: HANDLE_STEM_HEIGHT,
                  borderRadius: 9999,                  //HANDLE_BORDER_RADIUS,
                  background: "rgba(0,0,0,0.85)",
                  border: "2px solid #fff",
                  boxShadow: "0 0 6px rgba(0,0,0,0.5)",
                  pointerEvents: "auto",
                  touchAction: "none",
                  cursor: "grab",
                }}
                onPointerDownCapture={handleAnnotationHandlePointerDown}
                onPointerUpCapture={handleAnnotationHandlePointerUp}
              />

              {/* Triangle tip — the true annotation point, pointing UP */}
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: 0,
                  transform: "translateX(-50%)",
                  width: 0,
                  height: 0,
                  borderLeft: `${HANDLE_TIP_WIDTH}px solid transparent`,
                  borderRight: `${HANDLE_TIP_WIDTH}px solid transparent`,
                  borderBottom: `${HANDLE_TIP_HEIGHT}px solid rgba(0,0,0,0.85)`,
                  pointerEvents: "none",
                }}
              />
            </div>
          )}

      </div>
      <style>{`@keyframes viewer-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
