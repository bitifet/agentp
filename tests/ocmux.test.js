'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const ocmux = require('../lib/ocmux');

// ── Mock infrastructure for spawnSync (tmux) ───────────────────────
let tmuxHandler = null;       // (args, opts) => { status, stdout, stderr }
let spawnSyncCalls = [];

function mockSpawnSync(cmd, args, opts) {
  spawnSyncCalls.push({ cmd, args });
  if (cmd === 'tmux' && tmuxHandler) {
    const result = tmuxHandler(args, opts);
    if (result) return result;
  }
  return { status: 0, stdout: '', stderr: '' };
}

// ── Mock infrastructure for execSync (sleep) ───────────────────────
let execSyncCalled = false;

function mockExecSync() { execSyncCalled = true; }

// ── Mock infrastructure for fs ─────────────────────────────────────
let mockFiles = {};           // path → content

function mockReadFileSync(p, encoding) {
  if (mockFiles[p] !== undefined) return mockFiles[p];
  const err = new Error(`ENOENT: ${p}`);
  err.code = 'ENOENT';
  throw err;
}

function mockExistsSync(p) { return mockFiles[p] !== undefined; }

let fsWrites = [];            // { path, data }

function mockWriteFileSync(p, data) { fsWrites.push({ path: p, data }); }

let fsUnlinks = [];

function mockUnlinkSync(p) { fsUnlinks.push(p); }

let fsTruncates = [];

function mockTruncateSync(p) { fsTruncates.push(p); }

function setupMocks() {
  tmuxHandler = null;
  spawnSyncCalls = [];
  execSyncCalled = false;
  mockFiles = {};
  fsWrites = [];
  fsUnlinks = [];
  fsTruncates = [];

  nodeMock.method(child_process, 'spawnSync', mockSpawnSync);
  nodeMock.method(child_process, 'execSync', mockExecSync);
  nodeMock.method(fs, 'readFileSync', mockReadFileSync);
  nodeMock.method(fs, 'existsSync', mockExistsSync);
  nodeMock.method(fs, 'writeFileSync', mockWriteFileSync);
  nodeMock.method(fs, 'unlinkSync', mockUnlinkSync);
  nodeMock.method(fs, 'truncateSync', mockTruncateSync);
}

function tearDownMocks() {
  nodeMock.restoreAll();
  tmuxHandler = null;
  spawnSyncCalls = [];
  execSyncCalled = false;
  mockFiles = {};
  fsWrites = [];
  fsUnlinks = [];
  fsTruncates = [];
}

// Helper: create a tmux return value
function tmuxOk(stdout) {
  return { status: 0, stdout: stdout || '', stderr: '' };
}

function tmuxFail(status) {
  return { status: status || 1, stdout: '', stderr: 'error' };
}

// ───────────────────────────────────────────────────────────────────
// Pure functions — no mocks needed
// ───────────────────────────────────────────────────────────────────
describe('hashDir', () => {
  it('returns first 12 hex chars of MD5', () => {
    const h = ocmux.hashDir('/home/proj');
    assert.strictEqual(h.length, 12);
    assert.match(h, /^[0-9a-f]{12}$/);
  });

  it('is deterministic for same input', () => {
    assert.strictEqual(ocmux.hashDir('/home/proj'), ocmux.hashDir('/home/proj'));
  });

  it('differs for different inputs', () => {
    assert.notStrictEqual(ocmux.hashDir('/a'), ocmux.hashDir('/b'));
  });
});

describe('logfileFor', () => {
  it('builds path with hash', () => {
    const p = ocmux.logfileFor('/my/proj');
    assert.ok(p.startsWith('/tmp/opencode-serve-'));
    assert.ok(p.endsWith('.log'));
    assert.strictEqual(p, `/tmp/opencode-serve-${ocmux.hashDir('/my/proj')}.log`);
  });
});

describe('statefileFor', () => {
  it('joins dir with .ocmux.json', () => {
    assert.strictEqual(ocmux.statefileFor('/dir'), path.join('/dir', '.ocmux.json'));
  });
});

// ───────────────────────────────────────────────────────────────────
// readState — needs fs mocks
// ───────────────────────────────────────────────────────────────────
describe('readState', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('parses valid JSON from file', () => {
    mockFiles['/tmp/state.json'] = JSON.stringify({ url: 'http://localhost:4096' });
    const s = ocmux.readState('/tmp/state.json');
    assert.deepStrictEqual(s, { url: 'http://localhost:4096' });
  });

  it('returns null on ENOENT', () => {
    mockFiles = {};
    const s = ocmux.readState('/tmp/nope.json');
    assert.strictEqual(s, null);
  });

  it('returns null on malformed JSON', () => {
    mockFiles['/tmp/bad.json'] = 'not json';
    const s = ocmux.readState('/tmp/bad.json');
    assert.strictEqual(s, null);
  });
});

