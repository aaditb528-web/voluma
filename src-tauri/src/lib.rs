//! Voluma backend: scans a drive (raw NTFS MFT when elevated, regular
//! filesystem walk otherwise), keeps the resulting tree in memory and serves
//! it to the UI in small, lazily requested pieces.

use ntfs_mft::{RawMftScanOptions, Volume};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

const NONE: u32 = u32::MAX;
const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_REPARSE_POINT: u32 = 0x400;
/// Offset between the Windows FILETIME epoch (1601) and Unix epoch, in 100ns units.
const FILETIME_UNIX_OFFSET: i64 = 116_444_736_000_000_000;

// ---------------------------------------------------------------------------
// Category Classification
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CategoryId {
    System = 0,
    Games = 1,
    Developer = 2,
    AiModels = 3,
    Apps = 4,
    Media = 5,
    Archives = 6,
    Documents = 7,
    Other = 8,
}

pub struct PathRule {
    pub pattern: &'static str,
    pub category: CategoryId,
}

/// Extensible table of path patterns for classification.
/// Checked in the specified order: Games -> Developer -> Apps.
/// System paths are anchored to the drive root in classify_file.
pub const PATH_RULES: &[PathRule] = &[
    // b. Games paths
    PathRule { pattern: r"\steamapps\", category: CategoryId::Games },
    PathRule { pattern: r"\steamapps", category: CategoryId::Games },
    PathRule { pattern: r"\xboxgames\", category: CategoryId::Games },
    PathRule { pattern: r"\xboxgames", category: CategoryId::Games },
    PathRule { pattern: r"\epic games\", category: CategoryId::Games },
    PathRule { pattern: r"\epic games", category: CategoryId::Games },
    PathRule { pattern: r"\gog games\", category: CategoryId::Games },
    PathRule { pattern: r"\gog games", category: CategoryId::Games },
    PathRule { pattern: r"\gog galaxy\games\", category: CategoryId::Games },
    PathRule { pattern: r"\gog galaxy\games", category: CategoryId::Games },
    PathRule { pattern: r"\riot games\", category: CategoryId::Games },
    PathRule { pattern: r"\riot games", category: CategoryId::Games },

    // c. Developer paths
    PathRule { pattern: r"\node_modules\", category: CategoryId::Developer },
    PathRule { pattern: r"\node_modules", category: CategoryId::Developer },
    PathRule { pattern: r"\target\", category: CategoryId::Developer },
    PathRule { pattern: r"\target", category: CategoryId::Developer },
    PathRule { pattern: r"\.cargo\", category: CategoryId::Developer },
    PathRule { pattern: r"\.cargo", category: CategoryId::Developer },
    PathRule { pattern: r"\.rustup\", category: CategoryId::Developer },
    PathRule { pattern: r"\.rustup", category: CategoryId::Developer },
    PathRule { pattern: r"\.git\", category: CategoryId::Developer },
    PathRule { pattern: r"\.git", category: CategoryId::Developer },
    PathRule { pattern: r"\.next\", category: CategoryId::Developer },
    PathRule { pattern: r"\.next", category: CategoryId::Developer },
    PathRule { pattern: r"\__pycache__\", category: CategoryId::Developer },
    PathRule { pattern: r"\__pycache__", category: CategoryId::Developer },
    PathRule { pattern: r"\venv\", category: CategoryId::Developer },
    PathRule { pattern: r"\venv", category: CategoryId::Developer },
    PathRule { pattern: r"\.venv\", category: CategoryId::Developer },
    PathRule { pattern: r"\.venv", category: CategoryId::Developer },

    // e. Apps paths
    PathRule { pattern: r"\program files\", category: CategoryId::Apps },
    PathRule { pattern: r"\program files", category: CategoryId::Apps },
    PathRule { pattern: r"\program files (x86)\", category: CategoryId::Apps },
    PathRule { pattern: r"\program files (x86)", category: CategoryId::Apps },
    PathRule { pattern: r"\programdata\", category: CategoryId::Apps },
    PathRule { pattern: r"\programdata", category: CategoryId::Apps },
    PathRule { pattern: r"\appdata\", category: CategoryId::Apps },
    PathRule { pattern: r"\appdata", category: CategoryId::Apps },
];

pub const SYSTEM_FILES: &[&str] = &[
    "pagefile.sys", "hiberfil.sys", "swapfile.sys", "dumpstack.log",
    "$mft", "$logfile", "$volume", "$bitmap", "$boot", "$badclus",
    "$secure", "$upcase", "$attrdef", "$mftmirr",
];

pub const AI_EXTS: &[&str] = &["gguf", "safetensors", "onnx", "pt", "ckpt", "pth"];
pub const MEDIA_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "heic", "psd", "raw",
    "mp4", "mkv", "mov", "avi", "webm", "wmv", "mp3", "wav", "flac", "m4a", "ogg", "aac",
];
pub const ARCHIVE_EXTS: &[&str] = &[
    "zip", "7z", "rar", "gz", "tar", "iso", "img", "vhd", "vhdx", "vmdk", "wim", "esd",
    "vdi", "ova", "xz", "zst",
];
pub const DOC_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "csv",
    "epub", "odt", "ods",
];

pub const CATEGORY_INFO: &[(CategoryId, &str, &str)] = &[
    (CategoryId::System, "System", "#475569"),
    (CategoryId::Games, "Games", "#FF375F"),
    (CategoryId::Developer, "Developer", "#64D2FF"),
    (CategoryId::AiModels, "AI Models", "#5E5CE6"),
    (CategoryId::Apps, "Apps", "#0A84FF"),
    (CategoryId::Media, "Media", "#FF9F0A"),
    (CategoryId::Archives, "Archives & Disk Images", "#BF5AF2"),
    (CategoryId::Documents, "Documents", "#30D158"),
    (CategoryId::Other, "Other Files", "#A2845E"),
];

/// Classify a file by path first, then by extension.
/// First match wins according to rules a-g.
fn classify_file(lower_path: &str, lower_name: &str, ext: &str, is_root: bool) -> CategoryId {
    // a. System rule: MUST be anchored to the drive root!
    // Strip drive letter if present (e.g. "c:\windows\..." -> "\windows\...")
    let rel = if lower_path.len() >= 2 && lower_path.as_bytes()[1] == b':' {
        &lower_path[2..]
    } else {
        lower_path
    };

    // Files in the root of the drive (e.g. pagefile.sys, $MFT, swapfile.sys, etc.)
    if is_root && (SYSTEM_FILES.contains(&lower_name) || lower_name.starts_with('$')) {
        return CategoryId::System;
    }

    // Anchored System directories starting from the drive root
    if rel.starts_with(r"\windows\") || rel == r"\windows"
        || rel.starts_with(r"\recovery\") || rel == r"\recovery"
        || rel.starts_with(r"\system volume information\") || rel == r"\system volume information"
        || rel.starts_with(r"\$recycle.bin\") || rel == r"\$recycle.bin"
        || rel.starts_with(r"\$extend\") || rel == r"\$extend"
    {
        return CategoryId::System;
    }

    // b. Games rule
    for rule in PATH_RULES {
        if rule.category == CategoryId::Games && lower_path.contains(rule.pattern) {
            return CategoryId::Games;
        }
    }

    // c. Developer rule
    for rule in PATH_RULES {
        if rule.category == CategoryId::Developer && lower_path.contains(rule.pattern) {
            return CategoryId::Developer;
        }
    }

    // d. AI Models rule (by extension)
    if AI_EXTS.contains(&ext) {
        return CategoryId::AiModels;
    }

    // e. Apps rule
    for rule in PATH_RULES {
        if rule.category == CategoryId::Apps && lower_path.contains(rule.pattern) {
            return CategoryId::Apps;
        }
    }

    // f. Media, Archives & Disk Images, Documents (by extension)
    if MEDIA_EXTS.contains(&ext) {
        return CategoryId::Media;
    }
    if ARCHIVE_EXTS.contains(&ext) {
        return CategoryId::Archives;
    }
    if DOC_EXTS.contains(&ext) {
        return CategoryId::Documents;
    }

    // g. Everything else
    CategoryId::Other
}

// ---------------------------------------------------------------------------
// In-memory model
// ---------------------------------------------------------------------------

struct Node {
    name: Box<str>,
    parent: u32,
    children: Vec<u32>,
    size: u64,
    alloc: u64,
    files: u32,
    folders: u32,
    modified: i64,
    attrs: u32,
    is_dir: bool,
    /// Rank of this file's extension in `ScanData::exts` (NONE for folders).
    ext: u32,
    /// Category id (0..8)
    category: u8,
}

impl Node {
    fn new(name: impl Into<Box<str>>, parent: u32, is_dir: bool) -> Self {
        Node {
            name: name.into(),
            parent,
            children: Vec::new(),
            size: 0,
            alloc: 0,
            files: 0,
            folders: 0,
            modified: 0,
            attrs: 0,
            is_dir,
            ext: NONE,
            category: CategoryId::Other as u8,
        }
    }
}

struct ExtAgg {
    ext: String,
    size: u64,
    alloc: u64,
    files: u64,
}

struct ScanData {
    nodes: Vec<Node>,
    reached: Vec<bool>,
    exts: Vec<ExtAgg>,
    categories: Vec<CategorySummary>,
}

#[derive(Default)]
struct AppState {
    data: Arc<Mutex<Option<ScanData>>>,
}

// ---------------------------------------------------------------------------
// DTOs sent to the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CategorySummary {
    pub id: u8,
    pub name: String,
    pub color: String,
    pub size: u64,
    pub allocated: u64,
    pub files: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DriveInfo {
    letter: String,
    label: String,
    file_system: String,
    kind: String,
    total: u64,
    free: u64,
    cluster_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeInfo {
    id: u32,
    parent: Option<u32>,
    name: String,
    size: u64,
    allocated: u64,
    files: u32,
    folders: u32,
    modified: i64,
    attributes: u32,
    is_dir: bool,
    has_children: bool,
    ext: Option<u32>,
    category: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtInfo {
    ext: String,
    size: u64,
    allocated: u64,
    files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRow {
    id: u32,
    name: String,
    path: String,
    size: u64,
    allocated: u64,
    modified: i64,
    attributes: u32,
    ext: Option<u32>,
    category: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    root: NodeInfo,
    drive: DriveInfo,
    scan_ms: u64,
    method: String,
    fallback_reason: Option<String>,
    categories: Vec<CategorySummary>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    items: u64,
    bytes: u64,
    phase: String,
}

/// Compact treemap node (short keys keep the payload small).
#[derive(Serialize)]
struct TmNode {
    /// Node id, or -1 for an aggregate of small items.
    i: i64,
    n: String,
    s: u64,
    d: bool,
    /// Extension rank, -1 for none/folder, -2 for aggregate.
    e: i64,
    /// Category id
    cat: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<Vec<TmNode>>,
}

// ---------------------------------------------------------------------------
// Drive information (Win32)
// ---------------------------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn drive_info(letter: char) -> Option<DriveInfo> {
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetVolumeInformationW,
    };
    use windows::core::PCWSTR;

    let root = wide(&format!("{letter}:\\"));
    let root_ptr = PCWSTR(root.as_ptr());
    unsafe {
        let kind = match GetDriveTypeW(root_ptr) {
            2 => "Removable",
            3 => "Local Disk",
            4 => "Network",
            5 => "CD-ROM",
            6 => "RAM Disk",
            _ => return None,
        };
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        let _ = GetVolumeInformationW(root_ptr, Some(&mut label), None, None, None, Some(&mut fs));

        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        if GetDiskFreeSpaceExW(root_ptr, Some(&mut avail), Some(&mut total), Some(&mut free)).is_err() {
            return None;
        }
        let (mut spc, mut bps) = (0u32, 0u32);
        let cluster = if GetDiskFreeSpaceW(root_ptr, Some(&mut spc), Some(&mut bps), None, None).is_ok() {
            spc as u64 * bps as u64
        } else {
            4096
        };

        Some(DriveInfo {
            letter: letter.to_string(),
            label: from_wide(&label),
            file_system: from_wide(&fs),
            kind: kind.to_string(),
            total,
            free,
            cluster_size: cluster.max(512),
        })
    }
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| drive_info((b'A' + i) as char))
        .collect()
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

struct Reporter<'a> {
    app: &'a AppHandle,
    last: Instant,
    phase: &'static str,
}

impl<'a> Reporter<'a> {
    fn new(app: &'a AppHandle, phase: &'static str) -> Self {
        Reporter { app, last: Instant::now(), phase }
    }
    fn tick(&mut self, items: u64, bytes: u64) {
        if self.last.elapsed().as_millis() >= 150 {
            self.last = Instant::now();
            let _ = self.app.emit(
                "scan-progress",
                Progress { items, bytes, phase: self.phase.to_string() },
            );
        }
    }
}

/// Fast path: read the NTFS Master File Table directly (requires admin).
fn scan_mft(app: &AppHandle, letter: char) -> Result<Vec<Node>, String> {
    let volume = Volume::from_drive_letter(letter).map_err(|e| format!("{e}"))?;
    let mft = volume.raw_mft().map_err(|e| format!("{e}"))?;
    // Collect alternate data streams to account for WOF compressed data, etc.
    let options = RawMftScanOptions::builder()
        .start_record(0)
        .collect_alternate_data_streams(true)
        .build();
    let entries = mft.scan_entries_with_options(options).map_err(|e| format!("{e}"))?;

    let mut nodes = vec![Node::new(format!("{letter}:"), NONE, true)];
    let mut index: HashMap<u64, u32> = HashMap::with_capacity(mft.record_count() as usize);
    let mut parent_records: Vec<u64> = vec![0];
    index.insert(5, 0);

    let mut reporter = Reporter::new(app, "Reading Master File Table");
    let mut bytes = 0u64;
    for item in entries {
        let entry = match item {
            Ok(e) => e,
            Err(e) if nodes.len() < 2 => return Err(format!("{e}")),
            Err(_) => break,
        };
        // Record 5 is the root directory itself.
        if entry.record_number == 5 {
            nodes[0].modified = entry.si_modified.to_unix_millis();
            nodes[0].attrs = entry.si_file_attributes.bits();
            continue;
        }
        if entry.file_name.is_empty() {
            continue;
        }
        // Record 8 is $BadClus whose $Bad stream is sized to the entire volume.
        // We must skip $BadClus entirely.
        if entry.record_number == 8 || entry.file_name.to_string_lossy().eq_ignore_ascii_case("$BadClus") {
            continue;
        }
        let is_dir = entry.is_directory;
        let mut node = Node::new(entry.file_name.to_string_lossy(), NONE, is_dir);
        if !is_dir {
            node.size = entry.real_size;
            // Resident files allocate 0 bytes outside the MFT record itself
            let mut alloc = if entry.is_resident {
                0
            } else {
                entry.allocated_size
            };
            // Add non-resident alternate data streams (including WOF compressed data),
            // but only add an ADS's allocation when it isn't sparse.
            for ads in entry.alternate_data_streams.iter() {
                if !ads.is_resident && !ads.is_sparse {
                    alloc += ads.allocated_size;
                }
            }
            node.alloc = alloc;
            bytes += entry.real_size;
        }
        node.modified = entry.si_modified.to_unix_millis();
        node.attrs = entry.si_file_attributes.bits();

        index.insert(entry.record_number, nodes.len() as u32);
        parent_records.push(entry.parent_reference.record_number());
        nodes.push(node);
        reporter.tick(nodes.len() as u64, bytes);
    }

    for i in 1..nodes.len() {
        let parent = index.get(&parent_records[i]).copied().unwrap_or(0);
        nodes[i].parent = if parent as usize == i { 0 } else { parent };
    }
    Ok(nodes)
}

/// Fallback helper to query the real on-disk compressed or sparse allocated size.
fn get_file_allocation(path: &Path, len: u64, cluster: u64) -> u64 {
    use windows::Win32::Storage::FileSystem::GetCompressedFileSizeW;
    use windows::core::PCWSTR;

    let path_str = path.to_string_lossy();
    let wide_path = wide(&path_str);
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(wide_path.as_ptr()), Some(&mut high)) };
    if low != u32::MAX || unsafe { windows::Win32::Foundation::GetLastError() }.is_ok() {
        let comp_size = ((high as u64) << 32) | (low as u64);
        if comp_size == 0 {
            0
        } else {
            comp_size.div_ceil(cluster) * cluster
        }
    } else if len == 0 {
        0
    } else {
        len.div_ceil(cluster) * cluster
    }
}

/// Slow path: walk the filesystem with regular APIs (works without admin).
fn scan_fs(app: &AppHandle, letter: char, cluster: u64) -> Vec<Node> {
    use std::os::windows::fs::MetadataExt;

    let mut nodes = vec![Node::new(format!("{letter}:"), NONE, true)];
    let mut stack: Vec<(PathBuf, u32)> = vec![(PathBuf::from(format!("{letter}:\\")), 0)];
    let mut reporter = Reporter::new(app, "Scanning folders");
    let mut bytes = 0u64;

    while let Some((path, parent)) = stack.pop() {
        let Ok(dir) = std::fs::read_dir(&path) else { continue };
        for entry in dir.flatten() {
            let Ok(md) = entry.metadata() else { continue };
            let attrs = md.file_attributes();
            let is_dir = md.is_dir() || attrs & ATTR_DIRECTORY != 0;
            let mut node = Node::new(entry.file_name().to_string_lossy().as_ref(), parent, is_dir);
            node.attrs = attrs;
            let ft = md.last_write_time() as i64;
            node.modified = if ft > 0 { (ft - FILETIME_UNIX_OFFSET) / 10_000 } else { 0 };
            if !is_dir {
                node.size = md.len();
                node.alloc = get_file_allocation(&entry.path(), md.len(), cluster);
                bytes += node.size;
            }
            let id = nodes.len() as u32;
            nodes.push(node);
            // Never follow junctions / symlinks: they would double count.
            if is_dir && attrs & ATTR_REPARSE_POINT == 0 {
                stack.push((entry.path(), id));
            }
        }
        reporter.tick(nodes.len() as u64, bytes);
    }
    nodes
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(pos) if pos > 0 && pos + 1 < name.len() => name[pos + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Link children, roll sizes/counts up the tree, classify nodes, and aggregate extensions and categories.
fn finalize(mut nodes: Vec<Node>) -> ScanData {
    let n = nodes.len();
    for i in 1..n {
        let mut p = nodes[i].parent;
        if p == NONE || p as usize >= n || !nodes[p as usize].is_dir {
            p = 0;
            nodes[i].parent = 0;
        }
        nodes[p as usize].children.push(i as u32);
    }

    // Pre-order walk from the root (unreachable cycles are simply ignored).
    let mut reached = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut stack = vec![0u32];
    while let Some(id) = stack.pop() {
        if reached[id as usize] {
            continue;
        }
        reached[id as usize] = true;
        order.push(id);
        stack.extend(nodes[id as usize].children.iter().copied());
    }

    // Pre-compute lowercased paths for classification in pre-order
    let mut paths: Vec<String> = vec![String::new(); n];
    paths[0] = nodes[0].name.to_lowercase();
    for &id in &order {
        let id_u = id as usize;
        if id != 0 {
            let p_u = nodes[id_u].parent as usize;
            paths[id_u] = format!("{}\\{}", paths[p_u], nodes[id_u].name.to_lowercase());
        }
        let ext = extension_of(&nodes[id_u].name);
        let is_root = nodes[id_u].parent == 0;
        let cat = classify_file(&paths[id_u], &nodes[id_u].name.to_lowercase(), &ext, is_root);
        nodes[id_u].category = cat as u8;
    }
    // Drop paths vector to reclaim memory
    drop(paths);

    // Extensions (temporary ids, re-ranked by size below).
    let mut ext_ids: HashMap<String, u32> = HashMap::new();
    let mut exts: Vec<ExtAgg> = Vec::new();
    for &id in &order {
        let node = &mut nodes[id as usize];
        if node.is_dir {
            continue;
        }
        let ext = extension_of(&node.name);
        let eid = *ext_ids.entry(ext.clone()).or_insert_with(|| {
            exts.push(ExtAgg { ext, size: 0, alloc: 0, files: 0 });
            (exts.len() - 1) as u32
        });
        let agg = &mut exts[eid as usize];
        agg.size += node.size;
        agg.alloc += node.alloc;
        agg.files += 1;
        node.ext = eid;
    }
    let mut ranking: Vec<u32> = (0..exts.len() as u32).collect();
    ranking.sort_by_key(|&i| Reverse(exts[i as usize].size));
    let mut rank_of = vec![0u32; exts.len()];
    for (rank, &i) in ranking.iter().enumerate() {
        rank_of[i as usize] = rank as u32;
    }
    for node in nodes.iter_mut().filter(|n| n.ext != NONE) {
        node.ext = rank_of[node.ext as usize];
    }
    let mut slots: Vec<Option<ExtAgg>> = exts.into_iter().map(Some).collect();
    let exts: Vec<ExtAgg> = ranking.iter().map(|&i| slots[i as usize].take().unwrap()).collect();

    // Aggregate category totals
    let mut cat_sizes = [0u64; 9];
    let mut cat_allocs = [0u64; 9];
    let mut cat_counts = [0u64; 9];
    for &id in &order {
        let node = &nodes[id as usize];
        if !node.is_dir {
            let c = (node.category as usize).min(8);
            cat_sizes[c] += node.size;
            cat_allocs[c] += node.alloc;
            cat_counts[c] += 1;
        }
    }
    let categories: Vec<CategorySummary> = CATEGORY_INFO
        .iter()
        .map(|(cat_id, name, color)| {
            let idx = *cat_id as usize;
            CategorySummary {
                id: idx as u8,
                name: name.to_string(),
                color: color.to_string(),
                size: cat_sizes[idx],
                allocated: cat_allocs[idx],
                files: cat_counts[idx],
            }
        })
        .collect();

    // Bottom-up roll-up.
    for &id in order.iter().rev() {
        let id = id as usize;
        if !nodes[id].is_dir {
            continue;
        }
        let (mut size, mut alloc, mut files, mut folders) = (0u64, 0u64, 0u32, 0u32);
        let mut cat_sizes = [0u64; 9];
        for &c in &nodes[id].children {
            let c = &nodes[c as usize];
            size += c.size;
            alloc += c.alloc;
            let cat_idx = (c.category as usize).min(8);
            cat_sizes[cat_idx] += c.size;
            if c.is_dir {
                files += c.files;
                folders += c.folders + 1;
            } else {
                files += 1;
            }
        }
        let node = &mut nodes[id];
        node.size = size;
        node.alloc = alloc;
        node.files = files;
        node.folders = folders;
        // If directory was not classified by an explicit path rule (is Other), inherit dominant child category
        if node.category == CategoryId::Other as u8 {
            let mut dominant = CategoryId::Other as u8;
            let mut max_sz = 0u64;
            for (ci, &csz) in cat_sizes.iter().enumerate() {
                if csz > max_sz {
                    max_sz = csz;
                    dominant = ci as u8;
                }
            }
            node.category = dominant;
        }
    }

    // Children sorted by size, largest first.
    for i in 0..n {
        let mut kids = std::mem::take(&mut nodes[i].children);
        kids.sort_by_key(|&c| Reverse(nodes[c as usize].size));
        nodes[i].children = kids;
    }

    ScanData { nodes, reached, exts, categories }
}

fn node_info(data: &ScanData, id: u32) -> NodeInfo {
    let n = &data.nodes[id as usize];
    NodeInfo {
        id,
        parent: (n.parent != NONE).then_some(n.parent),
        name: n.name.to_string(),
        size: n.size,
        allocated: n.alloc,
        files: n.files,
        folders: n.folders,
        modified: n.modified,
        attributes: n.attrs,
        is_dir: n.is_dir,
        has_children: !n.children.is_empty(),
        ext: (n.ext != NONE).then_some(n.ext),
        category: n.category,
    }
}

fn path_of(data: &ScanData, id: u32) -> String {
    let mut parts = Vec::new();
    let mut cur = id;
    while cur != NONE && parts.len() < 512 {
        let n = &data.nodes[cur as usize];
        parts.push(n.name.as_ref());
        cur = n.parent;
    }
    parts.reverse();
    if parts.len() == 1 {
        return format!("{}\\", parts[0]);
    }
    parts.join("\\")
}

#[tauri::command]
async fn scan_drive(
    app: AppHandle,
    state: State<'_, AppState>,
    letter: String,
) -> Result<ScanSummary, String> {
    let letter = letter
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .ok_or("Invalid drive letter")?
        .to_ascii_uppercase();
    let drive = drive_info(letter).ok_or_else(|| format!("Drive {letter}: is not available"))?;
    let slot = state.data.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let (nodes, method, fallback_reason) = match scan_mft(&app, letter) {
            Ok(nodes) => (nodes, "MFT", None),
            Err(e) => (scan_fs(&app, letter, drive.cluster_size), "Filesystem", Some(e)),
        };
        let _ = app.emit(
            "scan-progress",
            Progress { items: nodes.len() as u64, bytes: 0, phase: "Building index".into() },
        );
        let data = finalize(nodes);

        // Guard: check if total allocated exceeds volume used + 5%
        let used_space = drive.total.saturating_sub(drive.free);
        let threshold = used_space.saturating_add(used_space * 5 / 100);
        if data.nodes[0].alloc > threshold {
            log::warn!(
                "Total allocated size ({} bytes) exceeds volume used + 5% ({} bytes). Top 10 offenders:",
                data.nodes[0].alloc,
                threshold
            );
            let mut top_offenders: Vec<(u32, u64)> = data
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| !n.is_dir)
                .map(|(i, n)| (i as u32, n.alloc))
                .collect();
            top_offenders.sort_by_key(|&(_, alloc)| Reverse(alloc));
            for (rank, &(id, alloc)) in top_offenders.iter().take(10).enumerate() {
                let p = path_of(&data, id);
                log::warn!("  #{:02}: {} -> {} bytes allocated", rank + 1, p, alloc);
            }
        }

        let summary = ScanSummary {
            root: node_info(&data, 0),
            drive,
            scan_ms: started.elapsed().as_millis() as u64,
            method: method.to_string(),
            fallback_reason,
            categories: data.categories.clone(),
        };
        *slot.lock().map_err(|e| e.to_string())? = Some(data);
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `f` against the current scan, or fail if nothing has been scanned yet.
fn with_data<T>(state: &State<'_, AppState>, f: impl FnOnce(&ScanData) -> T) -> Result<T, String> {
    let guard = state.data.lock().map_err(|e| e.to_string())?;
    let data = guard.as_ref().ok_or("No scan data. Run a scan first.")?;
    Ok(f(data))
}

fn check_id(data: &ScanData, id: u32) -> Result<(), String> {
    if (id as usize) < data.nodes.len() { Ok(()) } else { Err(format!("Unknown node {id}")) }
}

#[tauri::command]
fn get_children(state: State<'_, AppState>, id: u32) -> Result<Vec<NodeInfo>, String> {
    with_data(&state, |d| {
        check_id(d, id)?;
        Ok(d.nodes[id as usize].children.iter().map(|&c| node_info(d, c)).collect())
    })?
}

#[tauri::command]
fn get_node(state: State<'_, AppState>, id: u32) -> Result<NodeInfo, String> {
    with_data(&state, |d| check_id(d, id).map(|_| node_info(d, id)))?
}

#[tauri::command]
fn get_path(state: State<'_, AppState>, id: u32) -> Result<String, String> {
    with_data(&state, |d| check_id(d, id).map(|_| path_of(d, id)))?
}

/// Ids from the root down to (and including) `id`.
#[tauri::command]
fn get_ancestors(state: State<'_, AppState>, id: u32) -> Result<Vec<u32>, String> {
    with_data(&state, |d| {
        check_id(d, id)?;
        let mut chain = Vec::new();
        let mut cur = id;
        while cur != NONE && chain.len() < 512 {
            chain.push(cur);
            cur = d.nodes[cur as usize].parent;
        }
        chain.reverse();
        Ok(chain)
    })?
}

#[tauri::command]
fn get_extensions(state: State<'_, AppState>) -> Result<Vec<ExtInfo>, String> {
    with_data(&state, |d| {
        d.exts
            .iter()
            .map(|e| ExtInfo { ext: e.ext.clone(), size: e.size, allocated: e.alloc, files: e.files })
            .collect()
    })
}

#[tauri::command]
fn get_categories(state: State<'_, AppState>) -> Result<Vec<CategorySummary>, String> {
    with_data(&state, |d| d.categories.clone())
}

/// Largest files, optionally filtered by name, extension rank, category, and subtree.
#[tauri::command]
fn get_files(
    state: State<'_, AppState>,
    query: Option<String>,
    ext: Option<u32>,
    category: Option<u8>,
    under: Option<u32>,
    limit: Option<usize>,
) -> Result<Vec<FileRow>, String> {
    let limit = limit.unwrap_or(1000).clamp(1, 20_000);
    let query = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    with_data(&state, |d| {
        let under = under.filter(|&u| u != 0 && (u as usize) < d.nodes.len());
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::with_capacity(limit + 1);
        for (i, n) in d.nodes.iter().enumerate() {
            if n.is_dir || !d.reached[i] {
                continue;
            }
            if ext.is_some_and(|e| e != n.ext) {
                continue;
            }
            if category.is_some_and(|c| c != n.category) {
                continue;
            }
            if heap.len() >= limit && heap.peek().is_some_and(|Reverse((s, _))| n.size <= *s) {
                continue;
            }
            if let Some(q) = &query {
                if !n.name.to_lowercase().contains(q.as_str()) {
                    continue;
                }
            }
            if let Some(u) = under {
                let mut cur = n.parent;
                let mut inside = false;
                while cur != NONE {
                    if cur == u {
                        inside = true;
                        break;
                    }
                    cur = d.nodes[cur as usize].parent;
                }
                if !inside {
                    continue;
                }
            }
            heap.push(Reverse((n.size, i as u32)));
            if heap.len() > limit {
                heap.pop();
            }
        }
        let mut ids: Vec<(u64, u32)> = heap.into_iter().map(|Reverse(x)| x).collect();
        ids.sort_by_key(|&(s, _)| Reverse(s));
        ids.into_iter()
            .map(|(_, id)| {
                let n = &d.nodes[id as usize];
                FileRow {
                    id,
                    name: n.name.to_string(),
                    path: path_of(d, id),
                    size: n.size,
                    allocated: n.alloc,
                    modified: n.modified,
                    attributes: n.attrs,
                    ext: (n.ext != NONE).then_some(n.ext),
                    category: n.category,
                }
            })
            .collect()
    })
}

/// A size-bounded slice of the tree for the treemap: the largest folders are
/// expanded first until `max_nodes` is reached; tiny items are aggregated.
#[tauri::command]
fn get_treemap(state: State<'_, AppState>, id: u32, max_nodes: Option<usize>) -> Result<TmNode, String> {
    let max_nodes = max_nodes.unwrap_or(12_000).clamp(100, 60_000);
    with_data(&state, |d| {
        check_id(d, id)?;
        let total = d.nodes[id as usize].size.max(1);
        let min_size = total / 150_000;
        let mut expanded: HashSet<u32> = HashSet::new();
        let mut heap: BinaryHeap<(u64, u32)> = BinaryHeap::new();
        heap.push((total, id));
        let mut count = 1usize;
        while let Some((_, dir)) = heap.pop() {
            if count >= max_nodes {
                break;
            }
            let node = &d.nodes[dir as usize];
            if !node.is_dir || node.children.is_empty() {
                continue;
            }
            expanded.insert(dir);
            for &c in &node.children {
                let child = &d.nodes[c as usize];
                if child.size < min_size.max(1) {
                    break; // children are sorted by size
                }
                count += 1;
                if child.is_dir {
                    heap.push((child.size, c));
                }
            }
            count += 1; // aggregate slot
        }

        fn build(d: &ScanData, id: u32, expanded: &HashSet<u32>, min_size: u64) -> TmNode {
            let n = &d.nodes[id as usize];
            let children = expanded.contains(&id).then(|| {
                let mut out = Vec::new();
                let (mut rest, mut rest_count) = (0u64, 0usize);
                for &c in &n.children {
                    let child = &d.nodes[c as usize];
                    if child.size == 0 {
                        break;
                    }
                    if child.size < min_size.max(1) {
                        rest += child.size;
                        rest_count += 1;
                    } else {
                        out.push(build(d, c, expanded, min_size));
                    }
                }
                if rest > 0 {
                    out.push(TmNode {
                        i: -1,
                        n: format!("{rest_count} small items"),
                        s: rest,
                        d: false,
                        e: -2,
                        cat: n.category,
                        c: None,
                    });
                }
                out
            });
            TmNode {
                i: id as i64,
                n: n.name.to_string(),
                s: n.size,
                d: n.is_dir,
                e: if n.ext == NONE { -1 } else { n.ext as i64 },
                cat: n.category,
                c: children,
            }
        }
        Ok(build(d, id, &expanded, min_size))
    })?
}

#[tauri::command]
fn reveal_in_explorer(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let path = with_data(&state, |d| check_id(d, id).map(|_| path_of(d, id)))??;
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Relaunch the app elevated so the fast MFT scanner can be used.
#[tauri::command]
fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.display().to_string().replace('\'', "''");
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Start-Process -FilePath '{exe}' -Verb RunAs")])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err("Elevation was cancelled".into()) })?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_drives,
            scan_drive,
            get_children,
            get_node,
            get_path,
            get_ancestors,
            get_extensions,
            get_categories,
            get_files,
            get_treemap,
            reveal_in_explorer,
            restart_as_admin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
