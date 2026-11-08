"use client";

import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  Folder,
  HardDrive,
  Home as HomeIcon,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ContextMenu, { MenuItem } from "./_components/ContextMenu";
import DrivePicker, { driveName } from "./_components/DrivePicker";
import StorageBar from "./_components/StorageBar";
import Treemap from "./_components/Treemap";
import VirtualTable, { Column, PercentBar, SortState } from "./_components/VirtualTable";
import {
  api,
  isTauri,
  type DriveInfo,
  type ExtInfo,
  type FileRow,
  type NodeInfo,
  type Progress,
  type ScanSummary,
  type TmNode,
} from "./_lib/api";
import {
  describeAttributes,
  extColor,
  extLabel,
  extTypeName,
  formatAttributes,
  formatBytes,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  isHiddenOrSystem,
} from "./_lib/format";

interface TreeRow {
  node: NodeInfo;
  depth: number;
  parentSize: number;
  expanded: boolean;
}
type ExtRow = ExtInfo & { rank: number };
type Tab = "tree" | "files";

function compare(a: number | string, b: number | string, dir: "asc" | "desc") {
  const r = typeof a === "string" ? a.localeCompare(b as string, undefined, { numeric: true }) : a - (b as number);
  return dir === "asc" ? r : -r;
}

const nodeSortValue = (n: NodeInfo, key: string): number | string => {
  switch (key) {
    case "name": return n.name.toLowerCase();
    case "allocated": return n.allocated;
    case "items": return n.files + n.folders;
    case "files": return n.files;
    case "folders": return n.folders;
    case "modified": return n.modified;
    case "attributes": return formatAttributes(n.attributes);
    default: return n.size;
  }
};

const nextSort = (cur: SortState, key: string): SortState =>
  cur.key === key
    ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
    : { key, dir: key === "name" || key === "path" || key === "ext" ? "asc" : "desc" };

function Swatch({ color, selected }: { color: string; selected?: boolean }) {
  return (
    <span
      className={`inline-block h-[11px] w-[11px] shrink-0 rounded-[3px] ${selected ? "ring-1 ring-white/70" : ""}`}
      style={{ background: color }}
    />
  );
}

