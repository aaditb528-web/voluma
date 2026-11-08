"use client";

import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: (MenuItem | "separator")[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 230);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 16);

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[220px] rounded-lg bg-chrome/95 p-1 shadow-pop backdrop-blur-xl"
      style={{ left, top }}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="mx-2 my-1 h-px bg-sep" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className="flex w-full rounded-[5px] px-2.5 py-[5px] text-left text-[13px] hover:bg-accent hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-current"
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

