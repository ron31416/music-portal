// src/components/ScoreViewer.tsx 
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { useAnnotations } from "@/components/AnnotationsProvider";
import type { AnnotationPayload } from "@/components/AnnotationsProvider";

// ---------- Props & Types ----------

// Extend the Window type without using `any`
declare global {
  interface Window {
    debugShowMeasurePreview?: (x: number, y: number, w: number, h: number) => void;
  }
}

interface Band { top: number; bottom: number; height: number }

// Viewer-space rectangle (left/top/width/height in px, relative to wrapper host)
interface Rect { x: number; y: number; w: number; h: number }

type BBox = { left: number; right: number; top: number; bottom: number; kind?: string };

export function snapToClearRowY(
  candidateY: number,
  boxes: BBox[],
  left: number,
  right: number,
  opts?: {
    padX?: number;
    padY?: number;
    search?: number;
    logTag?: string;
  }
): number {
  const padX = opts?.padX ?? 2;
  const padY = opts?.padY ?? 2;
  const search = opts?.search ?? 3;

  function hasInkAtY(y: number): boolean {
    for (const b of boxes) {
      if (b.right < left - padX) { continue; }
      if (b.left > right + padX) { continue; }
      if (y >= b.top - padY && y <= b.bottom + padY) { return true; }
    }
    return false;
  }

  if (!hasInkAtY(candidateY)) { return candidateY; }

  for (let d = 1; d <= search; d++) {
    if (!hasInkAtY(candidateY - d)) { return candidateY - d; }
    if (!hasInkAtY(candidateY + d)) { return candidateY + d; }
  }

  return candidateY;
}

// Type: function stored in a ref
type ReflowCallback = () => Promise<void>;

// Central pagination/masking knobs (tuned for Hi/Lo DPR). Change here, not inline.
const REFLOW = {
  // Width used for OSMD's layout (computed from container width / zoom, then clamped)
  MIN_LAYOUT_W: 320,
  MAX_LAYOUT_W: 1600,
  WIDTH_NUDGE: -1,           // small bias to avoid edge-case layouts

  // Pagination height slop: lets us fill the page slightly past the visible height
  PAGE_FILL_SLOP_PX: 8,

  // Masking/peek guards between pages (don’t usually need to touch)
  MASK_BOTTOM_SAFETY_PX: 12,

  // Fixed bottom cutter padding
  BOTTOM_PEEK_PAD_LO_DPR: 5,
  BOTTOM_PEEK_PAD_HI_DPR: 6,

  // base headroom for both system bands and measure boxes
  PAD_PX_BASE: 12
} as const;

async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(tag)), ms);
    p.then(v => { window.clearTimeout(t); resolve(v); },
      e => { window.clearTimeout(t); reject(e); });
  });
}


// Await osmd.load(...) whether it returns void or a Promise.
// (No "maybe" checks needed.)
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


// --- Instance-scoped afterPaint factory (safe for multiple components) ---
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


function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg");
}


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


// URL-driven debug flags: #viewer-log or #viewer-diag 
function readDebugFlag(name: string, fallback = false): boolean {
  try {
    const read = (s: string) => {
      const params = new URLSearchParams(s);
      const v = params.get(name);
      if (v !== null) {
        const t = v.toLowerCase();
        return t === "" || t === "1" || t === "true" || t === "on" || t === "yes";
      }
      // also allow presence-only tokens in hash, e.g. "#viewer-log"
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
// URL flags (read once at module import; change URL + Reload to apply)
const URL_LOG = readDebugFlag("viewer-log", false);
const URL_PAG = readDebugFlag("viewer-diag", false);

// Effective switches: pagination diag implies logging
const isLogOn = () => URL_LOG || URL_PAG;
const isDiagOn = () => URL_PAG;


export async function logStep(
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
  }
}


// Wait for web fonts to be ready (bounded; prevents rare long hangs)
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


function dynamicBandGapPx(): number {
  // Tighten the merge threshold: only bridge true micro-gaps from rounding/jitter.
  const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
  // Old: 4/3. New: 2/1 keeps systems separate on cramped pages.
  return dpr >= 2 ? 2 : 1;
}


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
function createSvgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  ns = "http://www.w3.org/2000/svg"
): SVGElementTagNameMap[K] {
  return document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
}


// Return a *new* Band[] whose top/bottom are expanded for annotation headroom.
// Pads are capped by the page gutters so we never ask for more space than exists.
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
      // If your Band type has other fields, copy them here:
      // ...(b as any),
      // then overwrite top/bottom/height after spreading
    } as Band;
  }
  return out;
}

