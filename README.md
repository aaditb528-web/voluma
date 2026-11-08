# Voluma

A modern, minimalist disk analyzer for Windows built with Rust and Tauri.

<img width="2560" height="1599" alt="image" src="https://github.com/user-attachments/assets/cbd11613-c43e-4c3d-bf17-999478ca1eb6" />


## Why Voluma?
Tools like WizTree and WinDirStat are incredibly fast, but their interfaces are stuck in the past. Voluma was built to answer a simple question: **What if we had WizTree's performance, but with the clean, minimalist aesthetic of macOS?**

## Features
- **Incredibly Fast:** Reads the NTFS Master File Table (MFT) directly, scans complete in seconds (depends on your cpu, it finished in 4.26 seconds on a 275HX and 15.14 seconds on a i7-1265U).
- **macOS-Style UI:** Deep dark mode, clean segmented storage bar, and smooth virtualized tables.
- **Accurate Physical Allocation:** Differentiates between logical file size and true on-disk allocated size (handling sparse files, compression, and hardlinks).
- **Path-Based Categorization:** Intelligently categorizes space into Games, Developer, Apps, and System using path rules, not just file extensions.
- **Interactive Treemap:** Canvas-rendered squarified treemap with breadcrumbs and hover tooltips.

## Installation
Download the latest `.exe` installer from the [Releases page](https://github.com/aaditb528-web/voluma/releases).

**Note:** Because this is an unsigned indie app, Windows SmartScreen might show a warning. Just click "More info" and then "Run anyway". Voluma requires Administrator privileges to read the raw disk.

## Tech Stack
- **Backend:** Rust (Tauri), `ntfs-mft` for raw disk parsing
- **Frontend:** React, TypeScript, Tailwind CSS, D3-hierarchy
- **Architecture:** In-memory Rust index with lazy-loaded frontend data fetching
