"use client";

import { MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExtInfo, TmNode } from "../_lib/api";
import {
  categoryColor,
  CATEGORY_NAMES,
  extColor,
  extLabel,
  extTypeName,
  formatBytes,
  formatPercent,
} from "../_lib/format";

interface LRect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: TmNode;
  parent: number;
}

interface Props {
  data: TmNode | null;
  rootPath: string;
  exts: ExtInfo[];
  selectedId: number | null;
  highlightExt: number | null;
  highlightCategory?: number | null;
  onSelect: (id: number) => void;
  onZoom: (id: number) => void;
  onContextMenu: (id: number, isDir: boolean, e: MouseEvent) => void;
}

/** Squarified treemap layout (Bruls et al.) of `items` into the given box. */
function squarify(items: TmNode[], x: number, y: number, w: number, h: number) {
  const out: { node: TmNode; x: number; y: number; w: number; h: number }[] = [];
  const nodes = items.filter((n) => n.s > 0).sort((a, b) => b.s - a.s);
  const total = nodes.reduce((s, n) => s + n.s, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let i = 0;
  while (i < nodes.length) {
    const short = Math.min(w, h);
    let j = i;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let best = Infinity;
    while (j < nodes.length) {
      const a = nodes[j].s * scale;
      const nSum = sum + a;
      const nMin = Math.min(min, a);
      const nMax = Math.max(max, a);
      const worst = Math.max((short * short * nMax) / (nSum * nSum), (nSum * nSum) / (short * short * nMin));
      if (j > i && worst > best) break;
      best = worst;
      sum = nSum;
      min = nMin;
      max = nMax;
      j++;
    }
    if (w >= h) {
      const cw = sum / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const ch = (nodes[k].s * scale) / cw;
        out.push({ node: nodes[k], x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const cw = (nodes[k].s * scale) / rh;
        out.push({ node: nodes[k], x: cx, y, w: cw, h: rh });
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

function readableText(color: string, ctx: CanvasRenderingContext2D): string {
  // Resolve any CSS color to rgb via the canvas, then pick black/white text.
  ctx.fillStyle = color;
  const c = ctx.fillStyle as string;
  let r = 128, g = 128, b = 128;
  if (c.startsWith("#")) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    const m = c.match(/\d+(\.\d+)?/g);
    if (m) [r, g, b] = m.map(Number);
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "rgba(0,0,0,0.78)" : "rgba(255,255,255,0.95)";
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "";
}

export default function Treemap({
  data,
  rootPath,
  exts,
  selectedId,
  highlightExt,
  highlightCategory,
  onSelect,
  onZoom,
  onContextMenu,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rectsRef = useRef<LRect[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ index: number; mx: number; my: number } | null>(null);
  const [theme, setTheme] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setTheme((t) => t + 1);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  // Main render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const bg = v("--panel");
    const dirFill = v("--fill");
    const ink2 = v("--ink-2");
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const aggregateColor = isDark ? "#48484a" : "#d1d1d6";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size.w, size.h);
    const rects: LRect[] = [];
    rectsRef.current = rects;
    if (!data) {
      setLayoutVersion((x) => x + 1);
      return;
    }

    const textColorCache = new Map<string, string>();
    const font = "500 11px -apple-system, 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
    ctx.font = font;
    ctx.textBaseline = "middle";

    const draw = (node: TmNode, x: number, y: number, w: number, h: number, parent: number) => {
      if (w < 0.6 || h < 0.6) return;
      const index = rects.push({ x, y, w, h, node, parent }) - 1;
      const kids = node.c;
      if (kids && kids.length && w > 4 && h > 4) {
        ctx.fillStyle = dirFill;
        ctx.fillRect(x + 0.5, y + 0.5, w - 1, h - 1);
        const header = w > 56 && h > 34 ? 16 : 0;
        if (header) {
          ctx.fillStyle = ink2;
          const label = fitText(ctx, `${node.n}  ${formatBytes(node.s)}`, w - 10);
          if (label) ctx.fillText(label, x + 5, y + header / 2 + 1);
        }
        const pad = 1.5;
        const boxes = squarify(kids, x + pad, y + header + pad, w - pad * 2, h - header - pad * 2);
        for (const b of boxes) draw(b.node, b.x, b.y, b.w, b.h, index);
        return;
      }

      const color = node.e === -2 ? aggregateColor : categoryColor(node.cat);
      const dim =
        (highlightExt != null && node.e !== highlightExt) ||
        (highlightCategory != null && node.cat !== highlightCategory);
      ctx.globalAlpha = dim ? 0.16 : 1;
      const gx = w > 2 ? x + 0.5 : x, gy = h > 2 ? y + 0.5 : y;
      const gw = w > 2 ? w - 1 : w, gh = h > 2 ? h - 1 : h;
      ctx.fillStyle = color;
      ctx.fillRect(gx, gy, gw, gh);
      if (gw > 6 && gh > 6) {
        // Subtle cushion shading for depth.
        const grad = ctx.createLinearGradient(gx, gy, gx + gw * 0.3, gy + gh);
        grad.addColorStop(0, "rgba(255,255,255,0.22)");
        grad.addColorStop(0.55, "rgba(255,255,255,0)");
        grad.addColorStop(1, "rgba(0,0,0,0.14)");
        ctx.fillStyle = grad;
        ctx.fillRect(gx, gy, gw, gh);
      }
      if (!dim && gw > 60 && gh > 18) {
        let tc = textColorCache.get(color);
        if (!tc) {
          tc = readableText(color, ctx);
          textColorCache.set(color, tc);
        }
        const label = fitText(ctx, node.n, gw - 10);
        if (label) {
          ctx.fillStyle = tc;
          ctx.fillText(label, gx + 5, gy + 10);
          if (gh > 32) {
            ctx.globalAlpha = 0.75;
            ctx.fillText(fitText(ctx, formatBytes(node.s), gw - 10), gx + 5, gy + 24);
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    draw(data, 0, 0, size.w, size.h, -1);
    setLayoutVersion((x) => x + 1);
  }, [data, size, highlightExt, highlightCategory, theme]);

  // Overlay: hover + selection outlines.
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const rects = rectsRef.current;
    const outline = (r: LRect, color: string, width: number) => {
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = width + 2;
      ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width);
    };
    if (selectedId != null) {
      const sel = rects.find((r) => r.node.i === selectedId);
      if (sel && sel.parent !== -1) {
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        outline(sel, accent, 2);
      }
    }
    if (hover && rects[hover.index] && rects[hover.index].parent !== -1) {
      outline(rects[hover.index], "rgba(255,255,255,0.95)", 1.5);
    }
  }, [hover, selectedId, size, layoutVersion]);

  const hitTest = useCallback((mx: number, my: number) => {
    const rects = rectsRef.current;
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h) return i;
    }
    return -1;
  }, []);

  const pointer = (e: MouseEvent) => {
    const box = wrapRef.current!.getBoundingClientRect();
    return { mx: e.clientX - box.left, my: e.clientY - box.top };
  };

  /** Nearest real node (skips "small items" aggregates). */
  const resolve = (index: number) => {
    const rects = rectsRef.current;
    let i = index;
    while (i >= 0 && rects[i].node.i < 0) i = rects[i].parent;
    return i;
  };

  const hovered = hover ? rectsRef.current[hover.index] : null;
  const hoverPath = (() => {
    if (!hovered) return "";
    const names: string[] = [];
    let i = hover!.index;
    const rects = rectsRef.current;
    while (i >= 0 && rects[i].parent !== -1) {
      names.push(rects[i].node.n);
      i = rects[i].parent;
    }
    names.reverse();
    const base = rootPath.endsWith("\\") ? rootPath.slice(0, -1) : rootPath;
    return [base, ...names].join("\\");
  })();

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden"
      onMouseMove={(e) => {
        const { mx, my } = pointer(e);
        const index = hitTest(mx, my);
        setHover(index >= 0 ? { index, mx, my } : null);
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const { mx, my } = pointer(e);
        const i = resolve(hitTest(mx, my));
        if (i >= 0) onSelect(rectsRef.current[i].node.i);
      }}
      onDoubleClick={(e) => {
        const { mx, my } = pointer(e);
        let i = resolve(hitTest(mx, my));
        const rects = rectsRef.current;
        // Double-clicking a file zooms into its folder.
        while (i >= 0 && !rects[i].node.d) i = rects[i].parent;
        if (i >= 0 && rects[i].parent !== -1) onZoom(rects[i].node.i);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const { mx, my } = pointer(e);
        const i = resolve(hitTest(mx, my));
        if (i >= 0) {
          const n = rectsRef.current[i].node;
          onSelect(n.i);
          onContextMenu(n.i, n.d, e);
        }
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full pointer-events-none" />

      {hovered && hovered.parent !== -1 && (
        <div
          className="pointer-events-none absolute z-20 max-w-[380px] rounded-lg bg-chrome/95 backdrop-blur-xl shadow-pop px-3 py-2"
          style={{
            left: Math.min(hover!.mx + 14, size.w - 300),
            top: hover!.my + 18 > size.h - 90 ? hover!.my - 86 : hover!.my + 18,
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{
                background:
                  hovered.node.e === -2 ? "#8E8E93" : categoryColor(hovered.node.cat),
              }}
            />
            <span className="truncate text-[12.5px] font-semibold text-ink">{hovered.node.n}</span>
            {hovered.node.cat != null && (
              <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-fill text-ink-2">
                {CATEGORY_NAMES[hovered.node.cat] ?? "Other"}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-2">{hoverPath}</div>
          <div className="mt-1 flex gap-3 text-[11.5px] tabular-nums text-ink">
            <span className="font-medium">{formatBytes(hovered.node.s)}</span>
            <span className="text-ink-2">{formatPercent(hovered.node.s, data?.s ?? 1)} of view</span>
            {!hovered.node.d && hovered.node.e >= 0 && exts[hovered.node.e] && (
              <span className="text-ink-2 truncate">
                {extTypeName(exts[hovered.node.e].ext)} ({extLabel(exts[hovered.node.e].ext)})
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