// Logs hard warnings when padded bands overlap or leave too little gap.
// Overlap > 0 means the page needs data-level spacing (MusicXML) fixes.
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


// --- Annotation types ---

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

//TEST
// One rendered glyph (notehead, rest, etc.) in page-local coordinates
type GlyphRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  debug?: string; // NEW
};
//TEST

// One text mark inside a measure, positioned relative to the box [0,1] × [0,1]
type AnnotationTextItem = {
  kind: "text";
  xRel: number;
  yRel: number;
  text: string;
};

// Viewer-side payload: everything from DB AnnotationPayload,
// plus "items" which is what drawAnnotationBoxes reads.
type MeasureAnnotation = AnnotationPayload & {
  items?: AnnotationTextItem[];
};

// Callback used by drawAnnotationBoxes to look up one measure’s annotation
type GetAnnotationsForMeasure = (measureNumber: number) => MeasureAnnotation | undefined;


// Pure geometry helper: computes the measure-box rectangles for the
// *current page* using the same logic drawMeasureBoxes used before.
// No DOM/side effects — just numbers we can reuse (e.g. for annotations).
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

  // --- Build seps[] exactly as in the original drawMeasureBoxes ---

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

  // --- Bucket measures by tile (system) exactly the way you were doing it ---

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

  // --- Geometry lookup: same normalization strategy as before ---

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

  // --- Walk tiles in order, compute rects exactly as before ---

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
  maskTopWithinMusicPx: number
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
  const rects = computeMeasureBoxRectsForPage(
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

    // Diagnostic measure label (preserving your behaviour)
    const measureNum = Number(id);
    if (Number.isFinite(measureNum)) {
      const textEl = createSvgEl("text");
      textEl.textContent = String(measureNum);

      const labelX = x + 2;
      const labelY = y + 10;

      textEl.setAttribute("x", String(labelX));
      textEl.setAttribute("y", String(labelY));
      textEl.setAttribute("font-size", "10");
      textEl.setAttribute("fill", "red");
      textEl.setAttribute("stroke", "black");
      textEl.setAttribute("stroke-width", "0.5");

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
function clearMeasureBoxes(outer: HTMLDivElement): void {
  outer.querySelectorAll("[data-viewer-measureboxes='1']").forEach(n => n.remove());
}


// Filled annotation overlay (per-measure), using the exact same geometry
// as measure boxes. Separate layer so we can style/clear independently.
function drawAnnotationBoxes(
  outer: HTMLDivElement,
  rects: ReadonlyArray<MeasureBoxRect>,
  getAnnotationsForMeasure: GetAnnotationsForMeasure
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

  for (const box of rects) {
    // --- Retrieve DB annotation (if any) ---
    const annotation = getAnnotationsForMeasure(box.measureNumber);
    if (!annotation) {
      continue;
    }

    const items = Array.isArray(annotation.items) ? annotation.items : [];
    if (!items.length) {
      continue;
    }

    for (const item of items) {
      if (item.kind !== "text") {
        continue;
      }

      // Clamp to [0,1] in both directions
      const xRel = Math.max(0, Math.min(1, item.xRel));
      const yRel = Math.max(0, Math.min(1, item.yRel));

      // Convert to page-local px coordinates
      const pxX = box.x + xRel * box.w;
      const pxY = box.y + yRel * box.h;

      const t = createSvgEl("text");
      t.textContent = item.text;
      t.setAttribute("x", String(pxX));
      t.setAttribute("y", String(pxY));
      t.setAttribute("fill", "black");
      t.setAttribute("font-size", "14");
      t.setAttribute("font-family", "sans-serif");
      t.setAttribute("dominant-baseline", "middle");
      t.setAttribute("text-anchor", "middle");

      g.appendChild(t);
    }
  }

  outer.appendChild(layer);
  try {
    outer.dataset.viewerFunc = prevFuncTag;
  } catch { }
}


// Remove the annotation overlay layer if present.
function clearAnnotationBoxes(outer: HTMLDivElement): void {
  outer.querySelectorAll("[data-viewer-annotations='1']").forEach((n) => n.remove());
}


// Deterministic page starts from measured system rectangles (strict, bottom-based).
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

    // --- Same “usable height” model as applyPage ---
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


function hasZoomProp(o: unknown): o is { Zoom: number } {
  if (typeof o !== "object" || o === null) { return false; }
  const maybe = o as { Zoom?: unknown };
  return typeof maybe.Zoom === "number";
}


function perfMark(n: string) { try { performance.mark(n); } catch { } }

function perfMeasure(n: string, a: string, b: string) {
  try { performance.measure(n, { start: a, end: b }); } catch { }
}

function perfLastMs(name: string) {
  const e = performance.getEntriesByName(name);
  return Math.round(e[e.length - 1]?.duration || 0);
}

// --------- Perf blocks (module-scope; reusable) ---------
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


function rebuildMeasureToPageMapping(
  bands: ReadonlyArray<Band>,                 // whatever your Band type is
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
    const mNum = Number(id);        // your ids are "1", "2", ...
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
export function findAnchorMeasure(
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

//TEST
function clamp01(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

function hitsGlyphAt(
  xPage: number,
  yPage: number,
  glyphs: readonly GlyphRect[]
): boolean {
  const PAD = 5; // a little breathing room around glyphs
  for (const g of glyphs) {
    const withinX = xPage >= g.x - PAD && xPage <= g.x + g.w + PAD;
    const withinY = yPage >= g.y - PAD && yPage <= g.y + g.h + PAD;
    if (withinX && withinY) {
      return true;
    }
  }
  return false;
}

// Given a tap inside a measure box, find a nearby point that does NOT land on
// top of a glyph. Returns normalized coords, or null if no safe spot found.
function findSafePointRelForTap(
  box: MeasureBoxRect,
  xPage: number,
  yPage: number,
  glyphs: readonly GlyphRect[]
): PointRel | null {
  // If we have no glyph data, accept as-is (nothing to avoid).
  if (!glyphs.length) {
    const xRel0 = clamp01((xPage - box.x) / box.w);
    const yRel0 = clamp01((yPage - box.y) / box.h);
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
    xRel: clamp01((x - box.x) / box.w),
    yRel: clamp01((y - box.y) / box.h),
  });

  // Helper: point-in-rect for GlyphRect
  const pointInRect = (x: number, y: number, r: GlyphRect): boolean =>
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  const pointHitsAnyGlyph = (x: number, y: number): boolean =>
    hitsGlyphAt(x, y, glyphs);

  // 1) If the original point is not inside any glyph, use it directly.
  if (!pointHitsAnyGlyph(startX, startY)) {
    return toRel(startX, startY);
  }

  // We're colliding with at least one glyph.
  const collidingGlyphs = glyphs.filter((g) => pointInRect(startX, startY, g));

  const AVOID_MARGIN_PX = 4;                     // how far above/below glyph we try first
  const SEARCH_STEP_PX = 6;                     // step size for fallback vertical search
  const MAX_OFFSET_PX = Math.max(12, box.h * 0.4); // don’t wander too far

  // 2) For each colliding glyph, try directly above, then below that glyph
  for (const g of collidingGlyphs) {
    // Keep X near where the user clicked, but inside the box
    const centerX = Math.max(boxLeft, Math.min(startX, boxRight));

    // Just ABOVE this glyph
    const aboveY = g.y - AVOID_MARGIN_PX;
    if (aboveY >= boxTop && !pointHitsAnyGlyph(centerX, aboveY)) {
      return toRel(centerX, aboveY);
    }

    // Just BELOW this glyph
    const belowY = g.y + g.h + AVOID_MARGIN_PX;
    if (belowY <= boxBottom && !pointHitsAnyGlyph(centerX, belowY)) {
      return toRel(centerX, belowY);
    }
  }

  // 3) Last resort: walk up/down from the original tap in small vertical steps.
  for (
    let offset = SEARCH_STEP_PX;
    offset <= MAX_OFFSET_PX;
    offset += SEARCH_STEP_PX
  ) {
    const candidates = [startY - offset, startY + offset];

    for (const candY of candidates) {
      if (candY < boxTop || candY > boxBottom) {
        continue;
      }
      if (!pointHitsAnyGlyph(startX, candY)) {
        return toRel(startX, candY);
      }
    }
  }

  // 4) If we never found a clear spot, fall back to the original point.
  // (We prefer staying close, even if it overlaps a glyph, to teleporting
  // to a far-off grid cell.)
  return toRel(startX, startY);
}
//TEST


// Props for the score viewer; currently just the song source ID.
interface Props {
  src: string;
}

// ---------- Component ----------

export default function ScoreViewer({
  src,
}: Props) {

  // Pull annotation helpers from the provider.
  // This is the ONLY source of truth for annotation data.
  const {
    getAnnotationsForMeasure,
    saveAnnotationsForMeasure,
    annotationsByMeasure,
    isLoading: annotationsLoading,
  } = useAnnotations();

  // Always use the latest getAnnotationsForMeasure, even from stable callbacks / pipeline
  const getAnnotationsForMeasureRef = useRef<GetAnnotationsForMeasure>(
    // Default: no annotations
    () => undefined
  );
  useEffect(() => {
    getAnnotationsForMeasureRef.current = getAnnotationsForMeasure;
  }, [getAnnotationsForMeasure]);

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

  const handleViewerPointerDownCapture = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      // Mouse/pen only; touch is handled via touch events
      if (ev.pointerType === "touch") {
        return;
      }

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

        if (withinX && withinY) {
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
          if (measureNumber > 0 && Number.isFinite(measureNumber)) {
            // Look up glyph cloud for this measure
            const glyphsForMeasure =
              measureGlyphRectsRef.current[box.id] ?? [];

            // Find a nearby non-glyph point inside this measure
            const safe = findSafePointRelForTap(
              box,
              xPage,
              yPage,
              glyphsForMeasure
            );

            if (safe) {
              setSelectedMeasureNumber(measureNumber);
              setSelectedPointRel(safe);
            } else {
              // Everything nearby is congested; keep measure selected but no point yet.
              setSelectedMeasureNumber(measureNumber);
              setSelectedPointRel(null);
            }
          } else {
            setSelectedMeasureNumber(null);
            setSelectedPointRel(null);
          }

          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
      }

      // Click started outside any measure
      setSelectedMeasureNumber(null);
      setSelectedPointRel(null);
    },
    [setSelectedMeasureNumber, setSelectedPointRel,]
  );

  const handleViewerPointerUpCapture = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      if (!isEditModeRef.current) {
        return;
      }

      if (!suppressPageTurnRef.current) {
        // Pointer-down didn’t hit a measure box → normal page-turn
        return;
      }

      const rect = pendingMeasureRectRef.current;

      // Clear pointer flags for next gesture
      suppressPageTurnRef.current = false;
      pendingMeasureRectRef.current = null;

      if (!rect) {
        return;
      }

      // Eat this gesture so it does NOT become a page turn via pointer events
      ev.preventDefault();
      ev.stopPropagation();

      openMeasurePreview(rect);
    },
    [openMeasurePreview]
  );

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

  // Current page's measure rectangles (used for hit-testing in edit mode)
  const measureRectsRef = useRef<ReadonlyArray<MeasureBoxRect>>([]);

  //TEST
  // Per-measure glyph “cloud” in page-local coordinates
  const measureGlyphRectsRef = useRef<Record<string, GlyphRect[]>>({});
  //TEST

  // When true, this pointer gesture should NOT trigger a page turn.
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
  } | null>(null);

  // When edit mode toggles, redraw the boxes for the current page
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
          args.maskTopWithinMusicPx
        );
      }
    } catch { }
  }, [isEditMode]);

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

  // Track browser zoom relative to mount
  const baseScaleRef = useRef<number>(1);
  const zoomFactorRef = useRef<number>(1);

  // Track user pinch-zoom within the viewer
  const pinchStateRef = useRef<{
    active: boolean;
    startDist: number;
    startZoom: number;
  } | null>(null);

  // Timestamp of the last touchend, used to suppress synthetic mouse events
  const lastTouchEndRef = useRef<number>(0);

  const clampZoom = (z: number) => Math.max(0.5, Math.min(3, z));

  const computeZoomFactor = useCallback((): number => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const scaleNow = (vv && typeof vv.scale === "number") ? vv.scale : (window.devicePixelRatio || 1);
    const base = baseScaleRef.current || 1;
    const raw = scaleNow / base;
    if (!Number.isFinite(raw) || raw <= 0) { return 1; }
    // Clamp to a sane range so weird browser values don’t explode layout
    return Math.max(0.5, Math.min(3, raw));
  }, []);

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
        try { inst.Zoom = clamped; } catch { }
      }
    }
  }, []);

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

  // --- WIDTH-SANDBOXED RENDER (safe) ---
  // Render OSMD at a computed “layout width” derived from wrapper width and current zoom.
  // We temporarily pin the inner host <div> to that width (the “sandbox”), invoke osmd.render(),
  // then restore the host’s styles in finally. No persistent DOM/CSS changes.
  // Safe to call from both init and reflow paths.
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

  const measuresRef = useRef<ReadonlyArray<{ id: string; rect: Rect }>>([]);
  const barCandsRef = useRef<ReadonlyArray<BarCand>>([]);
  const geometryRef = useRef<ReadonlyMap<string, MeasureGeom>>(new Map());
  const pageMeasureRectsRef = useRef<MeasureBoxRect[]>([]);

  //TEST
  // Build a “glyph cloud” for the measures on the current page.
  //
  // For each visible SVG graphics element, we compute its page-local bounding box
  // and associate it with every measure box it intersects. Results are cached in
  // measureGlyphRectsRef by measureId.
  function populateGlyphRectsForPage(
    outer: HTMLDivElement,
    rects: ReadonlyArray<MeasureBoxRect>
  ): void {
    if (!rects.length) {
      return;
    }

    const svg = getSvg(outer);
    if (!svg) {
      return;
    }

    const outerRect = outer.getBoundingClientRect();

    // Only track glyphs for measures that are actually on this page.
    const perMeasure = new Map<string, GlyphRect[]>();
    for (const box of rects) {
      perMeasure.set(box.id, []);
    }

    // Back to "leaf" graphics only: no <g>, no <use>.
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

      // Keep anything that has *some* extent.
      // (Stems: w ~ 0, h > 0; Staff lines: w > 0, h ~ 0.)
      if (w <= 0 && h <= 0) {
        continue;
      }

      // Give hairlines a minimum visible size so they don't collapse away.
      const effW = w === 0 ? 1 : w;
      const effH = h === 0 ? 1 : h;

      const gx = r.left - outerRect.left;
      const gy = r.top - outerRect.top;

      // Heuristic: ignore any rect that basically covers the whole page;
      // these are usually container artifacts we don't want for avoidance.
      if (effW > pageW * 0.95 && effH > pageH * 0.95) {
        continue;
      }

      const glyphRect: GlyphRect = {
        x: gx,
        y: gy,
        w: effW,
        h: effH,
        // keep debug if you added it earlier:
        // debug: debugLabelForElement(el),
      };

      // Associate this glyph with any measure it intersects on this page.
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

    // Commit to ref for later use (e.g., findSafePointRelForTap)
    const next: Record<string, GlyphRect[]> = {
      ...measureGlyphRectsRef.current,
    };

    for (const [measureId, glyphs] of perMeasure.entries()) {
      if (glyphs.length) {
        next[measureId] = glyphs;
      }
    }

    measureGlyphRectsRef.current = next;

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
  }
  //TEST

  // Apply the chosen page to the viewport: translate the SVG to its start and mask/cut to hide any next-page peek.
  // May recompute page starts and re-apply to preserve whole systems; bounded recursion prevents oscillation.
  const applyPage = useCallback(
    (pageIdx: number): void => {
      const outer = wrapRef.current;
      if (!outer) { return; }

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

        if (!svg || !bands.length || !starts.length) { return; }

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
        if (!startBand) { return; }

        // NEXT page start (or -1 on last page) — this fixes the “line disappears” issue
        const nextStartIndex = (p + 1 < pages) ? starts[p + 1]! : -1;

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
        const lastIdxThisPage = nextStartIndex >= 0 ? nextStartIndex - 1 : (bands.length - 1);

        // --- MASK: cut exactly at the next system’s top, or just past the last on final page
        let maskTopWithinMusicPx = PAGE_H_USABLE;
        if (nextStartIndex >= 0) {
          // Non-last page: stop just above the next system so nothing peeks
          const nextTopRel = bands[nextStartIndex]!.top - ySnap;
          maskTopWithinMusicPx = Math.min(PAGE_H_USABLE, Math.max(0, Math.floor(nextTopRel) - 1));
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
        outer.dataset.viewerStarts = starts.slice(0, 12).join(',');
        outer.dataset.viewerTopGutter = String(Math.max(0, topGutterPx));
        outer.dataset.viewerBotGutter = String(Math.max(0, bottomGutterPx));  // if you added bottomGutterPx


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
        mask.style.top = `${Math.max(0, topGutterPx) + maskTopWithinMusicPx}px`;

        let bottomCutter = outer.querySelector<HTMLDivElement>("[data-viewer-bottomcutter='1']");
        const needsMask = maskTopWithinMusicPx < PAGE_H_USABLE;

        const lastForLog = nextStartIndex >= 0 ? (nextStartIndex - 1) : (bands.length - 1);
        if (isDiagOn()) {
          void logStep(
            `pages: ${p + 1}/${pages} startIndex: ${startIndex} lastForLog: ${lastForLog} ` +
            `nextStartIndex: ${nextStartIndex >= 0 ? `${nextStartIndex}` : "end"} ` +
            `ySnap: ${ySnap} PAGE_H_USABLE: ${PAGE_H_USABLE} maskTopWithinMusicPx: ${maskTopWithinMusicPx} needsMask: ${needsMask}`,
            { outer, caller: prevFuncTag }
          );
        }
        const first = startIndex;
        const last = lastForLog;     // use the same name you already use above
        const list = Array.from({ length: last - first + 1 }, (_, j) => first + j).join(",");
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
        // Always render the bottom gutter visually
        bottomCutter.style.height = `${Math.max(0, bottomGutterPx)}px`;
        bottomCutter.style.display = "block";

        let topCutter = outer.querySelector<HTMLDivElement>("[data-viewer-topcutter='1']");
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
        // Cache the args for edit-mode redraws (mode toggle)
        lastBoxDrawArgsRef.current = {
          outer,
          svgNN,
          measures: measuresRef.current ?? [],
          geometry: geometryRef.current ?? new Map(),
          bandsNN,
          startIndex,
          nextStartIndex,
          ySnap,
          topGutterPx: Math.max(0, topGutterPx),
          maskTopWithinMusicPx,
        };

        try {
          const measuresForPage = measuresRef.current ?? [];
          const geomForPage = geometryRef.current ?? new Map<string, MeasureGeom>();

          // Compute per-measure rects for THIS page using the shared helper.
          // This is the exact same geometry that drawMeasureBoxes uses.
          const rects = computeMeasureBoxRectsForPage(
            measuresForPage,
            geomForPage,
            bandsNN,
            startIndex,
            nextStartIndex,
            ySnap,
            Math.max(0, topGutterPx),
            maskTopWithinMusicPx
          );

          // Cache for future hit-testing / annotation logic
          pageMeasureRectsRef.current = rects;

          // Keep the current page's rects for edit-mode hit-testing
          measureRectsRef.current = rects;

          //TEST
          // NEW: build per-measure glyph “cloud” from the rendered SVG for this page.
          // Proof-of-concept: this only populates measureGlyphRectsRef + logs when diag is on.
          populateGlyphRectsForPage(outer, rects);
          //TEST

          // 1) Draw annotation fill layer (always visible, read + edit mode)
          clearAnnotationBoxes(outer);
          const getter = getAnnotationsForMeasureRef.current;
          if (rects.length && getter) {
            drawAnnotationBoxes(outer, rects, getter);
          }

          // 2) Draw stroke-only measure boxes when edit mode is active
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
              maskTopWithinMusicPx
            );
          }
        } catch {
          // viewer should not die over overlay drawing
          pageMeasureRectsRef.current = [];
        }

        // Stop layer promotion after page is applied
        svg.style.willChange = "auto";
      } finally {
        try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
      }
    },
    [visiblePageHeight, topGutterPx, bottomGutterPx, closeMeasurePreview]
  );


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

    const currentPage = Math.max(0, pageIdxRef.current || 0);

    const prevFunc = outer.dataset.viewerFunc ?? "";
    outer.dataset.viewerFunc = "annotationsChanged";

    try {
      void logStep(
        `annotationsChanged: page=${currentPage} measures=${Object.keys(
          annotationsByMeasure
        ).length}`,
        { outer }
      );
      applyPage(currentPage);
    } finally {
      outer.dataset.viewerFunc = prevFunc;
    }
  }, [annotationsLoading, annotationsByMeasure, layoutReady, applyPage]);

  // When a measure is selected in edit mode, prompt for annotation text.
  // NOTE: This is the minimal debug UI; will be replaced with a popup palette later.
  useEffect(() => {
    if (!isEditMode) {
      return;
    }

    if (
      selectedMeasureNumber === null ||
      selectedPointRel === null
    ) {
      return;
    }

    // Ask for text (debug, temporary)
    const label = window.prompt("Annotation text (e.g. mf, p, f)?", "");
    if (label === null) {
      // User canceled
      return;
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      return;
    }

    // Build new item
    const newItem: AnnotationTextItem = {
      kind: "text",
      xRel: selectedPointRel.xRel,
      yRel: selectedPointRel.yRel,
      text: trimmed,
    };

    // Grab existing or empty
    const existing = getAnnotationsForMeasure(selectedMeasureNumber);
    const items = Array.isArray(existing?.items)
      ? existing!.items
      : [];

    const nextPayload: MeasureAnnotation = {
      ...existing,
      items: [...items, newItem],
    };

    // Save (local optimistic update)
    void saveAnnotationsForMeasure(selectedMeasureNumber, nextPayload);

    // Clear selection so we don’t double-fire
    setSelectedMeasureNumber(null);
    setSelectedPointRel(null);
  }, [
    isEditMode,
    selectedMeasureNumber,
    selectedPointRel,
    getAnnotationsForMeasure,
    saveAnnotationsForMeasure,
    setSelectedMeasureNumber,
    setSelectedPointRel,
  ]);

  // Hide the SVG host while we do heavy work, then restore previous styles.
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

        // Bucket measures into tiles (systems) using overlap against [sep[k], sep[k+1]]
        type BucketItem = { m: { id: string; rect: Rect }; k: number };
        const buckets = new Map<number, BucketItem[]>();

        for (const m of measuresPre) {
          const rectTop = Math.round(m.rect.y);
          const rectBot = Math.round(m.rect.y + Math.max(1, Math.round(m.rect.h)));


          // choose tile by maximum vertical overlap
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
          await logStep(
            `geom: buckets: ` +
            Array.from(buckets.entries())
              .map(([k, arr]) =>
                `k=${k} count=${arr.length} ids=[${arr.map(bi => bi.m.id).join(",")}]`
              )
              .join(" | "),
            { outer, caller: prevFuncTag }
          );
        }

        // Collect inner-edge X positions of vertical barlines that belong to a given tile.
        // expectedBars = measures_in_tile + 1
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

            const xs = computeMeasureIntervals(bandTop, bandBot, expectedBars, leftBoundPx);

            if (isDiagOn()) {
              await logStep(
                `geom: tile k=${k} xs.len=${xs.length} xs=[${xs.join(",")}] expectedBars=${expectedBars}`,
                { outer, caller: prevFuncTag }
              );
            }

            if (xs.length < 2) { continue; }

            // intervals
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

              if (isDiagOn()) {
                void logStep(
                  `geom: tile k=${k} id=${m.id} interval=[${iv.left},${iv.right}] ` +
                  `mm.top=${mm.top} mm.bot=${mm.bottom}`,
                  { outer, caller: prevFuncTag }
                );
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

      // Optional diag
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


  // --- HEIGHT-ONLY REPAGINATION (no OSMD re-init) ---
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


  // reflowViewer
  // Heavy path for when effective layout width changes (width/zoom/DPR etc.).
  // Shows spinner, bumps run#, calls layoutViewer(), drains any queued work.
  // Concurrency-safe via reflowRunningRef; may queue a follow-up if invoked again mid-run.
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

  // initViewer
  // One-time boot for the component:
  // - feature checks, dynamic import of OSMD
  // - load MusicXML (MXL/URL), wait for fonts
  // - first layout via layoutViewer, then height-only repagination
  // - marks ready & clears the spinner
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


  // ---------- Paging helpers ----------

  // Ignore page turns if the originating event target is inside a UI control.
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

  // Small "halo" so a tap right on the edge still counts
  const MEASURE_HIT_TOLERANCE = 8; // tweak if you like

  // Clamp a number into the [min, max] interval
  function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
  }

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
                const xRel = clamp((xPage - box.x) / box.w, 0, 1);
                const yRel = clamp((yPage - box.y) / box.h, 0, 1);

                setSelectedMeasureNumber(measureNumber);
                setSelectedPointRel({ xRel, yRel });
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
  }, [goNext, goPrev, openMeasurePreview]);


  // Mouse single-click paging (disabled while busy)
  // NOTE: ignores double-click so we can reserve it for future edit mode
  // NOTE: In edit mode, pointerdown inside a measure calls preventDefault,
  // which suppresses these mouse events so we can show the measure overlay instead.
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

  // Recompute pagination when the visual viewport changes (URL bar, IME, orientation, etc.)
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


  // ---------- Styles ----------

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

  return (
    <div
      ref={wrapRef}
      onPointerDownCapture={handleViewerPointerDownCapture}
      onPointerUpCapture={handleViewerPointerUpCapture}
      onClickCapture={handleViewerClickCapture}
      style={{
        ...outerStyle,
        position: "relative", // <-- ensure absolute children anchor here
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
          {Object.entries(measureGlyphRectsRef.current).flatMap(([measureId, rects]) =>
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

      {/* OSMD host (SVG goes here) */}
      <div ref={svgHostRef} style={hostStyle} />

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

      {/* EDIT / DONE toggle hotspot*/}
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
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
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
      </div>
      <style>{`@keyframes viewer-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
