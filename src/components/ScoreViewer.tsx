/* eslint curly: ["error", "all"] */
// src/components/ScoreViewer.tsx
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* ---------- Props & Types ---------- */

interface Props {
  src: string;
  fillParent?: boolean; // default: true
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  topGutterPx?: number;
  bottomGutterPx?: number;
  debugShowAllMeasureNumbers?: boolean;
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

  // --- NEW: band/measure padding (will be capped by gutters) ---
  BAND_PAD_PX_BASE: 12,      // headroom added to each system band (top+bottom)
  MEASURE_PAD_PX_BASE: 8,    // headroom added to each measure box (clamped inside band)
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

          void logStep(`${label ?? ""} -> ${why} (${ms}ms)`, { outer });
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


/** Best-effort "wait until the browser can paint" (bounded) */
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
  } catch { /* ignore */ }
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
  opts: { paint?: boolean; outer?: HTMLDivElement | null } = {}
): Promise<void> {
  if (!isLogOn()) { return; }

  const { paint = false, outer = null } = opts;

  // Fixed DevTools console column widths (tweak as needed) 
  const FN_COL = 18;
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

    // Always render both columns with fixed widths.
    const fnChunk = `[${pad(fn === "(none)" ? "" : fn, FN_COL)}]`;
    const phaseChunk = `[${pad(phase === "(none)" ? "" : phase, PHASE_COL)}]`;

    const composed = `${fnChunk} ${phaseChunk} ${message}`;

    // eslint-disable-next-line no-console
    console.log(composed);

    if (wrap) {
      wrap.dataset.viewerLastLog = `${Date.now()}:${composed.slice(0, 80)}`;
    }

    if (paint) {
      await waitForPaint();
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


/** Wait for web fonts to be ready (bounded; prevents rare long hangs) */
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


/** Track the *visible* viewport height (accounts for mobile URL/tool bars) */
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

    void logStep(`bands: ${bands.length}`, { outer });

    return bands;
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
  }
}

/** Typed SVG factory (TS strict-friendly) */
function createSvgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  ns = "http://www.w3.org/2000/svg"
): SVGElementTagNameMap[K] {
  return document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
}


/**
 * Return a *new* Band[] whose top/bottom are expanded for annotation headroom.
 * Pads are capped by the page gutters so we never ask for more space than exists.
 */
function derivePaddedBands(
  raw: Band[],
  topGutterPx: number,
  bottomGutterPx: number
): Band[] {
  const padTop = Math.min(REFLOW.BAND_PAD_PX_BASE, Math.max(0, topGutterPx));
  const padBot = Math.min(REFLOW.BAND_PAD_PX_BASE, Math.max(0, bottomGutterPx));
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

/**
 * Logs hard warnings when padded bands overlap or leave too little gap.
 * Overlap > 0 means the page needs data-level spacing (MusicXML) fixes.
 */
function validateBandSpacing(
  outer: HTMLDivElement,
  bands: Band[],
  {
    minGapAlertPx = 2,   // log if the inter-system gap is smaller than this
  }: { minGapAlertPx?: number } = {}
): void {
  if (!bands.length) { return; }

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
    console.warn(`band-spacing check: overlaps=${overlaps} tightGaps(<${minGapAlertPx}px)=${tightGaps}`);

    // Emit per-incident detail (kept short).
    for (let i = 0; i + 1 < bands.length; i++) {
      const a = bands[i]!;
      const b = bands[i + 1]!;
      const gap = Math.floor(b.top) - Math.ceil(a.bottom);
      if (gap < 0) {
        void logStep(
          `OVERLAP: bands[${i}] bottom=${Math.ceil(a.bottom)} > bands[${i + 1}] top=${Math.floor(b.top)} (delta ${gap})`,
          { outer }
        );
      } else if (gap < minGapAlertPx) {
        void logStep(
          `TIGHT: bands[${i}]→[${i + 1}] gap=${gap}px (<${minGapAlertPx})`,
          { outer }
        );
      }
    }
  }
}


/**
 * Scan measure groups from the current OSMD SVG, union staves within the same measure,
 * and return unified per-measure rectangles relative to the wrapper host.
 * Runs AFTER pagination transform so boxes align with what you see.
 */
function scanMeasuresPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Array<{ id: string; rect: Rect }> {
  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "scanMeasuresPx";

  const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  try {
    const hostTop = outer.getBoundingClientRect().top;
    const hostLeft = outer.getBoundingClientRect().left;

    // Collect any group that looks like a measure; OSMD commonly emits ids with "measure"
    const MEASURE_SEL = "g[id*='measure' i], g[class*='measure' i]";
    const groups = Array.from(svgRoot.querySelectorAll<SVGGElement>(MEASURE_SEL));

    if (isDiagOn()) {
      logStep(`raw measure-like groups: ${groups.length}`, { outer });
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
      } catch { /* ignore bad nodes */ }
    }

    // Emit sorted by y then x for deterministic draw order
    const rows = Array.from(map.entries())
      .map(([id, rect]) => ({ id, rect }))
      .sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

    if (isLogOn()) {
      const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const dur = Math.round((t1 as number) - (t0 as number));
      logStep(`merged measures: ${rows.length} in ${dur}ms`, { outer });
    }
    if (isDiagOn()) {
      // Log a small, non-spammy sample: first 3 and last 3
      const sample = rows.length <= 6
        ? rows
        : [...rows.slice(0, 3), ...rows.slice(-3)];

      for (const { id, rect } of sample) {
        logStep(
          `id: ${id} @ x${Math.round(rect.x)} y${Math.round(rect.y)} w${Math.round(rect.w)} h${Math.round(rect.h)}`,
          { outer }
        );
      }
    }

    return rows;
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
  }
}

/** Draw/refresh a lightweight SVG overlay of measure rectangles (stroke-only),
 * snapping vertical bounds to per-system page separators so boxes tile cleanly.
 * STRICT TS SAFE (noUncheckedIndexedAccess compatible).
 */
