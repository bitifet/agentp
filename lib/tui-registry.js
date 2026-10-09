'use strict';

// Runtime registry for user-placed OpenCode TUI panes. This is deliberately
// separate from `.ocmux.json`: pane IDs, tmux sockets and wrapper PIDs are
// ephemeral machine state, while project files hold durable routing state.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

const REGISTRY_VERSION = 1;
const PANE_ID_OPTION = '@ocmux_tui_id';
const PANE_TOKEN_OPTION = '@ocmux_tui_token';

function runtimeDir() {
  if (process.env.OCMUX_RUNTIME_DIR) return path.resolve(process.env.OCMUX_RUNTIME_DIR);
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'agentp');
  return path.join(os.tmpdir(), `agentp-${process.getuid ? process.getuid() : 'user'}`);
}

function registryPath() {
  return path.join(runtimeDir(), 'ocmux-tuis.json');
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: {}, projects: {}, shared: null };
}

function normalizeRegistry(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    version: REGISTRY_VERSION,
    instances: input.instances && typeof input.instances === 'object' && !Array.isArray(input.instances)
      ? input.instances : {},
    projects: input.projects && typeof input.projects === 'object' && !Array.isArray(input.projects)
      ? input.projects : {},
    shared: typeof input.shared === 'string' ? input.shared : null,
  };
}

function readRegistry() {
  try {
    return normalizeRegistry(JSON.parse(fs.readFileSync(registryPath(), 'utf8')));
  } catch {
    return emptyRegistry();
  }
}

function ensureRuntimeDir() {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir(), 0o700); } catch {}
}

function writeRegistry(registry) {
  ensureRuntimeDir();
  const file = registryPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeRegistry(registry)) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}

