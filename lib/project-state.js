'use strict';

// Project/session state for the agentp v2 model ("sessions live in projects").
//
// A project is a directory that owns a `.ocmux.json` state file recording the
// target session ID (and optionally the server URL). This module is the single
// place that reads/writes that file so `agentp`, `ocmux` and `tgagentp` agree
// on the schema and its legacy migration rules.

const fs = require('fs');
const path = require('path');

const STATE_BASENAME = '.ocmux.json';
const ANNOTATIONS_BASENAME = 'annotations.json';

// Unit-test escape hatch: disable all filesystem discovery so CLI behavior is
// deterministic regardless of where the test process happens to run.
function discoveryDisabled() {
  const v = process.env.AGENTP_NO_STATE;
  return v === '1' || v === 'true';
}

function statefileFor(dir) {
  return path.join(dir, STATE_BASENAME);
}

// Walk upward from startDir looking for `.ocmux.json`. Returns the absolute
// file path or null. Never throws.
function findStatefile(startDir) {
  if (discoveryDisabled()) return null;
  let dir = path.resolve(startDir == null ? process.cwd() : startDir);
  for (;;) {
    const candidate = statefileFor(dir);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not a file — keep walking upward
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Normalize a parsed state object (v2 or legacy) into the canonical shape.
// `statefile` is used as the fallback directory when `directory` is missing.
function normalizeState(raw, statefile) {
  const fileDir = path.dirname(statefile);
  const state = raw && typeof raw === 'object' ? raw : {};
  const directory =
    typeof state.directory === 'string' && state.directory && path.isAbsolute(state.directory)
      ? state.directory
      : fileDir;
  const session = typeof state.session === 'string' && state.session ? state.session : null;
  const server =
    (typeof state.server === 'string' && state.server) ||
    (typeof state.url === 'string' && state.url) ||
    null;
  const status = typeof state.status === 'string' && state.status ? state.status : null;
  const annotations = state.annotations && typeof state.annotations === 'object' && !Array.isArray(state.annotations)
    ? state.annotations
    : {};
  return {
    file: statefile,
    version: typeof state.version === 'number' ? state.version : 1,
    directory,
    session,
    server,
    status,
    annotations,
  };
}

// Read + normalize a state file. Returns null when the file is missing/invalid.
function readProjectState(statefile) {
  if (!statefile) return null;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(statefile, 'utf8'));
  } catch {
    return null;
  }
  return normalizeState(raw, statefile);
}

// Read the state of the project containing `startDir` (upward search).
function readProject(startDir) {
  const sf = findStatefile(startDir);
  return sf ? readProjectState(sf) : null;
}

// Atomic merge-write of a v2 state file. `patch` may carry directory, session
// and/or server. Returns the normalized new state.
function writeProjectState(statefile, patch) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(statefile, 'utf8'));
  } catch {
    // start fresh
  }
  const next = {
    ...existing,
    version: 2,
    directory:
      patch.directory !== undefined
        ? patch.directory
        : existing.directory || path.dirname(statefile),
  };
  if (patch.session !== undefined) next.session = patch.session;
  if (patch.server !== undefined) next.server = patch.server;
  if (patch.status !== undefined) next.status = patch.status;
  const tmp = statefile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n');
  fs.renameSync(tmp, statefile);
  return normalizeState(next, statefile);
}

// Resolve the project context for `startDir`:
//   { statefile, state, directory, session, server }
// All fields are null when no state file applies, so callers fall back to their
// existing (pre-v2) behavior seamlessly.
function resolveContext({ startDir, statefile } = {}) {
  const sf = statefile !== undefined ? statefile : findStatefile(startDir);
  if (!sf) {
    return { statefile: null, state: null, directory: null, session: null, server: null };
  }
  const state = readProjectState(sf);
  if (!state) {
    return { statefile: sf, state: null, directory: null, session: null, server: null };
  }
  return {
    statefile: sf,
    state,
    directory: state.directory,
    session: state.session,
    server: state.server,
  };
}

// ── Per-session reminders (annotations) ────────────────────────────
// Stored as an `annotations` map (sessionID → text) INSIDE `.ocmux.json`, so a
// project keeps all of its state in one file. `agentp` prepends the reminder to
// every prompt sent to that session. Empty text removes the entry.
//
// (Older versions used a separate `annotations.json` sidecar; it is still read
// for back-compat and removed on the next write.)

function annotationsPath(statefile) {
  return path.join(path.dirname(statefile), ANNOTATIONS_BASENAME);
}

function readStateRaw(statefile) {
  try {
    const raw = JSON.parse(fs.readFileSync(statefile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function readAnnotations(statefile) {
  const raw = readStateRaw(statefile);
  if (raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations)) {
    return raw.annotations;
  }
  // Back-compat: legacy sidecar.
  try {
    const legacy = JSON.parse(fs.readFileSync(annotationsPath(statefile), 'utf8'));
    if (legacy && typeof legacy === 'object') return legacy;
  } catch {}
  return {};
}

// Returns the saved text, or null when removed.
function writeAnnotation(statefile, sessionId, text) {
  const raw = readStateRaw(statefile);
  const all = (raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations))
    ? { ...raw.annotations }
    : readAnnotations(statefile);
  if (text) all[sessionId] = text;
  else delete all[sessionId];
  raw.annotations = all;
  raw.version = 2;
  if (!raw.directory) raw.directory = path.dirname(statefile);
  const tmp = statefile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw) + '\n');
  fs.renameSync(tmp, statefile);
  // Drop the legacy sidecar now that the data lives in the state file.
  try { fs.unlinkSync(annotationsPath(statefile)); } catch {}
  return text || null;
}

module.exports = {
  STATE_BASENAME,
  statefileFor,
  findStatefile,
  normalizeState,
  readProjectState,
  readProject,
  writeProjectState,
  resolveContext,
  annotationsPath,
  readAnnotations,
  writeAnnotation,
};