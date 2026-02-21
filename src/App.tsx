import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface DriveInfo {
  name: string;
  mount_point: string;
  total_space: number;
  available_space: number;
  used_space: number;
  file_system: string;
}

interface FsEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  item_count: number;
}

interface FolderSize {
  size: number;
  item_count: number;
}

type SortKey = "size" | "name" | "type";

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), 4);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getBreadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  return parts.map((part, i) => {
    const partial = parts.slice(0, i + 1).join("\\");
    return {
      label: part,
      path: i === 0 ? partial + "\\" : partial,
    };
  });
}

function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    exe: "⚙️",  dll: "🔧",  sys: "🔩",
    mp4: "🎬",  avi: "🎬",  mkv: "🎬",  mov: "🎬",
    mp3: "🎵",  wav: "🎵",  flac: "🎵",
    jpg: "🖼️",  jpeg: "🖼️", png: "🖼️",  gif: "🖼️",
    pdf: "📕",  doc: "📝",  docx: "📝",
    xls: "📊",  xlsx: "📊",
    zip: "📦",  rar: "📦",  "7z": "📦",
    js:  "📜",  ts:  "📜",  tsx: "📜",  jsx: "📜",
    txt: "📄",  log: "📄",  md:  "📄",
  };
  return map[ext] ?? "📄";
}

function getExtLabel(name: string, isDir: boolean): string {
  if (isDir) return "Folder";
  const parts = name.split(".");
  if (parts.length < 2) return "File";
  return parts.pop()!.toUpperCase();
}