// ───────────────────────────────────────────────────────────────────
// tuiPaneId — tmux listing + parsing
// ───────────────────────────────────────────────────────────────────
describe('tuiPaneId', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns pane id for non-zero pane index', () => {
    tmuxHandler = () => tmuxOk('%1\t0\n%2\t1\n');
    assert.strictEqual(ocmux.tuiPaneId(1), '%2');
  });

  it('returns null when only pane 0 exists', () => {
    tmuxHandler = () => tmuxOk('%1\t0\n');
    assert.strictEqual(ocmux.tuiPaneId(1), null);
  });

  it('returns null on tmux failure', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.tuiPaneId(1), null);
  });

  it('skips empty lines', () => {
    tmuxHandler = () => tmuxOk('%1\t0\n\n');
    assert.strictEqual(ocmux.tuiPaneId(1), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// windowByDir
// ───────────────────────────────────────────────────────────────────
describe('windowByDir', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns index when window name matches', () => {
    tmuxHandler = () => tmuxOk('1\t/home/proj\n2\t/other\n');
    assert.strictEqual(ocmux.windowByDir('/home/proj'), 1);
  });

  it('returns null when no match', () => {
    tmuxHandler = () => tmuxOk('1\t/foo\n2\t/bar\n');
    assert.strictEqual(ocmux.windowByDir('/nope'), null);
  });

  it('returns null on tmux failure', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.windowByDir('/home/proj'), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// windowNameByIndex
// ───────────────────────────────────────────────────────────────────
describe('windowNameByIndex', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns name for matching index', () => {
    tmuxHandler = () => tmuxOk('1\t/foo\n2\t/bar\n');
    assert.strictEqual(ocmux.windowNameByIndex(2), '/bar');
  });

  it('returns null when index not found', () => {
    tmuxHandler = () => tmuxOk('1\t/foo\n');
    assert.strictEqual(ocmux.windowNameByIndex(9), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// activeWindowIndex
// ───────────────────────────────────────────────────────────────────
describe('activeWindowIndex', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns index where window_active is 1', () => {
    tmuxHandler = () => tmuxOk('1 0\n2 1\n');
    assert.strictEqual(ocmux.activeWindowIndex(), 2);
  });

  it('returns null on tmux failure', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.activeWindowIndex(), null);
  });

  it('returns null when no active window found', () => {
    tmuxHandler = () => tmuxOk('1 0\n2 0\n');
    assert.strictEqual(ocmux.activeWindowIndex(), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// paneCount
// ───────────────────────────────────────────────────────────────────
describe('paneCount', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns number of panes', () => {
    tmuxHandler = () => tmuxOk('%1\n%2\n');
    assert.strictEqual(ocmux.paneCount(1), 2);
  });

  it('returns 0 on tmux failure', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.paneCount(1), 0);
  });
});

// ───────────────────────────────────────────────────────────────────
// ensureSession
// ───────────────────────────────────────────────────────────────────
describe('ensureSession', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('creates session when it does not exist', () => {
    let hasSession = false;
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return hasSession ? tmuxOk() : tmuxFail(1);
      if (args[0] === 'new-session') { hasSession = true; return tmuxOk(); }
      return tmuxOk();
    };
    ocmux.ensureSession();
    assert.ok(hasSession);
    assert.strictEqual(spawnSyncCalls.length, 2);
    assert.strictEqual(spawnSyncCalls[0].args[0], 'has-session');
    assert.strictEqual(spawnSyncCalls[1].args[0], 'new-session');
  });

  it('does not create session when it exists', () => {
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxOk();
      return tmuxOk();
    };
    ocmux.ensureSession();
    assert.strictEqual(spawnSyncCalls.length, 1);
  });
});

// ───────────────────────────────────────────────────────────────────
// pinWindowName
// ───────────────────────────────────────────────────────────────────
describe('pinWindowName', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('calls tmux set-window-option with automatic-rename off', () => {
    tmuxHandler = () => tmuxOk();
    ocmux.pinWindowName(2);
    assert.strictEqual(spawnSyncCalls.length, 1);
    const args = spawnSyncCalls[0].args;
    assert.ok(args.includes('automatic-rename'));
    assert.ok(args.includes('off'));
  });
});

