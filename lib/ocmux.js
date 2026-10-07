'use strict';

// tmux helpers for the agentp v2 model ("sessions live in projects").
//
// A project owns a tmux window (TUI only — pane 0) plus a `.ocmux.json` state
// file recording the target session. The OpenCode **server is user-managed**
// (started with `opencode serve`); this module never starts or stops it. All
// tmux interactions must go through `_tmux()`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

const SESSION = 'Opencode';

function _tmux(args) {
  const result = child_process.spawnSync('tmux', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error && result.error.code === 'ENOENT') {
    return { status: -1, stdout: '', stderr: 'tmux not found' };
  }
  return result;
}

function hashDir(dir) {
  return crypto.createHash('md5').update(dir).digest('hex').slice(0, 12);
}

function logfileFor(dir) {
  return `/tmp/opencode-serve-${hashDir(dir)}.log`;
}

function sleep(seconds) {
  child_process.execSync(`sleep ${seconds}`, { stdio: 'ignore' });
}

function ensureSession() {
  const r = _tmux(['has-session', '-t', SESSION]);
  if (r.status !== 0) {
    _tmux(['new-session', '-d', '-s', SESSION]);
  }
}

function pinWindowName(windowIndex) {
  _tmux(['set-window-option', '-t', `${SESSION}:${windowIndex}`, 'automatic-rename', 'off']);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statefileFor(dir) {
  return path.join(dir, '.ocmux.json');
}

// Return the pane ID running the TUI in `windowIndex`, or null when the window
// has no TUI. v2 layout: the TUI is the only pane (pane 0). Legacy layout
// (transition only): pane 0 is a server and the TUI is a non-zero pane; the
// last pane is used as the fallback.
function tuiPaneId(windowIndex) {
  const r = _tmux(['list-panes', '-t', `${SESSION}:${windowIndex}`, '-F', '#{pane_id}\t#{pane_index}']);
  if (r.status !== 0) return null;
  const panes = r.stdout.trim().split('\n').filter(Boolean);
  if (panes.length === 0) return null;
  if (panes.length === 1) return panes[0].split('\t')[0];
  // Legacy layout with a server pane — assume the last pane is the TUI.
  return panes[panes.length - 1].split('\t')[0];
}

function windowByDir(dir) {
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { realDir = dir; }
  const r = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}\t#{window_name}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [idx, name] = line.split('\t');
    if (name === dir) return parseInt(idx, 10);
    try {
      if (fs.realpathSync(name) === realDir) return parseInt(idx, 10);
    } catch {}
  }
  return null;
}

function windowNameByIndex(idx) {
  const r = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}\t#{window_name}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [wi, name] = line.split('\t');
    if (parseInt(wi, 10) === idx) return name;
  }
  return null;
}

function activeWindowIndex() {
  const r = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index} #{window_active}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [idx, active] = line.split(' ');
    if (active === '1') return parseInt(idx, 10);
  }
  return null;
}

function paneCount(windowIndex) {
  const r = _tmux(['list-panes', '-t', `${SESSION}:${windowIndex}`, '-F', '#{pane_id}']);
  if (r.status !== 0) return 0;
  return r.stdout.trim().split('\n').filter(Boolean).length;
}

// List project windows: every tmux window whose name is a directory holding a
// `.ocmux.json`. Status derives from TUI pane liveness.
function listProjects() {
  const sessionR = _tmux(['has-session', '-t', SESSION]);
  if (sessionR.status !== 0) return [];

  const listR = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}\t#{window_name}']);
  if (listR.status !== 0 || !listR.stdout.trim()) return [];

  const rows = [];
  for (const line of listR.stdout.trim().split('\n').filter(Boolean)) {
    const [idx, dir] = line.split('\t');
    const sf = statefileFor(dir);
    if (!fs.existsSync(sf)) continue;
    const state = readState(sf);
    if (!state) continue;
    const winIdx = parseInt(idx, 10);
    rows.push({
      dir,
      index: winIdx,
      status: tuiPaneId(winIdx) != null ? 'alive' : 'dead',
      session: state.session || null,
      server: state.server || state.url || null,
    });
  }
  return rows;
}

function isWindowZoomed(windowIndex) {
  const r = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}|#{window_zoomed_flag}']);
  if (r.status !== 0) return false;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [wi, z] = line.split('|');
    if (parseInt(wi, 10) === windowIndex && z === '1') return true;
  }
  return false;
}

// v2-only TUI launch command. `sessionId` may be null to continue the last one.
function tuiAttachCommand(url, sessionId) {
  if (sessionId) return `opencode --server '${url}' --session '${sessionId}'`;
  return `opencode --server '${url}' --continue`;
}

function zoomPane(paneId) {
  if (paneId) _tmux(['resize-pane', '-Z', '-t', paneId]);
}