export default function App() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortAsc, setSortAsc] = useState(false);
  // Which folder paths are still computing their size
  const [sizingPaths, setSizingPaths] = useState<Set<string>>(new Set());
  // Incremented on every navigation so stale async updates are ignored
  const navGen = useRef(0);

  useEffect(() => {
    invoke<DriveInfo[]>("get_drives").then(setDrives).catch(console.error);
  }, []);

  const navigate = useCallback(async (path: string) => {
    const gen = ++navGen.current;

    setLoading(true);
    setError(null);
    setEntries([]);
    setSizingPaths(new Set());

    try {
      // ── Phase 1: fast scan — returns almost instantly ──
      const initial = await invoke<FsEntry[]>("scan_directory_fast", { path });
      if (navGen.current !== gen) return; // user navigated away

      setCurrentPath(path);
      setEntries(initial);
      setLoading(false); // UI is live; user can interact now

      // ── Phase 2: stream folder sizes concurrently ──
      const dirs = initial.filter((e) => e.is_dir);
      if (dirs.length === 0) return;

      setSizingPaths(new Set(dirs.map((d) => d.path)));

      dirs.forEach(async (dir) => {
        try {
          const result = await invoke<FolderSize>("get_folder_size", {
            path: dir.path,
          });
          if (navGen.current !== gen) return; // navigated away while sizing
          setEntries((prev) =>
            prev.map((e) =>
              e.path === dir.path
                ? { ...e, size: result.size, item_count: result.item_count }
                : e
            )
          );
        } catch {
          // Permission denied or similar — leave size as 0
        } finally {
          if (navGen.current === gen) {
            setSizingPaths((prev) => {
              const next = new Set(prev);
              next.delete(dir.path);
              return next;
            });
          }
        }
      });
    } catch (e) {
      if (navGen.current === gen) {
        setError(String(e));
        setLoading(false);
      }
    }
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((a) => !a);
    } else {
      setSortKey(key);
      setSortAsc(key === "name");
    }
  };

  const sortedEntries = [...entries].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "size") cmp = a.size - b.size;
    else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
    else cmp = Number(a.is_dir) - Number(b.is_dir);
    return sortAsc ? cmp : -cmp;
  });

  const maxSize = entries.reduce((m, e) => Math.max(m, e.size), 1);
  const totalSize = entries.reduce((s, e) => s + e.size, 0);
  const crumbs = getBreadcrumbs(currentPath);
  const stillSizing = sizingPaths.size > 0;

  const goUp = () => {
    if (crumbs.length > 1) {
      navigate(crumbs[crumbs.length - 2].path);
    } else {
      navGen.current++;
      setCurrentPath("");
      setEntries([]);
      setError(null);
      setSizingPaths(new Set());
    }
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-title">
          <span className="app-icon">💾</span>
          <h1>Disk Space Analyzer</h1>
        </div>
        <div className="drives-row">
          {drives.map((d) => {
            const pct =
              d.total_space > 0 ? (d.used_space / d.total_space) * 100 : 0;
            const barColor =
              pct > 90 ? "#f85149" : pct > 70 ? "#d29922" : "#58a6ff";
            const isActive = currentPath.startsWith(d.mount_point);
            return (
              <button
                key={d.mount_point}
                className={`drive-card ${isActive ? "active" : ""}`}
                onClick={() => navigate(d.mount_point)}
              >
                <div className="drive-card-top">
                  <span className="drive-name">
                    {d.mount_point.replace(/\\$/, "")}
                  </span>
                  <span className="drive-fs">
                    {d.file_system || d.name || "—"}
                  </span>
                </div>
                <div className="drive-bar-track">
                  <div
                    className="drive-bar-fill"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
                <div className="drive-sizes">
                  <span>{formatSize(d.used_space)} used</span>
                  <span>{formatSize(d.total_space)} total</span>
                </div>
              </button>
            );
          })}
        </div>
      </header>

      {/* ── Breadcrumb ── */}
      {(currentPath || loading) && (
        <nav className="breadcrumb">
          <button
            className="up-btn"
            onClick={goUp}
            disabled={loading}
            title="Go up"
          >
            ↑
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-group">
              {i > 0 && <span className="crumb-sep">\</span>}
              <button
                className={`crumb ${
                  i === crumbs.length - 1 ? "crumb-current" : ""
                }`}
                onClick={() => navigate(c.path)}
                disabled={i === crumbs.length - 1 || loading}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      {/* ── Main content ── */}
      <main className="content">
        {/* Full-screen spinner only during phase 1 (fast scan) */}
        {loading && (
          <div className="overlay">
            <div className="spinner" />
            <p className="scan-msg">
              Reading <code>{currentPath}</code>
            </p>
          </div>
        )}

        {!loading && error && (
          <div className="error-box">⚠️ {error}</div>
        )}

        {!loading && !error && !currentPath && (
          <div className="welcome">
            <div className="welcome-icon">💿</div>
            <p>Select a drive above to start analyzing disk usage.</p>
          </div>
        )}

        {!loading && !error && currentPath && entries.length === 0 && (
          <div className="welcome">
            <p>This directory appears to be empty or inaccessible.</p>
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <table className="file-table">
            <thead>
              <tr>
                <th className="col-icon" />
                <th
                  className="col-name sortable"
                  onClick={() => handleSort("name")}
                >
                  Name{sortArrow("name")}
                </th>
                <th
                  className="col-type sortable"
                  onClick={() => handleSort("type")}
                >
                  Type{sortArrow("type")}
                </th>
                <th
                  className="col-size sortable"
                  onClick={() => handleSort("size")}
                >
                  Size{sortArrow("size")}
                </th>
                <th className="col-bar">Usage</th>
                <th className="col-pct">%</th>
                <th className="col-items">Items</th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => {
                const isSizing =
                  entry.is_dir && sizingPaths.has(entry.path);
                const barPct = (entry.size / maxSize) * 100;
                const pct =
                  totalSize > 0 ? (entry.size / totalSize) * 100 : 0;
                return (
                  <tr
                    key={entry.path}
                    className={`file-row ${
                      entry.is_dir ? "is-dir" : "is-file"
                    }`}
                    onClick={() => entry.is_dir && navigate(entry.path)}
                  >
                    <td className="col-icon">
                      {isSizing ? (
                        <span className="row-spinner" />
                      ) : (
                        getFileIcon(entry.name, entry.is_dir)
                      )}
                    </td>
                    <td className="col-name" title={entry.path}>
                      {entry.name}
                    </td>
                    <td className="col-type">
                      {getExtLabel(entry.name, entry.is_dir)}
                    </td>
                    <td className={`col-size ${isSizing ? "sizing" : ""}`}>
                      {isSizing ? "…" : formatSize(entry.size)}
                    </td>
                    <td className="col-bar">
                      <div className="size-bar">
                        <div
                          className={`size-bar-fill ${
                            entry.is_dir ? "dir" : "file"
                          } ${isSizing ? "pulsing" : ""}`}
                          style={{ width: isSizing ? "100%" : `${barPct}%` }}
                        />
                      </div>
                    </td>
                    <td className="col-pct">
                      {isSizing ? "" : `${pct.toFixed(1)}%`}
                    </td>
                    <td className="col-items">
                      {entry.is_dir
                        ? entry.item_count.toLocaleString()
                        : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>

      {/* ── Status bar ── */}
      <footer className="status-bar">
        {currentPath && !loading && (
          <>
            <span>{sortedEntries.length} items</span>
            <span className="sep">·</span>
            <span>Total: {formatSize(totalSize)}</span>
            {stillSizing && (
              <>
                <span className="sep">·</span>
                <span className="sizing-status">
                  <span className="dot-pulse" />
                  Calculating {sizingPaths.size} folder
                  {sizingPaths.size !== 1 ? "s" : ""}…
                </span>
              </>
            )}
            <span className="sep">·</span>
            <span className="status-path">{currentPath}</span>
          </>
        )}
        {loading && <span>Reading directory…</span>}
        {!currentPath && !loading && <span>Ready</span>}
      </footer>
    </div>
  );
}
