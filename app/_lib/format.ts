// Formatting, colors and file-type metadata shared across the UI.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number, digits = 1): string {
  if (!bytes || bytes < 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

const numberFmt = new Intl.NumberFormat();
export const formatNumber = (n: number) => numberFmt.format(n);

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const formatDate = (ms: number) => (ms > 0 ? dateFmt.format(new Date(ms)) : "—");

export function formatPercent(part: number, whole: number): string {
  if (!whole) return "0 %";
  const p = (part / whole) * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(1) : p.toFixed(p < 0.1 ? 2 : 1)} %`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// Windows file attribute flags -> WizTree-style letters.
const ATTRS: [number, string, string][] = [
  [0x1, "R", "Read-only"],
  [0x2, "H", "Hidden"],
  [0x4, "S", "System"],
  [0x20, "A", "Archive"],
  [0x100, "T", "Temporary"],
  [0x200, "P", "Sparse"],
  [0x400, "L", "Reparse point"],
  [0x800, "C", "Compressed"],
  [0x1000, "O", "Offline"],
  [0x4000, "E", "Encrypted"],
];
export const formatAttributes = (a: number) =>
  ATTRS.filter(([f]) => a & f).map(([, l]) => l).join("");
export const describeAttributes = (a: number) =>
  ATTRS.filter(([f]) => a & f).map(([, , d]) => d).join(", ");
export const isHiddenOrSystem = (a: number) => (a & 0x6) !== 0;

// ---------------------------------------------------------------------------
// Colors: macOS system palette first, then evenly spread hues.
// ---------------------------------------------------------------------------

const PALETTE = [
  "#0A84FF", "#FF9F0A", "#30D158", "#BF5AF2", "#FF375F", "#64D2FF",
  "#FFD60A", "#5E5CE6", "#FF453A", "#66D4CF", "#AC8E68", "#40C8E0",
  "#FF6482", "#A2D729", "#DA8FFF", "#FFB340",
];

export function extColor(rank: number | null | undefined): string {
  if (rank == null || rank < 0) return "#8E8E93";
  if (rank < PALETTE.length) return PALETTE[rank];
  const hue = (rank * 137.508) % 360;
  return `hsl(${hue.toFixed(0)} 42% 56%)`;
}

// ---------------------------------------------------------------------------
// File type names
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  "": "No extension",
  exe: "Application", dll: "Application extension", sys: "System file",
  msi: "Windows Installer package", msp: "Windows Installer patch", cab: "Cabinet file",
  mui: "Language resource", efi: "EFI application", drv: "Device driver", ocx: "ActiveX control",
  winmd: "Windows metadata", cat: "Security catalog", mum: "Update manifest",
  manifest: "Manifest", pdb: "Program debug database", lib: "Object library", obj: "Object file",
  node: "Node.js native module", so: "Shared object", lnk: "Shortcut", ini: "Configuration settings",
  cfg: "Configuration file", tmp: "Temporary file", log: "Log file", etl: "Event trace log",
  evtx: "Event log", blf: "Log container", regtrans_ms: "Registry transaction", pf: "Prefetch data",
  dat: "Data file", db: "Database", sqlite: "SQLite database", edb: "Extensible storage database",
  bin: "Binary file", pak: "Game package", ucas: "Unreal container", utoc: "Unreal table of contents",
  bnk: "Sound bank", vpk: "Valve package", ttf: "TrueType font", otf: "OpenType font",
  ttc: "TrueType collection", zip: "Compressed (zipped) folder", "7z": "7-Zip archive",
  rar: "RAR archive", gz: "GZip archive", tar: "Tape archive", iso: "Disc image",
  img: "Disk image", vhd: "Virtual hard disk", vhdx: "Virtual hard disk", vmdk: "VMware disk",
  wim: "Windows image", esd: "Windows image (compressed)", appx: "App package", msix: "App package",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", webp: "WebP image",
  bmp: "Bitmap image", ico: "Icon", svg: "SVG image", heic: "HEIC image", psd: "Photoshop document",
  raw: "Raw image", mp4: "MP4 video", mkv: "Matroska video", mov: "QuickTime movie", avi: "AVI video",
  webm: "WebM video", wmv: "Windows Media video", mp3: "MP3 audio", wav: "WAV audio",
  flac: "FLAC audio", m4a: "MPEG-4 audio", ogg: "Ogg audio", aac: "AAC audio",
  pdf: "PDF document", doc: "Word document", docx: "Word document", xls: "Excel workbook",
  xlsx: "Excel workbook", ppt: "PowerPoint presentation", pptx: "PowerPoint presentation",
  txt: "Text document", md: "Markdown document", rtf: "Rich text document", csv: "CSV file",
  epub: "EPUB book", js: "JavaScript file", mjs: "JavaScript module", cjs: "JavaScript module",
  ts: "TypeScript file", tsx: "TypeScript JSX file", jsx: "JSX file", map: "Source map",
  json: "JSON file", xml: "XML document", html: "HTML document", htm: "HTML document",
  css: "Stylesheet", py: "Python file", pyc: "Compiled Python file", pyd: "Python extension",
  rs: "Rust source", go: "Go source", java: "Java source", class: "Java class", jar: "Java archive",
  c: "C source", cpp: "C++ source", h: "Header file", hpp: "C++ header", cs: "C# source",
  yml: "YAML file", yaml: "YAML file", toml: "TOML file", lock: "Lock file", wasm: "WebAssembly",
  rlib: "Rust library", rmeta: "Rust metadata", a: "Static library", o: "Object file",
  gguf: "GGUF model", safetensors: "Safetensors model", onnx: "ONNX model", pt: "PyTorch model",
  pth: "PyTorch model", ckpt: "Model checkpoint", nupkg: "NuGet package", apk: "Android package",
  vdi: "VirtualBox disk", ova: "Virtual appliance", hdmp: "Heap dump", dmp: "Memory dump",
};

export function extTypeName(ext: string): string {
  return TYPE_NAMES[ext.replace(/-/g, "_")] ?? `${ext.toUpperCase()} file`;
}

export const extLabel = (ext: string) => (ext ? `.${ext}` : "(none)");

// ---------------------------------------------------------------------------
// Storage categories for the overview bar.
// ---------------------------------------------------------------------------

export interface Category {
  name: string;
  color: string;
  exts: Set<string>;
}

const cat = (name: string, color: string, list: string) => ({
  name,
  color,
  exts: new Set(list.split(" ")),
});

export const CATEGORIES: Category[] = [
  cat("Apps", "#0A84FF",
    "exe dll sys msi msp cab mui efi drv ocx winmd cat mum manifest node so appx msix lnk"),
  cat("Media", "#FF9F0A",
    "png jpg jpeg gif webp bmp ico svg heic psd raw mp4 mkv mov avi webm wmv mp3 wav flac m4a ogg aac"),
  cat("Documents", "#30D158", "pdf doc docx xls xlsx ppt pptx txt md rtf csv epub odt ods"),
  cat("Archives & Disk Images", "#BF5AF2",
    "zip 7z rar gz tar iso img vhd vhdx vmdk wim esd vdi ova xz zst"),
  cat("Developer", "#64D2FF",
    "js mjs cjs ts tsx jsx map json xml html htm css py pyc pyd rs go java class jar c cpp h hpp cs yml yaml toml lock wasm pdb lib obj rlib rmeta a o nupkg"),
  cat("Games", "#FF375F", "pak ucas utoc bnk vpk"),
  cat("AI Models", "#5E5CE6", "gguf safetensors onnx pt pth ckpt"),
];
export const OTHER_COLOR = "#A2845E";
export const SYSTEM_COLOR = "#475569";
export const SYSTEM_UNREADABLE_COLOR = "#94A3B8";

export const CATEGORY_COLORS: Record<number, string> = {
  0: "#475569", // System (Slate 600)
  1: "#FF375F", // Games (Red)
  2: "#64D2FF", // Developer (Sky Blue)
  3: "#5E5CE6", // AI Models (Indigo)
  4: "#0A84FF", // Apps (Blue)
  5: "#FF9F0A", // Media (Orange)
  6: "#BF5AF2", // Archives & Disk Images (Purple)
  7: "#30D158", // Documents (Green)
  8: "#A2845E", // Other Files (Warm Sand)
};

export function categoryColor(cat: number | null | undefined): string {
  if (cat == null) return "#A2845E";
  return CATEGORY_COLORS[cat] ?? "#A2845E";
}

export const CATEGORY_NAMES: Record<number, string> = {
  0: "System",
  1: "Games",
  2: "Developer",
  3: "AI Models",
  4: "Apps",
  5: "Media",
  6: "Archives & Disk Images",
  7: "Documents",
  8: "Other Files",
};

