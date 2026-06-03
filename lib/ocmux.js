'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SESSION = 'Opencode';

function _tmux(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error && result.error.code === 'ENOENT') {
    return { status: -1, stdout: '', stderr: 'tmux not found' };
  }
  return result;
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

module.exports = {
  SESSION,
  readState,
  statefileFor,
  tuiPaneId,
  windowByDir,
  windowNameByIndex,
  activeWindowIndex,
  paneCount,
  listServers,
  activateServer,
};
