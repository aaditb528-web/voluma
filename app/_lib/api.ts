import { invoke } from "@tauri-apps/api/core";

export interface CategorySummary {
  id: number;
  name: string;
  color: string;
  size: number;
  allocated: number;
  files: number;
}

export interface DriveInfo {
  letter: string;
  label: string;
  fileSystem: string;
  kind: string;
  total: number;
  free: number;
  clusterSize: number;
}

export interface NodeInfo {
  id: number;
  parent: number | null;
  name: string;
  size: number;
  allocated: number;
  files: number;
  folders: number;
  modified: number;
  attributes: number;
  isDir: boolean;
  hasChildren: boolean;
  ext: number | null;
  category: number;
}

export interface ExtInfo {
  ext: string;
  size: number;
  allocated: number;
  files: number;
}

export interface FileRow {
  id: number;
  name: string;
  path: string;
  size: number;
  allocated: number;
  modified: number;
  attributes: number;
  ext: number | null;
  category: number;
}

export interface ScanSummary {
  root: NodeInfo;
  drive: DriveInfo;
  scanMs: number;
  method: "MFT" | "Filesystem";
  fallbackReason: string | null;
  categories: CategorySummary[];
}

export interface Progress {
  items: number;
  bytes: number;
  phase: string;
}

/** Compact treemap node: id, name, size, isDir, ext rank, category, children. */
export interface TmNode {
  i: number;
  n: string;
  s: number;
  d: boolean;
  e: number;
  cat: number;
  c?: TmNode[];
}

export const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api = {
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  scanDrive: (letter: string) => invoke<ScanSummary>("scan_drive", { letter }),
  getChildren: (id: number) => invoke<NodeInfo[]>("get_children", { id }),
  getNode: (id: number) => invoke<NodeInfo>("get_node", { id }),
  getPath: (id: number) => invoke<string>("get_path", { id }),
  getAncestors: (id: number) => invoke<number[]>("get_ancestors", { id }),
  getExtensions: () => invoke<ExtInfo[]>("get_extensions"),
  getCategories: () => invoke<CategorySummary[]>("get_categories"),
  getFiles: (args: { query?: string; ext?: number; category?: number; under?: number; limit?: number }) =>
    invoke<FileRow[]>("get_files", args),
  getTreemap: (id: number, maxNodes: number) =>
    invoke<TmNode>("get_treemap", { id, maxNodes }),
  reveal: (id: number) => invoke<void>("reveal_in_explorer", { id }),
  restartAsAdmin: () => invoke<void>("restart_as_admin"),
};