// ───────────────────────────────────────────────────────────────────
// listServers
// ───────────────────────────────────────────────────────────────────
describe('listServers', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns servers from windows with state files', () => {
    const s1 = JSON.stringify({ url: 'http://localhost:5000' });
    const s2 = JSON.stringify({ url: 'http://localhost:5001' });
    mockFiles[path.join('/proj1', '.ocmux.json')] = s1;
    mockFiles[path.join('/proj2', '.ocmux.json')] = s2;

    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();                       // has-session
      if (callIdx === 2) return tmuxOk('1\t/proj1\n2\t/proj2'); // list-windows
      if (callIdx === 3 || callIdx === 4) return tmuxOk('%1\t0\n%2\t1\n'); // list-panes for each
      return tmuxOk();
    };
    const servers = ocmux.listServers();
    assert.strictEqual(servers.length, 2);
    assert.strictEqual(servers[0].url, 'http://localhost:5000');
    assert.strictEqual(servers[1].url, 'http://localhost:5001');
  });

  it('returns empty array when tmux session does not exist', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.deepStrictEqual(ocmux.listServers(), []);
  });

  it('skips windows without state files', () => {
    mockFiles = {};
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();
      if (callIdx === 2) return tmuxOk('1\t/proj1');
      return tmuxOk();
    };
    assert.deepStrictEqual(ocmux.listServers(), []);
  });

  it('reports dead TUI when pane list fails', () => {
    mockFiles[path.join('/proj1', '.ocmux.json')] = JSON.stringify({ url: 'http://localhost:5000' });
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();
      if (callIdx === 2) return tmuxOk('1\t/proj1');
      if (callIdx === 3) return tmuxFail(1); // list-panes fails → dead
      return tmuxOk();
    };
    const servers = ocmux.listServers();
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].status, 'dead');
  });
});

// ───────────────────────────────────────────────────────────────────
// activateServer — complex: pin, restart TUI, select, zoom
// ───────────────────────────────────────────────────────────────────
describe('activateServer', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('returns true and pins window name', () => {
    // TUI alive → no restart needed
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();                         // set-window-option (pin)
      if (callIdx === 2) return tmuxOk('%1\t0\n%2\t1\n');        // tuiPaneId → alive
      if (callIdx === 3) return tmuxOk('1 1');                    // activeWindowIndex → same
      if (callIdx === 4) return tmuxOk('1|0');                    // zoom check → not zoomed
      if (callIdx === 5) return tmuxOk('%1\t0\n%2\t1\n');        // tuiPaneId for zoom
      if (callIdx === 6) return tmuxOk();                         // resize-pane
      return tmuxOk();
    };
    const result = ocmux.activateServer('/proj', 1, 'http://localhost:4096');
    assert.strictEqual(result, true);
  });

  it('restarts dead TUI pane via respawn-pane', () => {
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();                         // set-window-option (pin)
      if (callIdx === 2) return tmuxFail(1);                      // tuiPaneId → null (no TUI)
      if (callIdx === 3) return tmuxOk('%1\n%2\n');               // paneCount ≥ 2
      if (callIdx === 4) return tmuxOk('%1\n%2\n');               // list-panes for respawn target
      if (callIdx === 5) return tmuxOk();                         // respawn-pane
      // Then active window, zoom, etc.
      if (callIdx >= 6) {
        // Active window: 1 (same as our window)
        // We want same window so no select-window
        return (callIdx === 6) ? tmuxOk('1 1') :
          (callIdx === 7) ? tmuxOk('1|0') :      // zoom check
          (callIdx === 8) ? tmuxOk('%1\t0\n%2\t1\n') : // tui for zoom
          tmuxOk();
      }
      return tmuxOk();
    };
    const result = ocmux.activateServer('/proj', 1, 'http://localhost:4096');
    assert.strictEqual(result, true);
    const respawnCall = spawnSyncCalls.find(c => c.args[0] === 'respawn-pane');
    assert.ok(respawnCall, 'respawn-pane should be called');
  });

  it('creates new TUI pane via split-window when paneCount < 2', () => {
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();                         // set-window-option (pin)
      if (callIdx === 2) return tmuxFail(1);                      // tuiPaneId → null
      if (callIdx === 3) return tmuxOk('%1\n');                   // paneCount = 1 (< 2)
      if (callIdx === 4) return tmuxOk();                         // split-window
      if (callIdx >= 5) {
        return (callIdx === 5) ? tmuxOk('1 1') :                  // active window (same)
          (callIdx === 6) ? tmuxOk('1|0') :
          (callIdx === 7) ? tmuxOk('%1\t0\n%2\t1\n') :
          tmuxOk();
      }
      return tmuxOk();
    };
    const result = ocmux.activateServer('/proj', 1, 'http://localhost:4096');
    assert.strictEqual(result, true);
    const splitCall = spawnSyncCalls.find(c => c.args[0] === 'split-window');
    assert.ok(splitCall, 'split-window should be called');
  });
});

