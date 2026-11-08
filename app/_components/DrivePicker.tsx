"use client";

import { Check, ChevronDown, HardDrive, Usb } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DriveInfo } from "../_lib/api";
import { formatBytes } from "../_lib/format";

export const driveName = (d: DriveInfo) => `${d.label || d.kind} (${d.letter}:)`;

export default function DrivePicker({
  drives,
  value,
  onChange,
  disabled,
}: {
  drives: DriveInfo[];
  value: string;
  onChange: (letter: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = drives.find((d) => d.letter === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-2 rounded-md border border-sep bg-window px-2.5 text-[13px] shadow-[0_0.5px_1px_rgba(0,0,0,0.08)] hover:bg-hover disabled:opacity-50"
      >
        <HardDrive size={14} className="text-ink-2" />
        <span className="font-medium">{current ? driveName(current) : "Select drive"}</span>
        <ChevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-50 w-[300px] rounded-xl bg-chrome/95 p-1.5 shadow-pop backdrop-blur-xl">
          <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold text-ink-3">Locations</div>
          {drives.map((d) => {
            const used = d.total - d.free;
            const Icon = d.kind === "Removable" ? Usb : HardDrive;
            return (
              <button
                key={d.letter}
                onClick={() => {
                  onChange(d.letter);
                  setOpen(false);
                }}
                className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-accent hover:text-white"
              >
                <Icon size={18} className="shrink-0 text-ink-2 group-hover:text-white" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">{driveName(d)}</span>
                    {d.letter === value && <Check size={13} />}
                  </div>
                  <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-fill group-hover:bg-white/25">
                    <div
                      className="h-full rounded-full bg-accent group-hover:bg-white"
                      style={{ width: `${d.total ? (used / d.total) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-ink-2 tabular-nums group-hover:text-white/80">
                    {formatBytes(d.free)} free of {formatBytes(d.total)} · {d.fileSystem || d.kind}
                  </div>
                </div>
              </button>
            );
          })}
          {drives.length === 0 && <div className="px-2.5 py-2 text-ink-3">No drives found</div>}
        </div>
      )}
    </div>
  );
}

