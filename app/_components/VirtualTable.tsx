"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState, KeyboardEvent, MouseEvent } from "react";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface Column<T> {
  key: string;
  title: string;
  /** CSS grid track, e.g. "96px" or "minmax(240px,1fr)". */
  width: string;
  align?: "left" | "right";
  sortable?: boolean;
  render: (row: T, selected: boolean) => ReactNode;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => number;
  minWidth: number;
  selectedKey?: number | null;
  onSelect?: (row: T) => void;
  onActivate?: (row: T) => void;
  onContextMenu?: (row: T, e: MouseEvent) => void;
  onKeyDown?: (row: T, e: KeyboardEvent) => void;
  sort?: SortState;
  onSort?: (key: string) => void;
  rowHeight?: number;
  empty?: ReactNode;
  rowClassName?: (row: T) => string;
}

const HEADER_H = 28;

export default function VirtualTable<T>({
  rows,
  columns,
  rowKey,
  minWidth,
  selectedKey,
  onSelect,
  onActivate,
  onContextMenu,
  onKeyDown,
  sort,
  onSort,
  rowHeight = 26,
  empty,
  rowClassName,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const template = columns.map((c) => c.width).join(" ");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view (keyboard navigation, treemap clicks, ...).
  const selectedIndex = selectedKey == null ? -1 : rows.findIndex((r) => rowKey(r) === selectedKey);
  useEffect(() => {
    const el = ref.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * rowHeight;
    const visibleH = el.clientHeight - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + visibleH) el.scrollTop = top + rowHeight - visibleH;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedIndex >= 0]);

  const overscan = 8;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);

  const handleKey = (e: KeyboardEvent) => {
    if (!rows.length) return;
    const cur = selectedIndex < 0 ? 0 : selectedIndex;
    const page = Math.max(1, Math.floor((viewH - HEADER_H) / rowHeight) - 1);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "PageDown") next = Math.min(rows.length - 1, cur + page);
    else if (e.key === "PageUp") next = Math.max(0, cur - page);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    if (next >= 0) {
      e.preventDefault();
      onSelect?.(rows[next]);
      return;
    }
    if (selectedIndex >= 0) {
      if (e.key === "Enter") onActivate?.(rows[selectedIndex]);
      onKeyDown?.(rows[selectedIndex], e);
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={handleKey}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-full overflow-auto outline-none"
    >
      <div style={{ minWidth }}>
        {/* Header */}
        <div
          className="sticky top-0 z-10 grid border-b border-sep bg-window/90 backdrop-blur-xl text-[11px] font-medium text-ink-2"
          style={{ gridTemplateColumns: template, height: HEADER_H }}
        >
          {columns.map((c) => {
            const active = sort?.key === c.key;
            const sortable = c.sortable !== false && !!onSort;
            return (
              <button
                key={c.key}
                disabled={!sortable}
                onClick={() => onSort?.(c.key)}
                className={`flex items-center gap-1 px-2.5 border-r border-sep last:border-r-0 truncate ${
                  c.align === "right" ? "justify-end" : "justify-start"
                } ${sortable ? "hover:bg-hover cursor-default" : ""} ${active ? "text-ink" : ""}`}
              >
                <span className="truncate">{c.title}</span>
                {active &&
                  (sort!.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
              </button>
            );
          })}
        </div>

        {/* Rows */}
        {rows.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-ink-3 text-[13px]">{empty}</div>
        ) : (
          <div style={{ height: rows.length * rowHeight, position: "relative" }}>
            {rows.slice(start, end).map((row, i) => {
              const index = start + i;
              const key = rowKey(row);
              const selected = key === selectedKey;
              return (
                <div
                  key={key}
                  onMouseDown={() => onSelect?.(row)}
                  onDoubleClick={() => onActivate?.(row)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSelect?.(row);
                    onContextMenu?.(row, e);
                  }}
                  className={`absolute left-0 right-0 grid items-center tabular-nums ${
                    selected
                      ? "bg-selection text-white"
                      : index % 2
                        ? "bg-row-alt hover:bg-hover"
                        : "hover:bg-hover"
                  } ${rowClassName?.(row) ?? ""}`}
                  style={{ gridTemplateColumns: template, height: rowHeight, top: index * rowHeight }}
                >
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      className={`px-2.5 truncate ${c.align === "right" ? "text-right" : ""}`}
                    >
                      {c.render(row, selected)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small horizontal bar used for "% of parent" style columns. */
export function PercentBar({
  value,
  selected,
  color,
  label,
}: {
  value: number;
  selected?: boolean;
  color?: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className={`h-[6px] flex-1 rounded-full overflow-hidden ${selected ? "bg-white/25" : "bg-fill"}`}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(value > 0 ? 2 : 0, Math.min(100, value * 100))}%`,
            background: selected ? "#fff" : (color ?? "var(--accent)"),
          }}
        />
      </div>
      <span className={`w-[46px] text-right text-[11.5px] ${selected ? "text-white" : "text-ink-2"}`}>
        {label}
      </span>
    </div>
  );
}