// ───────────────────────────────────────────────────────────────────
// resurrectServer — full flow (simplified mock)
// ───────────────────────────────────────────────────────────────────
describe('resurrectServer', { concurrency: false }, () => {
  beforeEach(() => setupMocks());
  afterEach(() => tearDownMocks());

  it('throws when new-window fails', () => {
    // Read state → exists
    mockFiles[path.join('/proj', '.ocmux.json')] = JSON.stringify({ url: 'http://old:4096', window_index: 1 });
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();                   // has-session OK
      if (callIdx === 2) return tmuxOk('1\t/proj');          // windowNameByIndex → match
      if (callIdx === 3) return tmuxOk();                    // select-window
      if (callIdx === 4) return tmuxOk();                    // send-keys C-c
      if (callIdx === 5) return tmuxOk();                    // kill-window
      if (callIdx === 6) return tmuxOk();                    // ensureSession → has-session
      if (callIdx === 7) return { status: 1, stdout: '', stderr: 'error' };  // new-window FAILS
      return tmuxOk();
    };
    assert.throws(
      () => ocmux.resurrectServer('/proj'),
      /failed to create tmux window/,
    );
  });

  it('throws when URL is not found in log', () => {
    mockFiles[path.join('/proj', '.ocmux.json')] = JSON.stringify({ url: 'http://old:4096', window_index: 1 });
    let callIdx = 0;
    tmuxHandler = () => {
      callIdx++;
      if (callIdx === 1) return tmuxOk();
      if (callIdx === 2) return tmuxOk('1\t/proj');
      if (callIdx === 3) return tmuxOk();
      if (callIdx === 4) return tmuxOk();
      if (callIdx === 5) return tmuxOk();
      if (callIdx === 6) return tmuxOk();                    // ensureSession → has-session
      if (callIdx === 7) return tmuxOk();                    // new-window
      if (callIdx === 8) return tmuxOk('9\t/proj');          // windowByDir
      if (callIdx === 9) return tmuxOk();                    // pinWindowName (set-window-option)
      if (callIdx === 10) return tmuxOk();                   // send-keys server start
      // Then the log polling loop (50 iterations)
      // Each iteration: readFileSync → URL_RE match (no spawnSync in loop)
      // No URL in log → loop runs all 50 iterations
      if (callIdx === 11) return tmuxOk();                   // windowByDir (for cleanup in error)
      if (callIdx === 12) return tmuxOk();                   // kill-window
      return tmuxOk();
    };
    // The log file content: doesn't contain a URL
    mockFiles[ocmux.logfileFor('/proj')] = 'some log output without URL';
    assert.throws(
      () => ocmux.resurrectServer('/proj'),
      /did not start/,
    );
  });

  it('succeeds with URL extraction from log', () => {
    mockFiles[path.join('/proj', '.ocmux.json')] = JSON.stringify({ url: 'http://old:4096', window_index: 1 });
    let callIdx = 0;
    const newStateFile = ocmux.statefileFor('/proj');
    const logFile = ocmux.logfileFor('/proj');

    tmuxHandler = () => {
      callIdx++;
      // Normal resurrection flow
      if (callIdx === 1) return tmuxOk();                   // has-session
      if (callIdx === 2) return tmuxOk('1\t/proj');          // windowNameByIndex
      if (callIdx === 3) return tmuxOk();                    // select-window
      if (callIdx === 4) return tmuxOk();                    // send-keys C-c
      if (callIdx === 5) return tmuxOk();                    // kill-window
      if (callIdx === 6) return tmuxOk();                    // ensureSession → has-session
      if (callIdx === 7) return tmuxOk();                    // new-window
      if (callIdx === 8) return tmuxOk('9\t/proj');          // windowByDir
      if (callIdx === 9) return tmuxOk();                    // pinWindowName (set-window-option)
      if (callIdx === 10) return tmuxOk();                   // send-keys server start
      // log polling loop (50 iterations, no spawnSync calls)
      // After polling: writeFileSync (no spawnSync), then:
      if (callIdx === 11) return tmuxOk('%2\n');             // split-window (returns pane id)
      if (callIdx === 12) return tmuxOk();                   // send-keys for TUI
      if (callIdx === 13) return tmuxOk();                   // resize-pane
      if (callIdx === 14) return tmuxOk('9\t0\n10\t1\n');    // activeWindowIndex
      if (callIdx === 15) return tmuxOk();                   // select-window
      return tmuxOk();
    };

    // Log file already contains the URL: found at first polling iteration
    mockFiles[logFile] = 'opencode server listening on http://localhost:4096\n';

    const result = ocmux.resurrectServer('/proj');
    assert.ok(result.url);
    assert.strictEqual(result.dir, '/proj');

    // Check that state file was written
    assert.ok(fsWrites.length > 0);
    const sw = fsWrites.find(w => w.path === newStateFile);
    assert.ok(sw, 'state file should be written');
    const parsed = JSON.parse(sw.data);
    assert.ok(parsed.url);
    assert.strictEqual(parsed.window_index, 9);
  });
});