function sleepMs(ms) {
  // Atomics.wait gives us a dependency-free synchronous sleep for the very
  // short critical section around registry updates.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRegistryLock(fn) {
  ensureRuntimeDir();
  const lock = registryPath() + '.lock';
  let fd = null;
  for (let i = 0; i < 50; i++) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 10000) fs.unlinkSync(lock);
      } catch {}
      sleepMs(20);
    }
  }
  if (fd === null) throw new Error('timed out waiting for the TUI registry lock');
  try {
    const registry = readRegistry();
    const result = fn(registry);
    writeRegistry(registry);
    return result;
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

function parseTmuxEnvironment(env = process.env) {
  const pane = env.TMUX_PANE;
  const raw = env.TMUX;
  if (!pane || !/^%\d+$/.test(pane) || !raw) return null;
  const socket = raw.split(',')[0];
  if (!socket) return null;
  return { socket, pane };
}

function tmux(instance, args) {
  const prefix = instance && instance.socket ? ['-S', instance.socket] : [];
  return child_process.spawnSync('tmux', [...prefix, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function paneMetadata(instance) {
  if (!instance || !instance.socket || !instance.pane) return null;
  const result = tmux(instance, [
    'display-message', '-p', '-t', instance.pane,
    `#{pane_dead}\t#{${PANE_ID_OPTION}}\t#{${PANE_TOKEN_OPTION}}\t#{pane_pid}`,
  ]);
  if (result.status !== 0) return null;
  const [dead, id, token, pid] = result.stdout.trim().split('\t');
  return { dead: dead === '1', id, token, pid: Number(pid) || null };
}

function isLive(instance) {
  const metadata = paneMetadata(instance);
  return !!(metadata && !metadata.dead
    && metadata.id === instance.id
    && metadata.token === instance.token);
}

function markPane(instance) {
  const first = tmux(instance, ['set-option', '-p', '-t', instance.pane, PANE_ID_OPTION, instance.id]);
  if (first.status !== 0) throw new Error(`failed to mark tmux pane ${instance.pane}`);
  const second = tmux(instance, ['set-option', '-p', '-t', instance.pane, PANE_TOKEN_OPTION, instance.token]);
  if (second.status !== 0) throw new Error(`failed to mark tmux pane ${instance.pane}`);
}

function clearPane(instance) {
  if (!isLive(instance)) return;
  tmux(instance, ['set-option', '-pu', '-t', instance.pane, PANE_ID_OPTION]);
  tmux(instance, ['set-option', '-pu', '-t', instance.pane, PANE_TOKEN_OPTION]);
}

function randomID(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function removeInstance(registry, id) {
  if (!id || !registry.instances[id]) return null;
  const removed = registry.instances[id];
  delete registry.instances[id];
  for (const [directory, value] of Object.entries(registry.projects)) {
    if (value === id) delete registry.projects[directory];
  }
  if (registry.shared === id) registry.shared = null;
  return removed;
}

function register({ socket, pane, shared, directory, server, session, pid }) {
  const now = Date.now();
  const instance = {
    id: randomID('tui'),
    token: randomID('token'),
    socket,
    pane,
    shared: !!shared,
    directory: directory ? path.resolve(directory) : null,
    server: server || null,
    session: session || null,
    pid: Number(pid) || process.pid,
    registeredAt: now,
    updatedAt: now,
  };
  const displaced = withRegistryLock((registry) => {
    const oldID = shared ? registry.shared : registry.projects[instance.directory];
    const old = oldID ? registry.instances[oldID] : null;
    // Verify and interrupt the old foreground TUI while its token still owns
    // its pane. C-c preserves the pane and avoids treating a reusable PID as
    // durable identity.
    // Marking the replacement first would make that verification impossible.
    const samePane = old && old.socket === instance.socket && old.pane === instance.pane;
    if (old && !samePane && isLive(old)) tmux(old, ['send-keys', '-t', old.pane, 'C-c']);
    markPane(instance);
    if (oldID) removeInstance(registry, oldID);
    // A pane can change between dedicated and shared mode. Remove its prior
    // assignment so one physical pane never occupies two registry slots.
    for (const [id, current] of Object.entries(registry.instances)) {
      if (current.socket === instance.socket && current.pane === instance.pane) {
        removeInstance(registry, id);
      }
    }
    registry.instances[instance.id] = instance;
    if (shared) registry.shared = instance.id;
    else registry.projects[instance.directory] = instance.id;
    return old;
  });
  return { instance, displaced };
}

function unregister(id, token) {
  let removed = null;
  withRegistryLock((registry) => {
    const current = registry.instances[id];
    if (!current || current.token !== token) return;
    removed = removeInstance(registry, id);
  });
  if (removed) clearPane(removed);
  return !!removed;
}

function updateInstance(id, token, patch) {
  let updated = null;
  withRegistryLock((registry) => {
    const current = registry.instances[id];
    if (!current || current.token !== token) return;
    Object.assign(current, patch, { updatedAt: Date.now() });
    updated = { ...current };
  });
  return updated;
}

function pruneDead() {
  const dead = [];
  withRegistryLock((registry) => {
    for (const [id, instance] of Object.entries(registry.instances)) {
      if (!isLive(instance)) {
        dead.push(instance);
        removeInstance(registry, id);
      }
    }
  });
  return dead;
}

function resolve(directory) {
  const canonical = directory ? path.resolve(directory) : null;
  const registry = readRegistry();
  const projectID = canonical ? registry.projects[canonical] : null;
  const project = projectID ? registry.instances[projectID] : null;
  if (project && isLive(project)) return { instance: project, kind: 'project' };
  const shared = registry.shared ? registry.instances[registry.shared] : null;
  if (shared && isLive(shared)) return { instance: shared, kind: 'shared' };
  return null;
}

function dedicated(directory) {
  const canonical = directory ? path.resolve(directory) : null;
  if (!canonical) return null;
  pruneDead();
  const registry = readRegistry();
  return registry.projects[canonical] ? registry.instances[registry.projects[canonical]] || null : null;
}

function shared() {
  pruneDead();
  const registry = readRegistry();
  return registry.shared ? registry.instances[registry.shared] || null : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function respawn(instance, { executable, directory, server, session }) {
  if (!isLive(instance)) return { ok: false, error: 'registered TUI pane is no longer available' };
  const args = [shellQuote(executable), 'tui'];
  if (instance.shared) args.push('--shared');
  args.push('--server', shellQuote(server), '--session-id', shellQuote(session), '--', shellQuote(directory));
  const result = tmux(instance, [
    'respawn-pane', '-k', '-t', instance.pane, '-c', directory, args.join(' '),
  ]);
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `failed to respawn ${instance.pane}` };
  }
  return { ok: true };
}

function list() {
  pruneDead();
  const registry = readRegistry();
  return Object.values(registry.instances);
}

module.exports = {
  REGISTRY_VERSION,
  PANE_ID_OPTION,
  PANE_TOKEN_OPTION,
  runtimeDir,
  registryPath,
  emptyRegistry,
  normalizeRegistry,
  readRegistry,
  writeRegistry,
  parseTmuxEnvironment,
  paneMetadata,
  isLive,
  markPane,
  clearPane,
  register,
  unregister,
  updateInstance,
  pruneDead,
  resolve,
  dedicated,
  shared,
  respawn,
  list,
  shellQuote,
};