function drawMeasureBoxes(
  outer: HTMLDivElement,
  svgRoot: SVGSVGElement,
  bands: Band[],
  startIndex: number,
  nextStartIndex: number,            // -1 on last page
  ySnap: number,
  topGutterPx: number,
  maskTopWithinMusicPx: number
): void {

  const prevFuncTag = outer.dataset.viewerFunc ?? "";
  outer.dataset.viewerFunc = "drawMeasureBoxes";
  let drawnCount = 0;

  // Remove any previous layer
  outer.querySelectorAll("[data-viewer-measureboxes='1']").forEach((n) => n.remove());

  // Quick guards
  if (!outer || !svgRoot || bands.length === 0) {
    logStep("boxes: 0 (early-guard bands/svg/outer)", { outer });
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
    return;
  }

  // 1) Scan raw measure rects in wrapper coords (already post-translate)
  const measures = scanMeasuresPx(outer, svgRoot);
  if (measures.length === 0) {
    logStep("boxes: 0 (no measures)", { outer });
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
    return;
  }

  // 2) Build page-local system separators: sep[0..N]
  const seps: number[] = [];
  const topG = Math.max(0, topGutterPx);
  seps.push(topG); // sep[0]

  // Clamp indices defensively
  const firstBand = Math.max(0, Math.min(startIndex | 0, Math.max(0, bands.length - 1)));
  const lastBandInclRaw = (nextStartIndex >= 0 ? nextStartIndex : bands.length) - 1;
  const lastBandIncl = Math.max(firstBand, Math.min(lastBandInclRaw, Math.max(0, bands.length - 1)));

  if (lastBandIncl > firstBand) {
    for (let i = firstBand; i < lastBandIncl; i++) {
      const bCurr = bands[i];
      const bNext = bands[i + 1];
      if (!bCurr || !bNext) { continue; }

      // Convert to page-local coords
      const bottomCurr = Math.round(bCurr.bottom) - Math.ceil(ySnap) + topG;
      const topNext = Math.round(bNext.top) - Math.ceil(ySnap) + topG;

      // Midpoint seam between systems i and i+1 (rounded to px)
      const seam = Math.round((bottomCurr + topNext) / 2);
      seps.push(seam);
    }
  }

  // Bottom limit (page-local)
  const bottomLimit = Math.max(0, Math.floor(topG + maskTopWithinMusicPx));
  seps.push(bottomLimit); // sep[last]

  // Ensure non-decreasing (monotone), strict-safe
  for (let i = 1; i < seps.length; i++) {
    const prev = seps[i - 1];
    const curr = seps[i];
    if (prev !== undefined && curr !== undefined && curr < prev) {
      seps[i] = prev;
    }
  }

  // Fallback: at least two separators
  if (seps.length < 2) {
    seps.length = 0;
    seps.push(topG, bottomLimit);
  }

  // Page window for THIS page (in page-local coords)
  const pageTop = seps[0] ?? topG;
  const pageBottom = seps[seps.length - 1] ?? bottomLimit;

  // 3) Build overlay SVG
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

  // Pre-scan and cache potential barline graphics once per page, in PAGE-LOCAL px.
  // This avoids mixing SVG user units with overlay CSS pixels.
  type BarCand = {
    el: SVGGraphicsElement;
    bb: { x: number; y: number; width: number; height: number }; // page-local px
    thin: boolean;
    yTop: number;  // page-local
    yBot: number;  // page-local
    hinted: boolean;
  };

  const allGraphics = Array.from(
    svgRoot.querySelectorAll<SVGGraphicsElement>("line, rect, path")
  );

  // Helper to map (x,y) in SVG user units → page-local px (outer’s 0,0)
  const outerRect = outer.getBoundingClientRect();
  const svgPoint = svgRoot.createSVGPoint();
  const toPageLocal = (el: SVGGraphicsElement, x: number, y: number) => {
    const m = el.getScreenCTM();
    if (!m) { return { x: 0, y: 0 }; }
    svgPoint.x = x;
    svgPoint.y = y;
    const scr = svgPoint.matrixTransform(m);
    return { x: scr.x - outerRect.left, y: scr.y - outerRect.top };
  };

  const BAR_CANDS: BarCand[] = [];
  for (const el of allGraphics) {
    let bbSvg: DOMRect | null = null;
    try { bbSvg = el.getBBox(); } catch { bbSvg = null; }
    if (!bbSvg) { continue; }

    // Convert bbox corners to page-local px
    const p1 = toPageLocal(el, bbSvg.x, bbSvg.y);
    const p2 = toPageLocal(el, bbSvg.x + bbSvg.width, bbSvg.y + bbSvg.height);

    const bb = {
      x: Math.min(p1.x, p2.x),
      y: Math.min(p1.y, p2.y),
      width: Math.abs(p2.x - p1.x),
      height: Math.abs(p2.y - p1.y),
    };

    // Class hints (optional)
    const cls = (el.getAttribute("class") || "").toLowerCase();
    const parentCls = (el.parentElement?.getAttribute("class") || "").toLowerCase();
    const hinted = cls.includes("stave") || cls.includes("bar")
      || parentCls.includes("stave") || parentCls.includes("bar");

    const thin = Math.round(bb.width) <= 4;

    BAR_CANDS.push({
      el,
      bb,
      thin,
      yTop: bb.y,
      yBot: bb.y + bb.height,
      hinted,
    });
  }

  // --- Per-tile barline extraction & interval cache ---
  type Interval = { left: number; right: number };

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
    const minOverallCoverageFrac = 0.65;
    type Span = { t: number; b: number };

    // Bucket candidates by integer X and retain their vertical spans
    const BUCKETS = new Map<number, Span[]>();
    const put = (x: number, t: number, b: number): void => {
      const xr = Math.round(x);
      if (xr < leftBoundPx) { return; }       // <<< NEW: ignore anything left of the music
      const arr = BUCKETS.get(xr);
      const s: Span = { t, b };
      if (arr) { arr.push(s); } else { BUCKETS.set(xr, [s]); }
    };

    // Scan graphics → keep verticals inside the corridor with realistic widths
    for (const c of BAR_CANDS) {
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

  // Cache of intervals per tile index + expected bar count
  const BAND_INTERVAL_CACHE = new Map<string, Interval[]>();

  function getMeasureIntervalsCached(
    tileIndex: number,
    yTop: number,
    yBot: number,
    expectedBars: number,
    leftBoundPx = -Infinity
  ): Interval[] {
    const key = `${tileIndex}:${expectedBars}:${Math.round(leftBoundPx)}`;
    const cached = BAND_INTERVAL_CACHE.get(key);
    if (cached) { return cached; }

    const xs = computeMeasureIntervals(yTop, yBot, expectedBars, leftBoundPx);
    const intervals: Interval[] = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const l = xs[i]!;
      const r = xs[i + 1]!;
      if (r > l) { intervals.push({ left: l, right: r }); }
    }

    BAND_INTERVAL_CACHE.set(key, intervals);
    return intervals;
  }
  // --- End per-tile barline helpers ---

  // --- Interval-gated per-measure recompute of vertical extents (page-local px) ---
  type MinMax = { top: number; bottom: number };

  /**
   * Recompute a measure's vertical extents using:
   *  - the SAME horizontal interval we draw with (plus ±eps)
   *  - AND the tile's vertical band [bandTop, bandBot]
   *
   * Policy:
   *  - INCLUDE horizontals (staff/ledger/pedal). They set the boundary only if there are no features.
   *  - Prefer "features" (anything not an almost-horizontal hairline) whenever present.
   *  - Clip Y to the system band to keep page-header/footer/brace junk out.
   */
  function computeMeasureVerticalExtents(
    svgRoot: SVGSVGElement,
    intervalLeft: number,
    intervalRight: number,
    eps: number,
    bandTop: number,
    bandBot: number,
    toPageLocal: (el: SVGGraphicsElement, x: number, y: number) => { x: number; y: number }
  ): MinMax | null {
    const leftGate = Math.min(intervalLeft, intervalRight) - Math.max(0, Math.floor(eps));
    const rightGate = Math.max(intervalLeft, intervalRight) + Math.max(0, Math.floor(eps));

    const y0Band = Math.min(bandTop, bandBot);
    const y1Band = Math.max(bandTop, bandBot);
    if (y1Band <= y0Band) { return null; }

    let globalTop: number | null = null;
    let globalBot: number | null = null;
    let featureTop: number | null = null;
    let featureBot: number | null = null;

    const nodes: NodeListOf<SVGGraphicsElement> = svgRoot.querySelectorAll<
      SVGGraphicsElement
    >("path, rect, line, polyline, polygon, text, use, circle, ellipse");

    for (const el of nodes) {
      let bbSvg: DOMRect;
      try { bbSvg = el.getBBox(); } catch { continue; }
      // Convert bbox to page-local px
      const p1 = toPageLocal(el, bbSvg.x, bbSvg.y);
      const p2 = toPageLocal(el, bbSvg.x + bbSvg.width, bbSvg.y + bbSvg.height);
      const x0 = Math.min(p1.x, p2.x);
      const x1 = Math.max(p1.x, p2.x);
      const y0 = Math.min(p1.y, p2.y);
      const y1 = Math.max(p1.y, p2.y);

      // Horizontal gate: require >= 1 px overlap with [leftGate, rightGate]
      if (x1 <= leftGate + 1 || x0 >= rightGate - 1) { continue; }

      // Vertical gate: require overlap with the tile's band; clip to the band
      const clipTop = Math.max(y0Band, y0);
      const clipBot = Math.min(y1Band, y1);
      if (clipBot <= clipTop) { continue; }

      // Accumulate global extremes (ALL shapes, including horizontals), using the clipped Y
      globalTop = globalTop === null ? clipTop : Math.min(globalTop, clipTop);
      globalBot = globalBot === null ? clipBot : Math.max(globalBot, clipBot);

      // "Horizontal hairline" narrowly defined: height ≤ 2 px AND width ≥ 20 px.
      // Anything else (including slightly slanted/vertical <line>) counts as a feature.
      const widthPx = x1 - x0;
      const heightPx = y1 - y0;
      let isHorizontalHairline = heightPx <= 2 && widthPx >= 20;

      if (el.tagName.toLowerCase() === "line") {
        const y1a = Number(el.getAttribute("y1"));
        const y2a = Number(el.getAttribute("y2"));
        if (Number.isFinite(y1a) && Number.isFinite(y2a)) {
          const dy = Math.abs(y1a - y2a);
          if (dy > 2) { isHorizontalHairline = false; } // stems / slanted beams / hooks
        }
      }

      if (!isHorizontalHairline) {
        featureTop = featureTop === null ? clipTop : Math.min(featureTop, clipTop);
        featureBot = featureBot === null ? clipBot : Math.max(featureBot, clipBot);
      }
    }

    if (globalTop === null || globalBot === null) { return null; }

    // No reliable feature box → use all-shapes union (includes hairlines like pedal lines).
    // (These should be non-null if we reached this branch; guard defensively.)
    return {
      top: globalTop ?? y0Band,
      bottom: globalBot ?? y1Band,
    };
  }
  // --- End interval-gated recompute helper ---


  // 4) Bucket measures by tile (system) and draw in left→right order per tile.
  //    This guarantees monotonic interval selection and prevents overlap.
  type BucketItem = { m: typeof measures[number]; k: number };

  // Build buckets keyed by tile index k
  const buckets = new Map<number, BucketItem[]>();

  for (const m of measures) {
    // 1) Page filter by vertical center in *page-local* coords (strict)
    const cy = Math.round(m.rect.y + m.rect.h / 2);
    if (cy < pageTop || cy >= pageBottom) { continue; }

    // 2) Robust tile pick by vertical overlap against seps (within this page)
    const rectTopPL = Math.round(m.rect.y);
    const rectBotPL = Math.round(m.rect.y + Math.max(1, Math.round(m.rect.h)));

    const lastIdx = seps.length - 2; // last valid tile
    let k = -1;
    let bestOv = 0;

    for (let t = 0; t <= lastIdx; t++) {
      const y0 = seps[t];
      const y1 = seps[t + 1];
      if (y0 === undefined || y1 === undefined) { continue; }
      const ov = Math.max(0, Math.min(rectBotPL, y1) - Math.max(rectTopPL, y0));
      if (ov > bestOv) { bestOv = ov; k = t; }
    }
    if (k < 0 || bestOv === 0) { continue; }

    const arr = buckets.get(k);
    const item: BucketItem = { m, k };
    if (arr) { arr.push(item); } else { buckets.set(k, [item]); }
  }

  // Now iterate tiles in order
  const lastTileIndex = seps.length - 2;
  for (let k = 0; k <= lastTileIndex; k++) {
    const items = buckets.get(k);
    if (!items || items.length === 0) { continue; }

    // Sort by OSMD measure id number (stable)
    items.sort((a, b) => {
      const an = (a.m.id.match(/measure[-_\s]?(\d+)/i)?.[1]);
      const bn = (b.m.id.match(/measure[-_\s]?(\d+)/i)?.[1]);
      const ai = an ? Number(an) : Number.POSITIVE_INFINITY;
      const bi = bn ? Number(bn) : Number.POSITIVE_INFINITY;
      if (ai !== bi) { return ai - bi; }
      return a.m.rect.x - b.m.rect.x;
    });

    // ---- Draw window (from seams) -> contiguous full-height boxes
    const drawTop = seps[k]!;
    const drawBot = seps[k + 1]!;

    // ---- Detect window (from measures, clamped to seams) -> robust bar detection
    const mTop = Math.min(...items.map(it => Math.round(it.m.rect.y)));
    const mBot = Math.max(...items.map(it => Math.round(it.m.rect.y + Math.max(1, Math.round(it.m.rect.h)))));
    const detectTop = Math.max(drawTop, mTop);
    const detectBot = Math.min(drawBot, mBot);

    // Build intervals from detected barlines (detection uses detectTop/Bottom)
    const expectedBars = items.length + 1;

    // left bound = left edge of the music for this tile (a tiny tolerance is OK)
    const musicLeft = Math.min(...items.map(it => Math.round(it.m.rect.x)));
    const LEFT_TOL = 2;
    const leftBoundPx = musicLeft - LEFT_TOL;

    let tileIntervals = getMeasureIntervalsCached(k, detectTop, detectBot, expectedBars, leftBoundPx);

    // Clamp intervals to the measures' horizontal span,
    // but don't reject a true first interval just because its left barline
    // is a few px left of tileMinX. Instead, keep a right-edge guard
    // and discard only tiny pre-measure slivers by width.
    const tileMaxX = Math.max(...items.map(it => Math.round(it.m.rect.x + Math.round(it.m.rect.w))));
    const XTOL = 2;
    const MIN_MEASURE_W = 8; // px, small but kills connector→bar slivers

    tileIntervals = tileIntervals
      .filter(iv => iv.right <= tileMaxX + XTOL)                 // keep inside music on the right
      .filter(iv => (iv.right - iv.left) >= MIN_MEASURE_W);      // drop ultra-thin pre-measure shards

    const N = Math.min(items.length, tileIntervals.length);

    // --- Final brace/connector exclusion ---
    if (Array.isArray(tileIntervals) && tileIntervals.length > 0 && N > 0) {
      const t0 = tileIntervals;
      const firstLeft = t0[0]!.left;
      tileIntervals = t0.map(iv => ({
        left: Math.max(iv.left, firstLeft),
        right: iv.right
      }));
    }
    if (N === 0) { continue; }

    // --- NEW: interval-gated recompute for each measure BEFORE drawing ---
    // This is where the boxes are computed to fit the actual contents of the measure top to bottom
    const EPS = 6; // px, slightly larger to capture diagonals near barlines
    const bandTop = seps[k]!;
    const bandBot = seps[k + 1]!;

    for (let i = 0; i < N; i++) {
      const { m } = items[i]!;
      const chosen = tileIntervals[i]!;
      const mm = computeMeasureVerticalExtents(
        svgRoot,
        chosen.left,
        chosen.right,
        EPS,
        bandTop,
        bandBot,
        toPageLocal
      );
      if (mm) {
        (m as { annotTopPx?: number }).annotTopPx = mm.top;
        (m as { annotBotPx?: number }).annotBotPx = mm.bottom;
      }
    }

    // Draw rectangles using per-measure verticals (clamped to tile seams)
    const BASE_PAD = REFLOW.MEASURE_PAD_PX_BASE;  // inside-band padding cap per edge

    for (let i = 0; i < N; i++) {
      const { m } = items[i]!;
      const chosen = tileIntervals[i]!;

      // Horizontal (barline-derived)
      const l = Math.round(chosen.left) + 0.5;
      const rEdge = Math.round(chosen.right) + 0.5;
      const x = Math.min(l, rEdge);
      const w = Math.max(1, Math.round(Math.abs(rEdge - l)) - 1);

      // Clamp band for this tile
      const bandTop = seps[k]!;
      const bandBot = seps[k + 1]!;
      // Try pre-existing measure fields first
      let mt: number | undefined = (m as { annotTopPx?: number }).annotTopPx;
      let mb: number | undefined = (m as { annotBotPx?: number }).annotBotPx;

      // If missing/invalid, compute once directly (no intra-call cache)
      if (!Number.isFinite(mt) || !Number.isFinite(mb) || (mb as number) <= (mt as number)) {
        const ivLeft = Math.min(l, rEdge);
        const ivRight = Math.max(l, rEdge);

        let tMin = Number.POSITIVE_INFINITY;
        let bMax = Number.NEGATIVE_INFINITY;

        for (const el of allGraphics) {
          let bbSvg: DOMRect | null = null;
          try { bbSvg = el.getBBox(); } catch { bbSvg = null; }
          if (!bbSvg) { continue; }

          const p1 = toPageLocal(el, bbSvg.x, bbSvg.y);
          const p2 = toPageLocal(el, bbSvg.x + bbSvg.width, bbSvg.y + bbSvg.height);

          const bbx = Math.min(p1.x, p2.x);
          const bby = Math.min(p1.y, p2.y);
          const bbw = Math.abs(p2.x - p1.x);
          const bbh = Math.abs(p2.y - p1.y);

          // Horizontal gate: require any overlap with [ivLeft, ivRight]
          const ovX = Math.min(bbx + bbw, ivRight) - Math.max(bbx, ivLeft);
          if (ovX <= 0) { continue; }

          // Include ALL glyphs so pedal lines count
          const top = bby;
          const bot = bby + bbh;

          if (top < tMin) { tMin = top; }
          if (bot > bMax) { bMax = bot; }
        }

        if (Number.isFinite(tMin) && Number.isFinite(bMax) && bMax > tMin) {
          mt = Math.max(bandTop, Math.round(tMin));
          mb = Math.min(bandBot, Math.round(bMax));

          // persist on the measure so re-uses in this invocation don’t recompute
          (m as { annotTopPx?: number }).annotTopPx = mt;
          (m as { annotBotPx?: number }).annotBotPx = mb;
        }
      }

      // Guard invalid/missing extents
      if (!Number.isFinite(mt) || !Number.isFinite(mb) || (mb as number) <= (mt as number)) {
        logStep(`annot-skip: ${m.id} (missing/invalid union)`, { outer });
        continue;
      }

      // Apply inner padding per edge, capped by available headroom to band edges
      const mtNum = mt as number;
      const mbNum = mb as number;

      // how much room we actually have inside the band
      const availTop = Math.max(0, mtNum - bandTop);
      const availBot = Math.max(0, bandBot - mbNum);

      // per-edge pads: never exceed headroom or our base knob
      const padTop = Math.min(BASE_PAD, availTop);
      const padBot = Math.min(BASE_PAD, availBot);

      const top = Math.max(bandTop, Math.round(mtNum - padTop));
      const bot = Math.min(bandBot, Math.round(mbNum + padBot));

      // Pixel-perfect y/h
      const y = Math.round(Math.min(top, bot)) + 0.5;
      const h = Math.max(1, Math.round(Math.abs(bot - top)) - 1);

      if (isDiagOn() && i === 0) {
        logStep(
          `m=${m.id} mt=${Math.round(mt as number)} mb=${Math.round(mb as number)} ` +
          `bandTop=${Math.round(bandTop)} bandBot=${Math.round(bandBot)} ` +
          `y=${Math.round(y)} h=${h}`,
          { outer }
        );
      }

      // SVG draw
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

      drawnCount++;
    }
  }

  // append the overlay once (after all tiles are drawn)
  outer.appendChild(layer);

  logStep(`boxes: ${drawnCount} tiles: ${Math.max(0, seps.length - 1)}`, { outer });
  try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
}