// Focus a project window, restarting its TUI when dead (or opening it for the
// first time). Reads nothing from disk — the caller supplies server/session.
function activateProject(dir, index, server, session) {
  const winIdx = index;
  pinWindowName(winIdx);

  let tuiPane = tuiPaneId(winIdx);
  if (!tuiPane) {
    const cmd = tuiAttachCommand(server, session);
    const count = paneCount(winIdx);
    if (count >= 1) {
      const panesR = _tmux(['list-panes', '-t', `${SESSION}:${winIdx}`, '-F', '#{pane_id}']);
      const panes = panesR.status === 0 ? panesR.stdout.trim().split('\n').filter(Boolean) : [];
      const lastPane = panes[panes.length - 1];
      if (lastPane) {
        const respawnR = _tmux(['respawn-pane', '-k', '-t', lastPane, cmd]);
        if (respawnR.status !== 0) _tmux(['send-keys', '-t', lastPane, cmd, 'Enter']);
      }
    } else {
      _tmux(['send-keys', '-t', `${SESSION}:${winIdx}.0`, cmd, 'Enter']);
    }
  }

  const activeWin = activeWindowIndex();
  if (activeWin !== null && activeWin !== winIdx) {
    _tmux(['select-window', '-t', `${SESSION}:${winIdx}`]);
  }

  if (!isWindowZoomed(winIdx)) {
    tuiPane = tuiPaneId(winIdx);
    zoomPane(tuiPane);
  }

  return true;
}

// Create a project TUI window (v2 layout: TUI is pane 0, no server pane).
// Writes the v2 state file. The server must already be reachable.
function createProjectWindow(dir, url, session) {
  try { dir = fs.realpathSync(dir); } catch {}
  ensureSession();

  const newWinR = _tmux(['new-window', '-d', '-P', '-F', '#{window_index}', '-t', SESSION, '-n', dir, '-c', dir]);
  if (newWinR.status !== 0) throw new Error(`failed to create tmux window for ${dir}`);
  let winIdx = parseInt(newWinR.stdout.trim(), 10);
  if (isNaN(winIdx)) {
    winIdx = windowByDir(dir);
    if (winIdx == null) throw new Error('could not determine new window index');
  }

  pinWindowName(winIdx);

  const cmd = tuiAttachCommand(url, session);
  _tmux(['send-keys', '-t', `${SESSION}:${winIdx}.0`, cmd, 'Enter']);
  sleep(0.5);
  const tuiPane = tuiPaneId(winIdx);
  zoomPane(tuiPane);

  const activeWin = activeWindowIndex();
  if (activeWin !== null && activeWin !== winIdx) {
    _tmux(['select-window', '-t', `${SESSION}:${winIdx}`]);
  }

  const stateFile = path.join(dir, '.ocmux.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const state = { ...existing, version: 2, directory: dir, session: session || existing.session || null, server: url };
  fs.writeFileSync(stateFile, JSON.stringify(state) + '\n');

  return { url, dir, index: winIdx };
}

// Point an existing project window's TUI at `session` by relaunching the TUI
// process (OpenCode v2 exposes no HTTP TUI-steering endpoint).
function relaunchTui(windowIndex, dir, server, session) {
  const cmd = tuiAttachCommand(server, session);
  const tuiPane = tuiPaneId(windowIndex);
  if (tuiPane) {
    const respawnR = _tmux(['respawn-pane', '-k', '-t', tuiPane, cmd]);
    if (respawnR.status !== 0) _tmux(['send-keys', '-t', tuiPane, cmd, 'Enter']);
  } else {
    _tmux(['send-keys', '-t', `${SESSION}:${windowIndex}.0`, cmd, 'Enter']);
  }
  sleep(0.4);
  // Keep the project's own window active (switching sessions must not leave
  // another project's window selected).
  const active = activeWindowIndex();
  if (active !== null && active !== windowIndex) {
    _tmux(['select-window', '-t', `${SESSION}:${windowIndex}`]);
  }
  const pane = tuiPaneId(windowIndex);
  if (pane && !isWindowZoomed(windowIndex)) zoomPane(pane);
}

// Focus the tmux window belonging to a project directory (best-effort). Used by
// agentp so the target project's TUI window is the one shown when a prompt runs.
// Returns the window index, or null when the directory has no window.
function focusWindowByDir(dir) {
  const idx = windowByDir(dir);
  if (idx == null) return null;
  const activeWin = activeWindowIndex();
  if (activeWin !== null && activeWin !== idx) {
    _tmux(['select-window', '-t', `${SESSION}:${idx}`]);
  }
  const pane = tuiPaneId(idx);
  if (pane && !isWindowZoomed(idx)) zoomPane(pane);
  return idx;
}

// Close a project's tmux window (no server to stop in the v2 model).
function closeProjectWindow(windowIndex) {
  const r = _tmux(['kill-window', '-t', `${SESSION}:${windowIndex}`]);
  if (r.status !== 0) throw new Error(`failed to kill window ${windowIndex}: ${r.stderr || 'unknown error'}`);
}

module.exports = {
  SESSION,
  readState,
  statefileFor,
  tuiPaneId,
  windowByDir,
  windowNameByIndex,
  activeWindowIndex,
  paneCount,
  listProjects,
  activateProject,
  relaunchTui,
  focusWindowByDir,
  closeProjectWindow,
  createProjectWindow,
  hashDir,
  logfileFor,
  sleep,
  ensureSession,
  pinWindowName,
  tuiAttachCommand,
  isWindowZoomed,
};