export default function Home() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [letter, setLetter] = useState("C");
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exts, setExts] = useState<ExtInfo[]>([]);

  // Folder tree.
  const cache = useRef(new Map<number, NodeInfo[]>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ node: NodeInfo; path: string } | null>(null);
  const [treeSort, setTreeSort] = useState<SortState>({ key: "size", dir: "desc" });

  // Files view.
  const [tab, setTab] = useState<Tab>("tree");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [extFilter, setExtFilter] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [filesScope, setFilesScope] = useState<{ id: number; name: string } | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesSort, setFilesSort] = useState<SortState>({ key: "size", dir: "desc" });
  const [extSort, setExtSort] = useState<SortState>({ key: "size", dir: "desc" });

  // Treemap.
  const [tmRoot, setTmRoot] = useState(0);
  const [tmData, setTmData] = useState<TmNode | null>(null);
  const [tmPath, setTmPath] = useState("");
  const [crumbs, setCrumbs] = useState<{ id: number; name: string }[]>([]);
  const [tmHeight, setTmHeight] = useState(300);

  const [menu, setMenu] = useState<{ x: number; y: number; id: number; isDir: boolean } | null>(null);
  const tauri = typeof window === "undefined" ? true : isTauri();

  // ----- bootstrapping -----------------------------------------------------
  useEffect(() => {
    if (!isTauri()) return;
    api.listDrives().then((list) => {
      setDrives(list);
      if (list.length && !list.some((d) => d.letter === "C")) setLetter(list[0].letter);
    });
    const unlisten = listen<Progress>("scan-progress", (e) => setProgress(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(t);
  }, [scanning]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const scan = useCallback(async (driveLetter: string) => {
    setScanning(true);
    setError(null);
    setProgress(null);
    setElapsed(0);
    try {
      const result = await api.scanDrive(driveLetter);
      const [rootKids, extList] = await Promise.all([api.getChildren(0), api.getExtensions()]);
      cache.current = new Map([[0, rootKids]]);
      setCacheVersion((v) => v + 1);
      setExts(extList);
      setExpanded(new Set([0]));
      setSelectedId(0);
      setTmRoot(0);
      setExtFilter(null);
      setCategoryFilter(null);
      setFilesScope(null);
      setSummary(result);
      api.listDrives().then(setDrives).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const ensureChildren = useCallback(async (id: number) => {
    if (cache.current.has(id)) return;
    const kids = await api.getChildren(id);
    cache.current.set(id, kids);
    setCacheVersion((v) => v + 1);
  }, []);

  const toggle = useCallback(
    async (node: NodeInfo, open?: boolean) => {
      if (!node.isDir || !node.hasChildren) return;
      const willOpen = open ?? !expanded.has(node.id);
      if (willOpen) await ensureChildren(node.id);
      setExpanded((prev) => {
        const s = new Set(prev);
        if (willOpen) s.add(node.id);
        else s.delete(node.id);
        return s;
      });
    },
    [expanded, ensureChildren],
  );

  const revealInTree = useCallback(
    async (id: number) => {
      const chain = await api.getAncestors(id);
      const parents = chain.slice(0, -1);
      for (const p of parents) await ensureChildren(p);
      setExpanded((prev) => new Set([...prev, ...parents]));
      setSelectedId(id);
      setTab("tree");
    },
    [ensureChildren],
  );

  // ----- derived data ------------------------------------------------------
  const rootNode = summary?.root ?? null;

  const treeRows = useMemo<TreeRow[]>(() => {
    if (!rootNode) return [];
    const out: TreeRow[] = [];
    const walk = (node: NodeInfo, depth: number, parentSize: number) => {
      const isOpen = expanded.has(node.id);
      out.push({ node, depth, parentSize, expanded: isOpen });
      if (!isOpen) return;
      let kids = cache.current.get(node.id);
      if (!kids) return;
      if (!(treeSort.key === "size" && treeSort.dir === "desc")) {
        kids = [...kids].sort((a, b) => compare(nodeSortValue(a, treeSort.key), nodeSortValue(b, treeSort.key), treeSort.dir));
      }
      for (const k of kids) walk(k, depth + 1, node.size);
    };
    walk(rootNode, 0, rootNode.size);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootNode, expanded, treeSort, cacheVersion]);

  const extRows = useMemo<ExtRow[]>(() => {
    const rows = exts.map((e, rank) => ({ ...e, rank }));
    const val = (r: ExtRow): number | string =>
      extSort.key === "ext" ? r.ext : extSort.key === "files" ? r.files : extSort.key === "allocated" ? r.allocated : r.size;
    return rows.sort((a, b) => compare(val(a), val(b), extSort.dir));
  }, [exts, extSort]);

  const sortedFiles = useMemo(() => {
    const val = (f: FileRow): number | string => {
      switch (filesSort.key) {
        case "name": return f.name.toLowerCase();
        case "path": return f.path.toLowerCase();
        case "allocated": return f.allocated;
        case "modified": return f.modified;
        case "attributes": return formatAttributes(f.attributes);
        default: return f.size;
      }
    };
    return [...files].sort((a, b) => compare(val(a), val(b), filesSort.dir));
  }, [files, filesSort]);

  const scannedSize = useMemo(() => exts.reduce((s, e) => s + e.size, 0), [exts]);

  // ----- effects that load data -------------------------------------------
  useEffect(() => {
    if (!summary || tab !== "files") return;
    let cancelled = false;
    setFilesLoading(true);
    api
      .getFiles({
        query: debouncedQuery || undefined,
        ext: extFilter ?? undefined,
        category: categoryFilter ?? undefined,
        under: filesScope?.id,
        limit: 2000,
      })
      .then((rows) => !cancelled && setFiles(rows))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setFilesLoading(false));
    return () => {
      cancelled = true;
    };
  }, [summary, tab, debouncedQuery, extFilter, categoryFilter, filesScope]);

  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    api.getTreemap(tmRoot, 14000).then((d) => !cancelled && setTmData(d)).catch((e) => setError(String(e)));
    Promise.all([api.getAncestors(tmRoot), api.getPath(tmRoot)]).then(([ids, path]) => {
      if (cancelled) return;
      const names = path.replace(/\\$/, "").split("\\");
      setTmPath(path);
      setCrumbs(ids.map((id, i) => ({ id, name: i === 0 ? driveName(summary.drive) : (names[i] ?? "…") })));
    });
    return () => {
      cancelled = true;
    };
  }, [summary, tmRoot]);

  useEffect(() => {
    if (!summary || selectedId == null) {
      setSelection(null);
      return;
    }
    let cancelled = false;
    Promise.all([api.getNode(selectedId), api.getPath(selectedId)])
      .then(([node, path]) => !cancelled && setSelection({ node, path }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [summary, selectedId]);

  // ----- actions -------------------------------------------------------------
  const zoomTo = useCallback(async (id: number, isDir: boolean) => {
    if (isDir) return setTmRoot(id);
    const node = await api.getNode(id);
    if (node.parent != null) setTmRoot(node.parent);
  }, []);

  const openMenu = (id: number, isDir: boolean, x: number, y: number) => setMenu({ id, isDir, x, y });

  const menuItems = (m: { id: number; isDir: boolean }): (MenuItem | "separator")[] => [
    { label: "Reveal in File Explorer", onClick: () => api.reveal(m.id).catch((e) => setError(String(e))) },
    {
      label: "Copy Path",
      onClick: () => api.getPath(m.id).then((p) => navigator.clipboard.writeText(p)),
    },
    "separator",
    { label: m.isDir ? "Zoom Treemap Here" : "Show in Treemap", onClick: () => zoomTo(m.id, m.isDir) },
    { label: "Show in Folder Tree", onClick: () => revealInTree(m.id) },
    {
      label: "Largest Files in This Folder",
      disabled: !m.isDir,
      onClick: async () => {
        const node = await api.getNode(m.id);
        setFilesScope(m.id === 0 ? null : { id: m.id, name: node.name });
        setTab("files");
      },
    },
  ];

  const selectExt = (rank: number) => {
    const next = extFilter === rank ? null : rank;
    setExtFilter(next);
    if (next != null) setTab("files");
  };

  // ----- columns -----------------------------------------------------------
  const muted = (sel: boolean) => (sel ? "text-white/85" : "text-ink-2");

  const treeColumns: Column<TreeRow>[] = [
    {
      key: "name",
      title: "Name",
      width: "minmax(260px,1fr)",
      render: ({ node, depth, expanded: open }, sel) => (
        <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
          {node.isDir && node.hasChildren ? (
            <button
              onMouseDown={(e) => {
                e.stopPropagation();
                setSelectedId(node.id);
                toggle(node);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-hover"
            >
              <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {node.id === 0 ? (
            <HardDrive size={14} className={sel ? "text-white" : "text-ink-2"} />
          ) : node.isDir ? (
            <Folder size={14} strokeWidth={1.6} className={sel ? "text-white" : "text-folder"} fill="currentColor" fillOpacity={0.35} />
          ) : (
            <Swatch color={extColor(node.ext)} selected={sel} />
          )}
          <span
            className={`truncate ${!sel && isHiddenOrSystem(node.attributes) ? "text-ink-2" : ""} ${node.id === 0 ? "font-semibold" : ""}`}
          >
            {node.id === 0 && summary ? driveName(summary.drive) : node.name}
          </span>
        </div>
      ),
    },
    {
      key: "percent",
      title: "% of Parent",
      width: "128px",
      sortable: false,
      render: ({ node, parentSize }, sel) => (
        <PercentBar value={parentSize ? node.size / parentSize : 0} selected={sel} label={formatPercent(node.size, parentSize)} />
      ),
    },
    { key: "size", title: "Size", width: "88px", align: "right", render: ({ node }) => formatBytes(node.size) },
    {
      key: "allocated",
      title: "Allocated",
      width: "88px",
      align: "right",
      render: ({ node }, sel) => <span className={muted(sel)}>{formatBytes(node.allocated)}</span>,
    },
    {
      key: "items",
      title: "Items",
      width: "80px",
      align: "right",
      render: ({ node }) => (node.isDir ? formatNumber(node.files + node.folders) : ""),
    },
    {
      key: "files",
      title: "Files",
      width: "76px",
      align: "right",
      render: ({ node }, sel) => <span className={muted(sel)}>{node.isDir ? formatNumber(node.files) : ""}</span>,
    },
    {
      key: "folders",
      title: "Folders",
      width: "70px",
      align: "right",
      render: ({ node }, sel) => <span className={muted(sel)}>{node.isDir ? formatNumber(node.folders) : ""}</span>,
    },
    {
      key: "modified",
      title: "Modified",
      width: "142px",
      render: ({ node }, sel) => <span className={muted(sel)}>{formatDate(node.modified)}</span>,
    },
    {
      key: "attributes",
      title: "Attr",
      width: "56px",
      render: ({ node }, sel) => (
        <span title={describeAttributes(node.attributes)} className={`font-mono text-[11px] ${muted(sel)}`}>
          {formatAttributes(node.attributes)}
        </span>
      ),
    },
  ];

  const fileColumns: Column<FileRow>[] = [
    {
      key: "name",
      title: "Name",
      width: "minmax(220px,1.1fr)",
      render: (f, sel) => (
        <div className="flex items-center gap-2">
          <Swatch color={extColor(f.ext)} selected={sel} />
          <span className={`truncate ${!sel && isHiddenOrSystem(f.attributes) ? "text-ink-2" : ""}`}>{f.name}</span>
        </div>
      ),
    },
    {
      key: "path",
      title: "Folder",
      width: "minmax(220px,1fr)",
      render: (f, sel) => (
        <span className={muted(sel)} title={f.path}>
          {f.path.slice(0, Math.max(0, f.path.length - f.name.length - 1)) || "\\"}
        </span>
      ),
    },
    {
      key: "percent",
      title: "% of Drive",
      width: "120px",
      sortable: false,
      render: (f, sel) => (
        <PercentBar
          value={rootNode ? f.size / rootNode.size : 0}
          selected={sel}
          color={extColor(f.ext)}
          label={formatPercent(f.size, rootNode?.size ?? 1)}
        />
      ),
    },
    { key: "size", title: "Size", width: "88px", align: "right", render: (f) => formatBytes(f.size) },
    {
      key: "allocated",
      title: "Allocated",
      width: "88px",
      align: "right",
      render: (f, sel) => <span className={muted(sel)}>{formatBytes(f.allocated)}</span>,
    },
    {
      key: "modified",
      title: "Modified",
      width: "142px",
      render: (f, sel) => <span className={muted(sel)}>{formatDate(f.modified)}</span>,
    },
    {
      key: "attributes",
      title: "Attr",
      width: "56px",
      render: (f, sel) => (
        <span title={describeAttributes(f.attributes)} className={`font-mono text-[11px] ${muted(sel)}`}>
          {formatAttributes(f.attributes)}
        </span>
      ),
    },
  ];

  const extColumns: Column<ExtRow>[] = [
    {
      key: "ext",
      title: "Type",
      width: "minmax(170px,1fr)",
      render: (e, sel) => (
        <div className="flex items-center gap-2">
          <Swatch color={extColor(e.rank)} selected={sel} />
          <span className="w-[62px] shrink-0 truncate font-medium">{extLabel(e.ext)}</span>
          <span className={`truncate ${muted(sel)}`}>{extTypeName(e.ext)}</span>
        </div>
      ),
    },
    {
      key: "percent",
      title: "Percent",
      width: "112px",
      sortable: false,
      render: (e, sel) => (
        <PercentBar value={scannedSize ? e.size / scannedSize : 0} selected={sel} color={extColor(e.rank)} label={formatPercent(e.size, scannedSize)} />
      ),
    },
    { key: "size", title: "Size", width: "76px", align: "right", render: (e) => formatBytes(e.size) },
    {
      key: "allocated",
      title: "Allocated",
      width: "80px",
      align: "right",
      render: (e, sel) => <span className={muted(sel)}>{formatBytes(e.allocated)}</span>,
    },
    {
      key: "files",
      title: "Files",
      width: "72px",
      align: "right",
      render: (e, sel) => <span className={muted(sel)}>{formatNumber(e.files)}</span>,
    },
  ];

  // ----- render --------------------------------------------------------------
  const currentDrive = drives.find((d) => d.letter === letter);
  const drive = summary?.drive;
  const used = drive ? drive.total - drive.free : 0;

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = tmHeight;
    const move = (ev: PointerEvent) =>
      setTmHeight(Math.max(140, Math.min(window.innerHeight - 330, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-screen flex-col bg-window text-ink">
      {/* Toolbar */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-sep bg-chrome px-4">
        <div className="flex items-center gap-2 pr-2">
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-gradient-to-b from-[#3d9bff] to-[#0062e0] shadow-sm">
            <div className="grid grid-cols-2 gap-[2px]">
              <span className="h-[5px] w-[5px] rounded-[1.5px] bg-white" />
              <span className="h-[5px] w-[5px] rounded-[1.5px] bg-white/60" />
              <span className="h-[5px] w-[5px] rounded-[1.5px] bg-white/60" />
              <span className="h-[5px] w-[5px] rounded-[1.5px] bg-white/85" />
            </div>
          </div>
          <span className="text-[14px] font-semibold tracking-tight">Voluma</span>
        </div>

        <DrivePicker drives={drives} value={letter} onChange={setLetter} disabled={scanning} />
        <button
          onClick={() => scan(letter)}
          disabled={scanning || !tauri}
          className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-white shadow-sm hover:brightness-110 active:brightness-95 disabled:opacity-50"
        >
          <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
          {scanning ? "Scanning…" : summary && summary.drive.letter === letter ? "Rescan" : "Scan"}
        </button>

        <div className="flex-1" />

        {summary && (
          <div className="flex rounded-md bg-fill p-[2px] text-[12.5px]">
            {(
              [
                ["tree", "Folders"],
                ["files", "Largest Files"],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-[5px] px-3 py-[3px] font-medium ${
                  tab === t ? "bg-window text-ink shadow-[0_1px_2px_rgba(0,0,0,0.15)]" : "text-ink-2 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {summary && (
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value) setTab("files");
              }}
              placeholder="Search files"
              spellCheck={false}
              className="h-7 w-[220px] rounded-md bg-fill pl-8 pr-7 text-[13px] outline-none placeholder:text-ink-3 focus:ring-[3px] focus:ring-accent/35"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
                <X size={13} />
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-sep bg-[rgba(255,69,58,0.1)] px-4 py-2 text-[12.5px]">
          <span className="flex-1 text-[#FF453A]">{error}</span>
          <button onClick={() => setError(null)} className="text-ink-2 hover:text-ink">
            <X size={14} />
          </button>
        </div>
      )}

      {scanning ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-[440px] text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft">
              <HardDrive size={28} className="text-accent" />
            </div>
            <div className="text-[17px] font-semibold">
              Scanning {currentDrive ? driveName(currentDrive) : `${letter}:`}
            </div>
            <div className="mt-1 text-ink-2">{progress?.phase ?? "Opening volume…"}</div>
            <div className="mt-6 h-[5px] overflow-hidden rounded-full bg-fill">
              <div className="animate-indeterminate h-full w-2/5 rounded-full bg-accent" />
            </div>
            <div className="mt-3 flex justify-center gap-5 text-[12px] tabular-nums text-ink-2">
              <span>{formatNumber(progress?.items ?? 0)} items</span>
              {!!progress?.bytes && <span>{formatBytes(progress.bytes)}</span>}
              <span>{formatDuration(elapsed)}</span>
            </div>
          </div>
        </div>
      ) : !summary ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-[420px] text-center">
            <div className="mx-auto mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-accent-soft">
              <HardDrive size={32} className="text-accent" />
            </div>
            <h1 className="text-[20px] font-semibold tracking-tight">See what&apos;s taking up space</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              {tauri
                ? "Voluma reads the drive's Master File Table to map every file and folder in seconds. Run as administrator for the fastest, most complete results."
                : "Open this page inside the Voluma desktop app to scan drives."}
            </p>
            {tauri && (
              <button
                onClick={() => scan(letter)}
                className="mt-6 h-8 rounded-lg bg-accent px-5 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
              >
                Scan {currentDrive ? driveName(currentDrive) : `${letter}:`}
              </button>
            )}
            {currentDrive && (
              <div className="mt-3 text-[12px] tabular-nums text-ink-3">
                {formatBytes(currentDrive.total - currentDrive.free)} used of {formatBytes(currentDrive.total)}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Overview */}
          <section className="shrink-0 border-b border-sep px-5 pb-4 pt-3.5">
            <div className="mb-3 flex items-end justify-between gap-6">
              <div className="min-w-0">
                <h1 className="truncate text-[19px] font-semibold tracking-tight">{driveName(drive!)}</h1>
                <div className="mt-0.5 text-[12px] text-ink-2">
                  {drive!.fileSystem} · {drive!.kind} · Scanned in {formatDuration(summary.scanMs)}
                  {summary.method === "MFT" ? " via Master File Table" : " via file system"}
                </div>
              </div>
              <div className="flex shrink-0 gap-7">
                {[
                  ["Used", formatBytes(used), formatPercent(used, drive!.total)],
                  ["Available", formatBytes(drive!.free), formatPercent(drive!.free, drive!.total)],
                  ["Capacity", formatBytes(drive!.total), ""],
                  ["Files", formatNumber(rootNode!.files), ""],
                  ["Folders", formatNumber(rootNode!.folders), ""],
                ].map(([label, value, sub]) => (
                  <div key={label} className="text-right">
                    <div className="text-[11px] font-medium text-ink-2">{label}</div>
                    <div className="text-[15px] font-semibold tabular-nums">
                      {value}
                      {sub && <span className="ml-1 text-[11px] font-normal text-ink-3">{sub}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <StorageBar
              drive={drive!}
              categories={summary.categories}
              selectedCategory={categoryFilter}
              onSelectCategory={(catId) => {
                setCategoryFilter(catId);
                if (catId != null) setTab("files");
              }}
            />
            {summary.method === "Filesystem" && (
              <div className="mt-3 flex items-center gap-3 rounded-lg bg-[rgba(255,159,10,0.12)] px-3 py-2 text-[12px]">
                <ShieldAlert size={15} className="shrink-0 text-[#FF9F0A]" />
                <span className="flex-1">
                  Standard scan — some protected folders couldn&apos;t be read, so totals may be incomplete. Restart as
                  administrator for a complete and much faster Master File Table scan.
                </span>
                <button
                  onClick={() => api.restartAsAdmin().catch((e) => setError(String(e)))}
                  className="shrink-0 rounded-md border border-sep bg-window px-2.5 py-1 font-medium shadow-sm hover:bg-hover"
                >
                  Restart as Administrator
                </button>
              </div>
            )}
          </section>

          {/* Tables */}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {tab === "files" && (
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sep px-3 text-[12px]">
                  <span className="text-ink-2">
                    {filesLoading ? "Searching…" : `${formatNumber(files.length)} largest files`}
                  </span>
                  {debouncedQuery && <Chip label={`Name contains “${debouncedQuery}”`} onClear={() => setQuery("")} />}
                  {categoryFilter != null && summary.categories[categoryFilter] && (
                    <Chip
                      color={summary.categories[categoryFilter].color}
                      label={`Category: ${summary.categories[categoryFilter].name}`}
                      onClear={() => setCategoryFilter(null)}
                    />
                  )}
                  {extFilter != null && exts[extFilter] && (
                    <Chip
                      color={extColor(extFilter)}
                      label={`${extLabel(exts[extFilter].ext)} · ${extTypeName(exts[extFilter].ext)}`}
                      onClear={() => setExtFilter(null)}
                    />
                  )}
                  {filesScope && (
                    <Chip icon label={`In “${filesScope.name}”`} onClear={() => setFilesScope(null)} />
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1">
                {tab === "tree" ? (
                  <VirtualTable
                    rows={treeRows}
                    columns={treeColumns}
                    rowKey={(r) => r.node.id}
                    minWidth={1000}
                    selectedKey={selectedId}
                    onSelect={(r) => setSelectedId(r.node.id)}
                    onActivate={(r) => (r.node.isDir ? toggle(r.node) : api.reveal(r.node.id))}
                    onContextMenu={(r, e) => openMenu(r.node.id, r.node.isDir, e.clientX, e.clientY)}
                    onKeyDown={(r, e) => {
                      if (e.key === "ArrowRight") {
                        e.preventDefault();
                        if (r.node.isDir && r.node.hasChildren && !r.expanded) toggle(r.node, true);
                        else if (r.expanded) {
                          const kids = cache.current.get(r.node.id);
                          const i = treeRows.indexOf(r);
                          if (kids?.length && treeRows[i + 1]) setSelectedId(treeRows[i + 1].node.id);
                        }
                      } else if (e.key === "ArrowLeft") {
                        e.preventDefault();
                        if (r.expanded && r.node.id !== 0) toggle(r.node, false);
                        else if (r.node.parent != null) setSelectedId(r.node.parent);
                      }
                    }}
                    sort={treeSort}
                    onSort={(k) => setTreeSort((s) => nextSort(s, k))}
                  />
                ) : (
                  <VirtualTable
                    rows={sortedFiles}
                    columns={fileColumns}
                    rowKey={(f) => f.id}
                    minWidth={1000}
                    selectedKey={selectedId}
                    onSelect={(f) => setSelectedId(f.id)}
                    onActivate={(f) => api.reveal(f.id)}
                    onContextMenu={(f, e) => openMenu(f.id, false, e.clientX, e.clientY)}
                    sort={filesSort}
                    onSort={(k) => setFilesSort((s) => nextSort(s, k))}
                    empty={filesLoading ? "Searching…" : "No matching files"}
                  />
                )}
              </div>
            </div>

            {/* File types */}
            <aside className="flex w-[500px] shrink-0 flex-col border-l border-sep bg-panel">
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-sep px-3">
                <span className="text-[12px] font-semibold">File Types</span>
                <span className="text-[11.5px] text-ink-2 tabular-nums">
                  {formatNumber(exts.length)} types · {formatBytes(scannedSize)}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <VirtualTable
                  rows={extRows}
                  columns={extColumns}
                  rowKey={(e) => e.rank}
                  minWidth={480}
                  selectedKey={extFilter}
                  onSelect={(e) => selectExt(e.rank)}
                  sort={extSort}
                  onSort={(k) => setExtSort((s) => nextSort(s, k))}
                />
              </div>
            </aside>
          </div>

          {/* Treemap */}
          <div onPointerDown={startResize} className="relative z-10 -my-[3px] h-[6px] shrink-0 cursor-row-resize" />
          <section className="flex shrink-0 flex-col border-t border-sep" style={{ height: tmHeight }}>
            <div className="flex h-8 shrink-0 items-center gap-1 px-3 text-[12px]">
              <button
                onClick={() => setTmRoot(0)}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-2 hover:bg-hover hover:text-ink"
                title="Whole drive"
              >
                <HomeIcon size={13} />
              </button>
              {crumbs.map((c, i) => (
                <span key={c.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight size={12} className="shrink-0 text-ink-3" />}
                  <button
                    onClick={() => setTmRoot(c.id)}
                    className={`truncate rounded px-1 py-px hover:bg-hover ${
                      i === crumbs.length - 1 ? "font-semibold text-ink" : "text-ink-2"
                    }`}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
              {tmData && <span className="ml-2 text-ink-3 tabular-nums">{formatBytes(tmData.s)}</span>}
              <div className="flex-1" />
              {categoryFilter != null && summary.categories[categoryFilter] && (
                <span className="mr-3 flex items-center gap-1.5 text-ink-2">
                  <Swatch color={summary.categories[categoryFilter].color} /> Highlighting {summary.categories[categoryFilter].name}
                </span>
              )}
              {extFilter != null && exts[extFilter] && (
                <span className="mr-3 flex items-center gap-1.5 text-ink-2">
                  <Swatch color={extColor(extFilter)} /> Highlighting {extLabel(exts[extFilter].ext)}
                </span>
              )}
              <span className="text-ink-3">Click to select · Double-click to zoom · Right-click for more</span>
            </div>
            <div className="min-h-0 flex-1 bg-panel">
              <Treemap
                data={tmData}
                rootPath={tmPath}
                exts={exts}
                selectedId={selectedId}
                highlightExt={extFilter}
                highlightCategory={categoryFilter}
                onSelect={(id) => (tab === "tree" ? revealInTree(id) : setSelectedId(id))}
                onZoom={(id) => setTmRoot(id)}
                onContextMenu={(id, isDir, e) => openMenu(id, isDir, e.clientX, e.clientY)}
              />
            </div>
          </section>

          {/* Status bar */}
          <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-sep bg-chrome px-4 text-[11.5px] text-ink-2 tabular-nums">
            <span className="min-w-0 flex-1 truncate">{selection?.path ?? ""}</span>
            {selection && (
              <>
                <span>{formatBytes(selection.node.size)}</span>
                {selection.node.isDir && (
                  <span>
                    {formatNumber(selection.node.files)} files · {formatNumber(selection.node.folders)} folders
                  </span>
                )}
                <span>{formatPercent(selection.node.size, rootNode!.size)} of scanned data</span>
              </>
            )}
          </footer>
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Chip({
  label,
  onClear,
  color,
  icon,
}: {
  label: string;
  onClear: () => void;
  color?: string;
  icon?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-accent-soft py-[2px] pl-2 pr-1 text-[11.5px] text-ink">
      {color && <Swatch color={color} />}
      {icon && <Folder size={11} className="text-folder" />}
      <span className="max-w-[260px] truncate">{label}</span>
      <button onClick={onClear} className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-hover">
        <X size={10} />
      </button>
    </span>
  );
}

