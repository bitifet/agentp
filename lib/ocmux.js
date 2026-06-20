'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

const SESSION = 'Opencode';
const URL_RE = /opencode server listening on (http:\/\/[^\s]*)/;

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

function tuiPaneId(windowIndex) {
  const r = _tmux(['list-panes', '-t', `${SESSION}:${windowIndex}`, '-F', '#{pane_id}\t#{pane_index}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [paneId, idx] = line.split('\t');
    // Server is always pane 0, TUI is pane 1+
    if (idx !== '0') return paneId;
  }
  return null;
}

function windowByDir(dir) {
  const r = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}\t#{window_name}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [idx, name] = line.split('\t');
    if (name === dir) return parseInt(idx, 10);
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

// Get the URL of the active tmux window (the one currently selected in the Opencode session).
function getActiveServer() {
  const idx = activeWindowIndex();
  if (idx == null) return null;
  const dir = windowNameByIndex(idx);
  if (!dir) return null;
  const sf = statefileFor(dir);
  if (!fs.existsSync(sf)) return null;
  const state = readState(sf);
  return state && state.url ? state.url : null;
}

function paneCount(windowIndex) {
  const r = _tmux(['list-panes', '-t', `${SESSION}:${windowIndex}`, '-F', '#{pane_id}']);
  if (r.status !== 0) return 0;
  return r.stdout.trim().split('\n').filter(Boolean).length;
}

function listServers() {
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
    if (!state || !state.url) continue;
    const tui = tuiPaneId(parseInt(idx, 10));
    rows.push({ url: state.url, dir, index: parseInt(idx, 10), status: tui ? 'alive' : 'dead' });
  }
  return rows;
}

// Switch tmux focus to the given server window and ensure the TUI pane is alive and zoomed.
function activateServer(dir, index, url) {
  const winIdx = index;

  // Pin window name
  _tmux(['set-window-option', '-t', `${SESSION}:${winIdx}`, 'automatic-rename', 'off']);

  // Restart TUI pane if dead
  const tuiPane = tuiPaneId(winIdx);
  if (!tuiPane) {
    const count = paneCount(winIdx);
    if (count >= 2) {
      const panesR = _tmux(['list-panes', '-t', `${SESSION}:${winIdx}`, '-F', '#{pane_id}']);
      if (panesR.status === 0) {
        const panes = panesR.stdout.trim().split('\n').filter(Boolean);
        const lastPane = panes[panes.length - 1];
        const respawnR = _tmux(['respawn-pane', '-k', '-t', lastPane, `opencode attach --continue '${url}'`]);
        if (respawnR.status !== 0) {
          _tmux(['send-keys', '-t', lastPane, `opencode attach --continue '${url}'`, 'Enter']);
        }
      }
    } else {
      _tmux(['split-window', '-v', '-t', `${SESSION}:${winIdx}`, '-c', dir,
        `opencode attach --continue '${url}'`]);
    }
  }

  // Select window
  const activeWin = activeWindowIndex();
  if (activeWin !== null && activeWin !== winIdx) {
    _tmux(['select-window', '-t', `${SESSION}:${winIdx}`]);
  }

  // Zoom TUI pane
  const zoomR = _tmux(['list-windows', '-t', SESSION, '-F', '#{window_index}|#{window_zoomed_flag}']);
  if (zoomR.status === 0) {
    let zoomed = false;
    for (const line of zoomR.stdout.trim().split('\n').filter(Boolean)) {
      const [wi, z] = line.split('|');
      if (parseInt(wi, 10) === winIdx && z === '1') { zoomed = true; break; }
    }
    if (!zoomed) {
      const tui = tuiPaneId(winIdx);
      if (tui) _tmux(['resize-pane', '-Z', '-t', tui]);
    }
  }

  return true;
}

// Recover a dead/crashed server: kill old window, remove state file,
// create fresh server + TUI in the same directory.
// Returns { url, dir } on success, throws on error.
function resurrectServer(dir, printLogs) {
  const sf = path.join(dir, '.ocmux.json');
  const state = readState(sf);

  // Kill old tmux window if it exists
  if (state && state.window_index != null) {
    let winIdx = state.window_index;
    const sessionR = _tmux(['has-session', '-t', SESSION]);
    if (sessionR.status === 0) {
      const actualName = windowNameByIndex(winIdx);
      if (actualName !== dir) {
        const found = windowByDir(dir);
        if (found != null) winIdx = found;
      }
      if (winIdx != null) {
        _tmux(['select-window', '-t', `${SESSION}:${winIdx}`]);
        _tmux(['send-keys', '-t', `${SESSION}:${winIdx}.0`, 'C-c']);
        sleep(0.3);
        _tmux(['kill-window', '-t', `${SESSION}:${winIdx}`]);
      }
    }
  }

  // Remove old state file so we can create a fresh one
  try { fs.unlinkSync(sf); } catch {}

  // Create fresh server + TUI
  ensureSession();
  const lf = logfileFor(dir);

  const rc = _tmux(['new-window', '-d', '-t', SESSION, '-n', dir, '-c', dir]);
  if (rc.status !== 0) throw new Error(`failed to create tmux window for ${dir}`);

  const winIdx = windowByDir(dir);
  if (winIdx == null) throw new Error('window was not created properly');

  pinWindowName(winIdx);

  try { fs.truncateSync(lf); } catch {}

  const serveFlags = printLogs ? '--print-logs' : '';
  _tmux(['send-keys', '-t', `${SESSION}:${winIdx}.0`,
    `opencode serve ${serveFlags} 2>&1 | tee '${lf}'`, 'Enter']);

  let url = null;
  for (let i = 0; i < 50; i++) {
    sleep(0.2);
    const log = (() => { try { return fs.readFileSync(lf, 'utf8'); } catch { return ''; } })();
    const m = log.match(URL_RE);
    if (m) url = m[1];
  }

  if (!url) {
    const wi = windowByDir(dir);
    if (wi != null) _tmux(['kill-window', '-t', `${SESSION}:${wi}`]);
    throw new Error('opencode server did not start within 10 seconds');
  }

  const newState = { url, logfile: lf, window_index: winIdx };
  fs.writeFileSync(sf, JSON.stringify(newState) + '\n');

  const splitResult = _tmux(['split-window', '-v', '-P', '-F', '#{pane_id}', '-t', `${SESSION}:${winIdx}`, '-c', dir]);
  const tuiPane = splitResult.stdout.trim();
  sleep(0.2);
  _tmux(['send-keys', '-t', tuiPane, `opencode attach --continue '${url}'`, 'Enter']);
  sleep(0.5);
  if (tuiPane) _tmux(['resize-pane', '-Z', '-t', tuiPane]);

  const activeWin = activeWindowIndex();
  if (activeWin !== null && activeWin !== winIdx) {
    _tmux(['select-window', '-t', `${SESSION}:${winIdx}`]);
  }

  return { url, dir };
}

module.exports = {
  SESSION,
  URL_RE,
  readState,
  statefileFor,
  tuiPaneId,
  windowByDir,
  windowNameByIndex,
  activeWindowIndex,
  paneCount,
  listServers,
  activateServer,
  getActiveServer,
  hashDir,
  logfileFor,
  sleep,
  ensureSession,
  pinWindowName,
  resurrectServer,
};
