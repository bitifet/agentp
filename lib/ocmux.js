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
  const r = _tmux(['list-panes', '-t', `${SESSION}:${windowIndex}`, '-F', '#{pane_id}\t#{pane_current_command}']);
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [paneId, cmd] = line.split('\t');
    if (cmd === 'node') return paneId;
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

module.exports = {
  SESSION,
  readState,
  statefileFor,
  tuiPaneId,
  windowByDir,
  windowNameByIndex,
  listServers,
};