/** Remove the measure overlay layer if present. */
function clearMeasureBoxes(outer: HTMLDivElement): void {
  outer.querySelectorAll("[data-viewer-measureboxes='1']").forEach(n => n.remove());
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
      void logStep("starts: 1 (fallback [0])", { outer });
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

    void logStep(`starts: ${starts.length} pageHeightUsable: ${pageHeightUsable}`, { outer });
    return starts.length ? starts : [0];
  } finally {
    try { outer.dataset.viewerFunc = prevFuncTag; } catch { /* no-op */ }
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


/* ---------- Component ---------- */

export default function ScoreViewer({
  src,
  fillParent = true,
  height = 600,
  className = "",
  style,
  topGutterPx = 12,
  bottomGutterPx = topGutterPx,
  debugShowAllMeasureNumbers = false,
}: Props) {

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
  const reflowRunningRef = useRef(false);   // guards width reflow
  const reflowAgainRef = useRef<"none" | "width" | "height">("none");
  const reflowQueuedCauseRef = useRef<string>("");   // ← remember why a reflow was queued
  const repaginationRunningRef = useRef(false);    // guards height-only repagination

  // Track browser zoom relative to mount
  const baseScaleRef = useRef<number>(1);
  const zoomFactorRef = useRef<number>(1);

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
      const rawLayoutW = Math.max(1, Math.floor(hostW / zf));

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

        await logStep(`layoutW: ${layoutW} hostW: ${hostW} zf: ${zf.toFixed(3)}`, { outer });

        // Timed core render (isolates synchronous OSMD work)
        perfBlock(
          nextPerfUID(outer.dataset.viewerRun),
          () => { osmd.render(); },
          (ms) => { void logStep(`osmd.render() runtime: ${ms}ms`, { outer }); }
        );
      } catch (e) {
        void logStep(`render:error ${(e as Error)?.message ?? e}`, { outer });
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


  // Apply the chosen page to the viewport: translate the SVG to its start and mask/cut to hide any next-page peek.
  // May recompute page starts and re-apply to preserve whole systems; bounded recursion prevents oscillation.
  const applyPage = useCallback(
    (pageIdx: number): void => {
      const outer = wrapRef.current;
      if (!outer) { return; }

      function bottomPeekPadPx(): number {
        return window.devicePixelRatio >= 2
          ? REFLOW.BOTTOM_PEEK_PAD_HI_DPR
          : REFLOW.BOTTOM_PEEK_PAD_LO_DPR;
      }

      /** Visible height that the music can actually occupy on a page, after gutters/peek pad. */
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
      logStep("called by: " + prevFuncTag, { outer });

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

        if (isLogOn()) {
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

        if (isDiagOn()) {
          const lastForLog = nextStartIndex >= 0 ? (nextStartIndex - 1) : (bands.length - 1);
          void logStep(
            `pages: ${p + 1}/${pages} startIndex: ${startIndex} lastForLog: ${lastForLog} ` +
            `nextStartIndex: ${nextStartIndex >= 0 ? `${nextStartIndex}` : "end"} ` +
            `ySnap: ${ySnap} PAGE_H_USABLE: ${PAGE_H_USABLE} maskTopWithinMusicPx: ${maskTopWithinMusicPx} needsMask: ${needsMask}`,
            { outer }
          );
          const first = startIndex;
          const last = lastForLog;     // use the same name you already use above
          const list = Array.from({ length: last - first + 1 }, (_, j) => first + j).join(",");
          logStep(`pageBands: [${list}]`, { outer });
        }

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

        // --- Measure rectangles smoke-test overlay ---
        // Always redraw after pagination transform so outlines match what you see.
        try {
          clearMeasureBoxes(outer);
          drawMeasureBoxes(
            outer,
            svgNN,                   // non-nullable alias
            bandsNN,                 // non-nullable alias
            startIndex,              // this page's first system index
            nextStartIndex,          // -1 if last page
            ySnap,                   // ceil(top of start band)
            Math.max(0, topGutterPx),
            maskTopWithinMusicPx     // page-local bottom cut for this page
          );
        } catch { /* overlay render is best-effort; ignore failures */ }

        // Stop layer promotion after page is applied
        svg.style.willChange = "auto";
      } finally {
        try { outer.dataset.viewerFunc = prevFuncTag; } catch { /* no-op */ }
      }
    },
    [visiblePageHeight, topGutterPx, bottomGutterPx]
  );

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
      try { void host.getBoundingClientRect().width; } catch { /* layout flush */ }
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


  /** layoutViewer
   * Full layout pipeline:
   *   renderViewer()  → scanSystemsPx() → computePageStarts() → applyPage(0)
   * Optionally double-applies page 1 to settle masking; bounded by a paint gate.
   * Returns {bands, starts} for callers to stash.
   */
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
    await logStep("phase starting", { outer });

    try {
      const ap = makeAfterPaint(outer);

      await withHostHidden(outer, async () => {
        // Clear any stale overlays before a fresh render
        try { clearMeasureBoxes(outer); } catch { }

        const uid = nextPerfUID(outer.dataset.viewerRun);
        await perfBlockAsync(
          uid,
          async () => { await renderViewer(outer, osmd); },
          (ms) => { void logStep(`osmd.render() runtime: ${ms}ms`, { outer }); }
        );
      });

      await new Promise<void>((r) => setTimeout(r, 0)); // yield one task

      await logStep("phase finished", { outer });
      outer.dataset.viewerPhase = "scan";
      await logStep("phase starting", { outer });

      const svgForPack = getSvg(outer);
      if (!svgForPack) {
        outer.dataset.viewerFatal = "no-svg";
        outer.dataset.viewerErr = "OSMD did not produce an <svg> element.";
        throw new Error("No SVG produced by OSMD render");
      }

      const preBands = withSvgAtUnitScale(outer, (svg) => scanSystemsPx(outer, svg)) ?? [];
      await logStep(`bands: ${preBands.length}`, { outer });

      // Scan (raw) then derive padded bands capped by the gutters
      const rawBands = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => withSvgAtUnitScale(outer, (svg) => scanSystemsPx(outer, svg)) ?? [],
        (ms) => { void logStep(`scanSystemsPx() runtime: ${ms}ms`, { outer }); }
      );

      const bands = derivePaddedBands(
        rawBands,
        Math.max(0, topGutterPx),
        Math.max(0, bottomGutterPx)
      );

      validateBandSpacing(outer, bands, { minGapAlertPx: 2 });

      const mergeThresh = dynamicBandGapPx();
      await logStep(
        `bands: ${bands.length} mergeThresh=${mergeThresh} (no packGap; packer disabled)`,
        { outer }
      );

      const visH = visiblePageHeight(outer);
      const starts = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => computePageStarts(outer, bands, visH, Math.max(0, topGutterPx), Math.max(0, bottomGutterPx)),
        (ms) => {
          void logStep(`computePageStarts() runtime: ${ms}ms visH: ${visH} topGutterPx: ${topGutterPx} bottomGutterPx: ${bottomGutterPx}`, { outer }
          );
        }
      );

      try {
        await logStep(
          `bands: ${bands.length} visibleH: ${visiblePageHeight(outer)} paginationH: ${paginationHeight(outer)}`,
          { outer }
        );

        if (isDiagOn()) {
          // Compact page map (page -> band range)
          {
            const lastBand = bands.length - 1;
            const parts: string[] = [];
            for (let p = 0; p < starts.length; p++) {
              const s = starts[p]!;
              const e = ((p + 1 < starts.length ? starts[p + 1]! : lastBand + 1) - 1);
              parts.push(`[p${p + 1} ${s}–${e}]`);
            }
            await logStep(`pages: ${starts.length} map: ${parts.join(" ")}`, { outer });
          }

          // Verbose per-band rows (kept under the same flag)
          {
            const rows = bands.map((b, i) =>
              `#${i} top=${Math.round(b.top)} bottom=${Math.round(b.bottom)} h=${Math.round(b.height)}`
            );
            for (let k = 0; k < rows.length; k += 10) {
              await logStep(
                `bandRows ${k}-${Math.min(k + 9, rows.length - 1)}: ${rows.slice(k, k + 10).join(" | ")}`,
                { outer }
              );
            }
          }

          // Elements-pane breadcrumbs (keep under the flag per your preference)
          outer.dataset.viewerBandsDump = JSON.stringify(
            bands.map((b, i) => ({
              i,
              top: Math.round(b.top),
              bottom: Math.round(b.bottom),
              height: Math.round(b.height),
            }))
          );
          outer.dataset.viewerStartsDump = JSON.stringify(starts);
        }
      } catch { }

      await logStep("phase finished", { outer });
      outer.dataset.viewerPhase = "apply";
      await logStep("phase starting", { outer });

      pageStartIdxsRef.current = starts;
      systemBandsRef.current = bands;
      pageIdxRef.current = 0;

      await perfBlockAsync(
        nextPerfUID(outer.dataset.viewerRun),
        async () => {
          applyPage(0);
          await Promise.race([ap(gateLabel, gateMs), new Promise<void>((r) => setTimeout(r, gateMs))]);
          if (doubleApply) { applyPage(0); }
        },
        (ms) => { void logStep(`applyPage() runtime: ${ms}ms`, { outer }); }
      );

      await logStep(`bands: ${bands.length} pages: ${starts.length}`, { outer });

      return { bands, starts };

    } finally {
      try { outer.dataset.viewerFunc = prevFuncTag; } catch { }
    }
  }, [nextPerfUID, renderViewer, withHostHidden, paginationHeight, applyPage, visiblePageHeight, topGutterPx, bottomGutterPx]);


  // --- HEIGHT-ONLY REPAGINATION (no OSMD re-init) ---
  const paginateViewer = useCallback((): void => {
    const outer = wrapRef.current;
    if (!outer) { return; }

    // Remove stale boxes; applyPage() will redraw them for the new page window
    try { clearMeasureBoxes(outer); } catch { }

    // Prevent overlap
    if (repaginationRunningRef.current) { return; }
    repaginationRunningRef.current = true;

    const prevFuncTag = outer.dataset.viewerFunc ?? "";
    outer.dataset.viewerFunc = "paginateViewer";
    logStep("called by: " + prevFuncTag, { outer });

    try {
      outer.dataset.viewerRecompute = String(Date.now());

      const bands = systemBandsRef.current;
      if (bands.length === 0) {
        void logStep("repag: bands=0 — exit", { outer });
        return;
      }

      const visH = visiblePageHeight(outer);

      // Always-on, high-signal line
      void logStep(`repag: bands=${bands.length} visibleH=${visH}`, { outer });

      const starts = perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => computePageStarts(outer, bands, visH, Math.max(0, topGutterPx), Math.max(0, bottomGutterPx)),
        (ms) => {
          void logStep(`computePageStarts() runtime: ${ms}ms visH: ${visH} topGutterPx: ${topGutterPx} bottomGutterPx: ${bottomGutterPx}`, { outer }
          );
        }
      );

      pageStartIdxsRef.current = starts;
      outer.dataset.viewerPages = String(starts.length);

      // Optional diagnostics: compact page map
      if (isDiagOn()) {
        const lastBand = bands.length - 1;
        const parts: string[] = [];
        for (let p = 0; p < starts.length; p++) {
          const s = starts[p]!;
          const e = ((p + 1 < starts.length ? starts[p + 1]! : lastBand + 1) - 1);
          parts.push(`[p${p + 1} ${s}–${e}]`);
        }
        void logStep(`repag map: pages=${starts.length} ${parts.join(" ")}`, { outer });
      }

      // Always reset to page 1 after repagination
      perfBlock(
        nextPerfUID(outer.dataset.viewerRun),
        () => { applyPage(0); },
        (ms) => { void logStep(`applyPage runtime: ${ms}ms`, { outer }); }
      );

    } catch (e) {
      // Visible breadcrumb + best-effort fallback so the UI doesn't look stuck
      const msg = (e as Error)?.message ?? String(e);
      outer.dataset.viewerErr = msg.slice(0, 180);
      void logStep(`repag:error ${msg}`, { outer });

      if (!pageStartIdxsRef.current?.length) {
        pageStartIdxsRef.current = [0];
      }
      try { applyPage(0); } catch { /* swallow */ }

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


  /** reflowViewer
   * Heavy path for when effective layout width changes (width/zoom/DPR etc.).
   * Shows spinner, bumps run#, calls layoutViewer(), drains any queued work.
   * Concurrency-safe via reflowRunningRef; may queue a follow-up if invoked again mid-run.
   */
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
      await logStep("phase starting", { outer });

      let started = false;

      try {
        if (!osmd) {
          void logStep("early-bail outer=1 osmd=0", { outer });
          return;
        }

        if (reflowRunningRef.current) {
          reflowAgainRef.current = "width";
          const run = Number(outer.dataset.viewerRun || "0");
          outer.dataset.viewerReflowQueued = String(run);
          outer.dataset.viewerReflowQueueWhy = "reflowRunning";
          outer.dataset.viewerReflowQueuedAt = String(Date.now());
          void logStep("reflow already in progress; queued follow-up", { outer });
          return;
        }

        started = true;

        reflowRunningRef.current = true;

        const run = (Number(outer.dataset.viewerRun || "0") + 1);
        outer.dataset.viewerRun = String(run);

        const pages = Math.max(1, pageStartIdxsRef.current.length);
        const page = Math.max(1, Math.min(pageIdxRef.current + 1, pages));
        void logStep(`run: ${run} page: ${page}/${pages}`, { outer });

        const currW = outer.clientWidth;
        const currH = outer.clientHeight;
        handledWRef.current = currW; // prime "handled" now, not only at the end
        handledHRef.current = currH;

        try {
          outer.dataset.viewerReflowTargetW = String(currW);
          outer.dataset.viewerReflowTargetH = String(currH);
        } catch { }

        await startSpinner({ message: DEFAULT_BUSY_MSG, gatePaint: true });
        await logStep("spinner started", { outer });

        const { bands, starts } = await layoutViewer(outer, osmd, {
          gateLabel: "reflowViewer",
          gateMs: 400,
          doubleApply: true
        });
        outer.dataset.viewerBands = String(bands.length);
        outer.dataset.viewerPages = String(starts.length);

        await logStep("phase finished", { outer });

      } finally {
        if (started) {
          try { outer.dataset.viewerPhase = "finally"; } catch { }
          await logStep("phase starting", { outer });

          // we finished a run; drop the guard before hiding spinner
          reflowRunningRef.current = false;

          // spinner end + small paint gate
          await stopSpinner();
          await logStep("spinner stopped", { outer });

          // clear breadcrumbs
          outer.dataset.viewerReflowTargetW = "";
          outer.dataset.viewerReflowTargetH = "";

          // drain any queued work
          const queued = reflowAgainRef.current;
          const cause = reflowQueuedCauseRef.current || "drain:finally";
          reflowAgainRef.current = "none";
          reflowQueuedCauseRef.current = "";

          if (queued === "width") {
            await logStep(`draining queued width reflow (cause=${cause})`, { outer });
            setTimeout(() => { reflowFnRef.current(); }, 0);
          } else if (queued === "height") {
            await logStep(`draining queued height repagination (cause=${cause})`, { outer });
            setTimeout(() => { repagFnRef.current(); }, 0);
          }

          await logStep("phase finished", { outer });
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

        // Queue only; let our normal drain paths run it when safe
        reflowAgainRef.current = "width";
        reflowQueuedCauseRef.current = `zoom:${why}`;

        if (reflowRunningRef.current || repaginationRunningRef.current || busyRef.current) {
          void logStep("queued width reflow (guard busy)");
          return;
        }

        // If we're idle, drain the queue ourselves on the next tick
        window.setTimeout(() => {
          if (
            reflowAgainRef.current === "width" &&
            !reflowRunningRef.current &&
            !repaginationRunningRef.current &&
            !busyRef.current
          ) {
            reflowAgainRef.current = "none";
            reflowFnRef.current();
          }
        }, 0);
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

  /** initViewer
   * One-time boot for the component:
   * - feature checks, dynamic import of OSMD
   * - load MusicXML (MXL/URL), wait for fonts
   * - first layout via layoutViewer, then height-only repagination
   * - marks ready & clears the spinner
   */
  useEffect(function initViewer() {
    (async () => {
      const host = svgHostRef.current;
      const outer = wrapRef.current;
      if (!host || !outer) { return; }

      const prevFuncTag = outer.dataset.viewerFunc ?? "";
      outer.dataset.viewerFunc = "initViewer";
      outer.dataset.viewerPhase = "prep";
      await logStep("phase starting", { outer });

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

          await logStep(`hasVV: ${hasVV ? "yes" : "no"} hasRO: ${hasRO ? "yes" : "no"}`, { outer });

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

            await logStep("fatal: visualViewport unavailable — aborting init", { outer });
            return; // stop init right here
          }
          if (isStale()) { return; }

        } catch { }

        // --- Dynamic import OSMD ---
        const mod = await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => await import("opensheetmusicdisplay"),
          (ms) => { void logStep(`import("opensheetmusicdisplay") runtime: ${ms}ms`, { outer }); }
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
          // Dev aid: render numbers each measure if requested to verify continuity
          drawMeasureNumbers: true,
          measureNumberInterval: debugShowAllMeasureNumbers ? 1 : undefined,
        }) as OpenSheetMusicDisplay;
        osmdRef.current = osmd;

        await startSpinner({ message: DEFAULT_BUSY_MSG, gatePaint: true });
        await logStep("spinner started", { outer });

        await logStep("phase finished", { outer });
        outer.dataset.viewerPhase = "load";
        await logStep("phase starting", { outer });

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
              void logStep(`fetch() + arrayBuffer() runtime: ${ms}ms bytes: ${bytes}`, { outer });
            }
          );

          const uzMod = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(import("unzipit"), 4000, "unzipit timeout"),
            (ms) => { void logStep(`import("unzipit") runtime: ${ms}ms`, { outer }); }
          );
          const { unzip } = uzMod as typeof import("unzipit");

          const { entries } = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(unzip(ab), 8000, "unzip timeout"),
            (ms) => { void logStep(`unzip() runtime: ${ms}ms`, { outer }); }
          );

          const container = entries["META-INF/container.xml"];
          if (!container) {
            await logStep("container.xml missing → abort", { outer });
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
              void logStep(`container.text() runtime: ${ms}ms chars: ${chars}`, { outer });
            }
          );

          const cdoc = perfBlock(
            nextPerfUID(outer.dataset.viewerRun),
            () => new DOMParser().parseFromString(containerXml, "application/xml"),
            (ms) => { void logStep(`DOMParser().parseFromString() runtime: ${ms}ms`, { outer }); }
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
            await logStep("container rootfile path missing → abort", { outer });
            throw new Error("MXL error: container.xml lacks a rootfile path");
          }

          if (!entries[fullPath]) {
            await logStep(`container rootfile not in ZIP (${fullPath}) → abort`, { outer });
            throw new Error(`MXL error: rootfile entry not found in archive: ${fullPath}`);
          }

          const entry = entries[fullPath]!;
          const xmlText = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => await withTimeout(entry.text(), 10000, "entry.text() timeout"),
            (ms) => { void logStep(`entry.text() runtime: ${ms}ms`, { outer }); }
          );
          outer.dataset.viewerZipChosen = fullPath;
          outer.dataset.viewerZipChars = String(xmlText.length);

          const xmlDoc = await perfBlockAsync(
            nextPerfUID(outer.dataset.viewerRun),
            async () => new DOMParser().parseFromString(xmlText, "application/xml"),
            (ms) => { void logStep(`DOMParser().parseFromString runtime: ${ms}ms`, { outer }); }
          );

          if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
            throw new Error("xmlDoc.getElementsByTagName parsererror");
          }
          const hasPartwise = xmlDoc.getElementsByTagName("score-partwise").length > 0;
          const hasTimewise = xmlDoc.getElementsByTagName("score-timewise").length > 0;
          await logStep(`xmlDoc.getElementsByTagName() hasPartwise: ${String(hasPartwise)} hasTimewise: ${String(hasTimewise)}`, { outer });
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
            await logStep(`XMLSerializer().serializeToString runtime: ${serializeMs}ms chars: ${serialized.length}`, { outer });
            loadInput = serialized;
          }
        } else {
          // Non-API source: pass `src` straight to OSMD.load(...)
          // - If `src` is a URL/path to a plain MusicXML file (e.g. "/scores/foo.musicxml" or "https://…"),
          //   OSMD.load(...) will fetch it internally.
          // - If `src` is already a MusicXML XML string, OSMD.load(...) will parse it directly.
          // - (We only take the manual fetch + unzip path for "/api/*" endpoints that return MXL/ZIP content.)
          // In other words: non-API = plain MusicXML, so no special handling here.
          loadInput = src;
        }

        await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => {
            await loadOSMD(osmd, loadInput);
          },
          (ms) => {
            void logStep(`loadOSMD() runtime: ${ms}ms`, { outer });
          }
        );

        await perfBlockAsync(
          nextPerfUID(outer.dataset.viewerRun),
          async () => { await waitForFonts(); },
          (ms) => { void logStep(`waitForFonts() runtime: ${ms}ms`, { outer }); }
        );

        await logStep("phase finished", { outer });

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
        await logStep("spinner stopped", { outer });

      } finally {
        try { outer.dataset.viewerPhase = "finally"; } catch { }
        await logStep("phase starting", { outer });

        await logStep("phase finished", { outer });

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
  }, [src, debugShowAllMeasureNumbers]);


  /** Paging helpers */

  // Core page-turn handler (goNext/goPrev). On rare layout shifts, retries next frame.
  const turnPage = useCallback(
    (dir: 1 | -1) => {
      if (busyRef.current) { return; }

      const starts = pageStartIdxsRef.current;
      const pages = starts.length;
      if (!pages) { return; }

      const beforePage = pageIdxRef.current;

      // Wrap-around paging:
      // - last page + forward → page 1
      // - first page + backward → last page
      let targetPage: number;
      if (dir === 1 && beforePage === pages - 1) {
        targetPage = 0;
      } else if (dir === -1 && beforePage === 0) {
        targetPage = pages - 1;
      } else {
        targetPage = Math.max(0, Math.min(beforePage + dir, pages - 1));
      }

      if (targetPage === beforePage) { return; }

      // The start index we want to land on after any recompute
      const desiredStart = starts[targetPage] ?? starts[beforePage] ?? 0;

      const outer = wrapRef.current;
      const prevTag = outer?.dataset.viewerFunc ?? "";
      if (outer) { outer.dataset.viewerFunc = "turnPage"; }
      try {
        applyPage(targetPage);
      } finally {
        if (outer) { outer.dataset.viewerFunc = prevTag; }
      }


      // If we didn't actually move, rebuild page starts and retry *toward* desiredStart.
      window.requestAnimationFrame(() => {
        if (pageIdxRef.current !== beforePage) { return; } // we moved – all good

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

        // pick first start >= desiredStart (forward) or last start <= desiredStart (backward)
        let idx: number;
        if (dir === 1) {
          idx = fresh.findIndex((s) => s >= desiredStart);
          if (idx < 0) { idx = fresh.length - 1; }
        } else {
          let firstGreater = fresh.findIndex((s) => s > desiredStart);
          if (firstGreater < 0) { firstGreater = fresh.length; }
          idx = Math.max(0, firstGreater - 1);
        }

        //if (idx !== beforePage) { applyPage(idx); }
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

  const goNext = useCallback(() => turnPage(1), [turnPage]);
  const goPrev = useCallback(() => turnPage(-1), [turnPage]);

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
        goNext();
      } else {
        goPrev();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current || busyRef.current) {
        return;
      }
      if (["PageDown", "ArrowDown", " "].includes(e.key)) {
        e.preventDefault();
        goNext();
      } else if (["PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        goPrev();
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

  // Touch swipe paging (disabled while busy)
  useEffect(() => {
    const outer = wrapRef.current;
    if (!outer) { return; }

    let startY = 0;
    let startX = 0;
    let startT = 0; // ← add
    let active = false;

    // Tunables for what counts as a "tap"
    const TAP_MAX_MS = 250;       // quick touch
    const TAP_MAX_MOVE_PX = 12;   // little to no movement

    const onTouchStart = (e: TouchEvent) => {
      if (!readyRef.current || busyRef.current || e.touches.length === 0) {
        return;
      }
      active = true;
      startY = e.touches[0]?.clientY ?? 0;
      startX = e.touches[0]?.clientX ?? 0;
      startT = performance.now();          // ← add
    };


    const onTouchMove = (e: TouchEvent) => {
      if (!active || !readyRef.current || busyRef.current) {
        return;
      }
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!active) {
        return;
      }
      active = false;
      if (busyRef.current) {
        return;
      }
      const t = e.changedTouches[0];
      if (!t) { return; }

      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      const dt = performance.now() - startT;  // ← add

      // 1) Tap-to-advance (quick + tiny movement)
      if (Math.abs(dx) <= TAP_MAX_MOVE_PX && Math.abs(dy) <= TAP_MAX_MOVE_PX && dt <= TAP_MAX_MS) {
        goNext();
        return;
      }

      // 2) Your existing swipe logic
      const THRESH = 40;
      const H_RATIO = 0.6;
      if (Math.abs(dy) >= THRESH && Math.abs(dx) <= Math.abs(dy) * H_RATIO) {
        if (dy < 0) {
          goNext();
        } else {
          goPrev();
        }
      }
    };

    outer.addEventListener("touchstart", onTouchStart, { passive: true });
    outer.addEventListener("touchmove", onTouchMove, { passive: false });
    outer.addEventListener("touchend", onTouchEnd, { passive: true });

    outer.style.overscrollBehavior = "contain";

    const cleanupOuter = outer;
    return () => {
      cleanupOuter.removeEventListener("touchstart", onTouchStart);
      cleanupOuter.removeEventListener("touchmove", onTouchMove);
      cleanupOuter.removeEventListener("touchend", onTouchEnd);
    };
  }, [goNext, goPrev]);

  // Mouse single-click paging (disabled while busy)
  // NOTE: ignores double-click so we can reserve it for future edit mode
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
        goNext();
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

  /* ---------- Styles ---------- */

  const isFill = fillParent;
  const outerStyle: React.CSSProperties = isFill
    ? {
      width: "100%",
      height: vpHRef.current > 0 ? vpHRef.current : "100vh", // ← was "100%"
      minHeight: 320,                                        // ← was 0
      position: "relative",
      overflow: "hidden",
      background: "#fff",
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2px)",
      boxSizing: "border-box",
      isolation: "isolate",
    }
    : {
      width: "100%",
      height: height ?? 600,
      minHeight: height ?? 600,
      position: "relative",
      overflow: "hidden",
      background: "#fff",
      paddingBottom: "2px",
      boxSizing: "border-box",
      isolation: "isolate",
    };

  const hostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    minWidth: 0,
  };

  /* ---------- Busy overlay ---------- */
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
      data-viewer-wrapper="1"
      data-viewer-probe="v10-pre"
      className={className}
      style={{ /* outline: "4px solid fuchsia", */ ...outerStyle, ...style }}
    >
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

      <style>{`@keyframes viewer-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
