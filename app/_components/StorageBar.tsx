"use client";

import { useMemo, useState } from "react";
import type { CategorySummary, DriveInfo } from "../_lib/api";
import { formatBytes, formatPercent, SYSTEM_UNREADABLE_COLOR } from "../_lib/format";

interface Segment {
  id?: number;
  name: string;
  color: string;
  bytes: number;
  hint?: string;
}

/** macOS "Storage"-style segmented bar: what the used space is made of. */
export default function StorageBar({
  drive,
  categories,
  selectedCategory,
  onSelectCategory,
}: {
  drive: DriveInfo;
  categories: CategorySummary[];
  selectedCategory?: number | null;
  onSelectCategory?: (id: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const used = Math.max(0, drive.total - drive.free);

  const { segments } = useMemo(() => {
    let scannedAllocated = 0;
    for (const c of categories) {
      scannedAllocated += c.allocated;
    }

    const segs: Segment[] = [];
    for (const c of categories) {
      if (c.allocated > 0) {
        segs.push({
          id: c.id,
          name: c.name,
          color: c.color,
          bytes: c.allocated,
        });
      }
    }

    // Sort by allocated size descending
    segs.sort((a, b) => b.bytes - a.bytes);

    // Any gap between Windows reported used space and scanned file allocations
    // represents system volume information, shadow copies (VSS), or unreadable metadata.
    const unaccounted = Math.max(0, used - scannedAllocated);
    if (unaccounted > 0) {
      segs.push({
        name: "System & Unreadable",
        color: SYSTEM_UNREADABLE_COLOR,
        bytes: unaccounted,
        hint: "Shadow copies, restore points, and NTFS metadata inaccessible to standard scanning.",
      });
    }

    return { segments: segs };
  }, [categories, used]);

  return (
    <div>
      <div
        className="flex h-[22px] w-full overflow-hidden rounded-[6px] bg-fill"
        onMouseLeave={() => setHover(null)}
      >
        {segments.map((s, i) => (
          <div
            key={s.name}
            onMouseEnter={() => setHover(i)}
            onClick={() => s.id !== undefined && onSelectCategory?.(selectedCategory === s.id ? null : s.id)}
            className={`h-full transition-opacity border-r border-window last:border-r-0 ${
              s.id !== undefined ? "cursor-pointer" : ""
            }`}
            style={{
              width: `${drive.total > 0 ? (s.bytes / drive.total) * 100 : 0}%`,
              background: s.color,
              opacity:
                (hover == null || hover === i) &&
                (selectedCategory == null || selectedCategory === s.id)
                  ? 1
                  : 0.35,
            }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]">
        {segments.map((s, i) => {
          const isSelected = s.id !== undefined && selectedCategory === s.id;
          return (
            <button
              key={s.name}
              type="button"
              title={s.hint}
              onClick={() => s.id !== undefined && onSelectCategory?.(isSelected ? null : s.id)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className={`flex items-center gap-1.5 transition-opacity text-left ${
                s.id !== undefined ? "cursor-pointer hover:underline" : "cursor-default"
              } ${
                (hover == null || hover === i) && (selectedCategory == null || isSelected)
                  ? ""
                  : "opacity-45"
              } ${isSelected ? "font-semibold" : ""}`}
            >
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="text-ink">{s.name}</span>
              <span className="tabular-nums text-ink-2">
                {formatBytes(s.bytes)}
                {hover === i && ` · ${formatPercent(s.bytes, drive.total)}`}
              </span>
            </button>
          );
        })}
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-fill ring-1 ring-inset ring-sep shrink-0" />
          <span className="text-ink">Available</span>
          <span className="tabular-nums text-ink-2">{formatBytes(drive.free)}</span>
        </div>
      </div>
    </div>
  );
}
