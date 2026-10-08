'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ocmux = require('../lib/ocmux');
const binOcmux = require('../bin/ocmux');
const opencode = require('../lib/opencode');

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
function mockExecSync() { /* no-op */ }

// ── Mock infrastructure for http.request (checkServer) ─────────────
let httpMode = 'ok';          // 'ok' | 'down' (net error)

function mockHttpRequest(opts, callback) {
  const res = {
    statusCode: 200,
    _listeners: {},
    on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; },
    _emit(ev, d) { (this._listeners[ev] || []).forEach(fn => fn(d)); },
    resume() {},
    destroy() {},
  };
  const req = {
    _errHandler: null,
    on(ev, fn) {
      if (ev === 'error') this._errHandler = fn;
      return this;
    },
    setTimeout(ms, fn) { /* no-op */ },
    destroy() {},
    end() {
      if (httpMode === 'down') {
        if (req._errHandler) req._errHandler(new Error('ECONNREFUSED'));
        return;
      }
      callback(res);
      // Emit an empty v2 envelope so makeRequest()-based helpers settle.
      res._emit('data', '{"data":[]}');
      res._emit('end');
    },
  };
  return req;
}

// ── Mock infrastructure for fs ─────────────────────────────────────
let mockFiles = {};           // path → content
let mockDirs = {};            // path → isDirectory (for resolveDir)
let originalReadFileSync = fs.readFileSync;
let originalStatSync = fs.statSync;

function mockReadFileSync(p, encoding) {
  if (mockFiles[p] !== undefined) return mockFiles[p];
  return originalReadFileSync(p, encoding);
}

function mockExistsSync(p) { return mockFiles[p] !== undefined; }

function mockStatSync(p) {
  if (mockDirs[p] !== undefined) return { isDirectory: () => mockDirs[p], isFile: () => !mockDirs[p] };
  return originalStatSync(p);
}

let fsWrites = [];
function mockWriteFileSync(p, data) { fsWrites.push({ path: p, data }); }

let fsUnlinks = [];
function mockUnlinkSync(p) { fsUnlinks.push(p); }

function mockRenameSync(a, b) {}
function mockTruncateSync(p) {}

function setupMocks() {
  tmuxHandler = null;
  spawnSyncCalls = [];
  httpMode = 'ok';
  mockFiles = {};
  mockDirs = { '/proj': true, '/nope': true, '/proj1': true, '/proj2': true, '/other': true };
  fsWrites = [];
  fsUnlinks = [];

  nodeMock.method(child_process, 'spawnSync', mockSpawnSync);
  nodeMock.method(child_process, 'execSync', mockExecSync);
  nodeMock.method(http, 'request', mockHttpRequest);
  nodeMock.method(fs, 'readFileSync', mockReadFileSync);
  nodeMock.method(fs, 'existsSync', mockExistsSync);
  nodeMock.method(fs, 'statSync', mockStatSync);
  nodeMock.method(fs, 'writeFileSync', mockWriteFileSync);
  nodeMock.method(fs, 'unlinkSync', mockUnlinkSync);
  nodeMock.method(fs, 'renameSync', mockRenameSync);
  nodeMock.method(fs, 'truncateSync', mockTruncateSync);
}

function tearDownMocks() {
  nodeMock.restoreAll();
  tmuxHandler = null;
  spawnSyncCalls = [];
  httpMode = 'ok';
  mockFiles = {};
  mockDirs = {};
  fsWrites = [];
  fsUnlinks = [];
}

function tmuxOk(stdout) {
  return { status: 0, stdout: stdout || '', stderr: '' };
}

function tmuxFail(status) {
  return { status: status || 1, stdout: '', stderr: 'error' };
}

// Last recorded fs.writeFileSync targeting a project's state file (the atomic
// writer writes `<file>.tmp` before renaming, and rename is mocked as a no-op).
function lastStateWrite(dir) {
  const sf = path.join(dir, '.ocmux.json');
  const hits = fsWrites.filter(w => w.path === sf || w.path === sf + '.tmp');
  return hits.length ? hits[hits.length - 1] : null;
}

// Install mocks for every test (pure helpers, tmux lib and CLI alike).
beforeEach(() => { setupMocks(); });
afterEach(() => { tearDownMocks(); });

// ───────────────────────────────────────────────────────────────────
// Pure functions
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
    assert.strictEqual(p, `/tmp/opencode-serve-${ocmux.hashDir('/my/proj')}.log`);
  });
});

describe('statefileFor', () => {
  it('joins dir with .ocmux.json', () => {
    assert.strictEqual(ocmux.statefileFor('/dir'), path.join('/dir', '.ocmux.json'));
  });
});

describe('readState', () => {
  it('parses a valid state file', () => {
    mockFiles['/tmp/state.json'] = JSON.stringify({ version: 2, directory: '/p', session: 's1' });
    const s = ocmux.readState('/tmp/state.json');
    assert.strictEqual(s.session, 's1');
  });

  it('returns null when file is missing', () => {
    assert.strictEqual(ocmux.readState('/tmp/nope.json'), null);
  });

  it('returns null on malformed JSON', () => {
    mockFiles['/tmp/bad.json'] = '{nope';
    assert.strictEqual(ocmux.readState('/tmp/bad.json'), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// windowFor / renderList (scrollable, resize-aware lists)
// ───────────────────────────────────────────────────────────────────
describe('windowFor', () => {
  it('returns the whole list when it fits, empty otherwise', () => {
    assert.deepStrictEqual(binOcmux.windowFor(3, 1, 10), { start: 0, count: 3 });
    assert.deepStrictEqual(binOcmux.windowFor(0, 0, 10), { start: 0, count: 0 });
    assert.deepStrictEqual(binOcmux.windowFor(5, 0, 0), { start: 0, count: 0 });
  });

  it('centers the cursor and clamps to bounds', () => {
    assert.deepStrictEqual(binOcmux.windowFor(20, 0, 5), { start: 0, count: 5 });
    assert.deepStrictEqual(binOcmux.windowFor(20, 10, 5), { start: 8, count: 5 });
    assert.deepStrictEqual(binOcmux.windowFor(20, 19, 5), { start: 15, count: 5 });
  });
});

describe('renderList', () => {
  it('renders only the visible window and shows a range in the title', () => {
    const items = Array.from({ length: 20 }, (_, i) => 'item' + i);
    const out = binOcmux.renderList({ title: 'T', items, cursor: 0, row: (i, it) => it, footer: 'F', cols: 40, rows: 10 });
    assert.ok(out.includes('item0'));
    assert.ok(!out.includes('item19'));
    assert.ok(out.includes('/20'));
  });

  it('renders everything when it fits (no range suffix)', () => {
    const out = binOcmux.renderList({ title: 'T', items: ['a', 'b'], cursor: 1, row: (i, it) => it, footer: 'F', cols: 40, rows: 24 });
    assert.ok(out.includes('  a'));
    assert.ok(out.includes('▶ b'));
    assert.ok(!out.includes('/2'));
  });

  it('supports reverse-video rows and extra lines', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['x'], cursor: 0,
      row: () => ({ text: 'x', reverse: true }),
      footer: 'F', extraLines: ['Prompt: '], cols: 40, rows: 24,
    });
    assert.ok(out.includes('\x1b[7m'));
    assert.ok(out.includes('Prompt: '));
  });
});

describe('formatters', () => {
  it('fmtDuration formats HH:MM:SS', () => {
    assert.strictEqual(binOcmux.fmtDuration(0), '00:00:00');
    assert.strictEqual(binOcmux.fmtDuration(3723000), '01:02:03');
  });

  it('fmtTokens humanizes magnitudes', () => {
    assert.strictEqual(binOcmux.fmtTokens(999), '999');
    assert.strictEqual(binOcmux.fmtTokens(1500), '2K');
    assert.strictEqual(binOcmux.fmtTokens(3400000), '3.4M');
    assert.strictEqual(binOcmux.fmtTokens(null), null);
  });

  it('fmtClock shows HH:MM recently and DD/MM/YYYY when older, --:-- when unknown', () => {
    const now = Date.now();
    assert.match(binOcmux.fmtClock(now), /^\d{2}:\d{2}$/);
    assert.match(binOcmux.fmtClock(now - 3 * 86400000), /^\d{2}\/\d{2}\/\d{4}$/);
    assert.strictEqual(binOcmux.fmtClock(null), '--:--');
  });
});

describe('layoutCells', () => {
  it('lays out row-major and collapses columns when narrow', () => {
    const cells = ['a', 'b', 'c', 'd'];
    assert.strictEqual(binOcmux.layoutCells(cells, 200).length, 1); // 4 columns
    assert.strictEqual(binOcmux.layoutCells(cells, 60, 26).length, 2); // 2 columns
    assert.strictEqual(binOcmux.layoutCells(cells, 20, 26).length, 4); // 1 column
  });
});

describe('sessionInfoLines', () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('includes title/location and a detail grid', () => {
    const s = {
      id: 's1', title: 'My Task', agent: 'build',
      model: { providerID: 'p', id: 'm' }, cost: 0.5,
      tokens: { input: 1000, output: 500, reasoning: 0 },
      outcome: 'succeeded', location: { directory: '/x' },
    };
    const text = binOcmux.sessionInfoLines(s, new Set(), new Map(), 120).map(strip).join('\n');
    assert.ok(text.includes('Title: My Task'));
    assert.ok(text.includes('Location: /x'));
    assert.ok(text.includes('Model: p/m'));
    assert.ok(text.includes('Agent: build'));
    assert.ok(text.includes('Status: IDLE'));
    assert.ok(text.includes('Cost: $0.5000'));
    assert.ok(text.includes('Outcome: succeeded'));
  });

  it('always includes fields, using placeholders when unknown', () => {
    const text = binOcmux.sessionInfoLines({ id: 's2' }, new Set(), new Map(), 200).map(strip).join('\n');
    assert.ok(text.includes('Title: Untitled'));
    assert.ok(text.includes('Location: Unknown'));
    assert.ok(text.includes('Model: Unknown'));
    assert.ok(text.includes('Agent: Unknown'));
    assert.ok(text.includes('Tokens: --'));
    assert.ok(text.includes('Cost: --'));
    assert.ok(text.includes('Ctx: --'));
  });

  it('colours labels yellow when highlighted (current session under cursor)', () => {
    const s = { id: 's1', title: 'T' };
    const plain = binOcmux.sessionInfoLines(s, new Set(), new Map(), 120, false).join('\n');
    const yellow = binOcmux.sessionInfoLines(s, new Set(), new Map(), 120, true).join('\n');
    assert.ok(plain.includes('\x1b[1m'));
    assert.ok(!plain.includes('\x1b[1;33m'));
    assert.ok(yellow.includes('\x1b[1;33m'));
  });
});

// ───────────────────────────────────────────────────────────────────
// tuiAttachCommand (v2-only)
// ───────────────────────────────────────────────────────────────────
describe('tuiAttachCommand', () => {
  it('uses --session when a session is given', () => {
    const c = ocmux.tuiAttachCommand('http://127.0.0.1:4096', 'ses_1');
    assert.strictEqual(c, "opencode --server 'http://127.0.0.1:4096' --session 'ses_1'");
  });

  it('uses --continue when no session is given', () => {
    const c = ocmux.tuiAttachCommand('http://127.0.0.1:4096', null);
    assert.strictEqual(c, "opencode --server 'http://127.0.0.1:4096' --continue");
  });
});

describe('newestSessionId', () => {
  it('picks the newest main session even when a child is newer', () => {
    const id = binOcmux.newestSessionId([
      { id: 'main', time: { updated: 100 } },
      { id: 'child', parentID: 'main', time: { updated: 200 } },
    ]);
    assert.strictEqual(id, 'main');
  });

  it('returns null when every session is a child (callers create one)', () => {
    const id = binOcmux.newestSessionId([
      { id: 'child', parentID: 'main', time: { updated: 200 } },
    ]);
    assert.strictEqual(id, null);
  });

  it('returns null for empty input', () => {
    assert.strictEqual(binOcmux.newestSessionId([]), null);
    assert.strictEqual(binOcmux.newestSessionId(null), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// tmux window helpers
// ───────────────────────────────────────────────────────────────────
describe('tuiPaneId', () => {
  it('returns the single pane (v2 layout: TUI is pane 0)', () => {
    tmuxHandler = () => tmuxOk('%0\t0\n');
    assert.strictEqual(ocmux.tuiPaneId(1), '%0');
  });

  it('falls back to the last pane for legacy server layouts', () => {
    tmuxHandler = () => tmuxOk('%0\t0\n%1\t1\n');
    assert.strictEqual(ocmux.tuiPaneId(1), '%1');
  });

  it('returns null when tmux fails', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.tuiPaneId(1), null);
  });

  it('returns null when the window has no panes', () => {
    tmuxHandler = () => tmuxOk('');
    assert.strictEqual(ocmux.tuiPaneId(1), null);
  });
});

describe('windowByDir', () => {
  it('matches by exact window name', () => {
    tmuxHandler = () => tmuxOk('1\t/proj\n');
    assert.strictEqual(ocmux.windowByDir('/proj'), 1);
  });

  it('returns null when missing', () => {
    tmuxHandler = () => tmuxOk('1\t/other\n');
    assert.strictEqual(ocmux.windowByDir('/proj'), null);
  });
});

describe('windowNameByIndex', () => {
  it('returns the name for an index', () => {
    tmuxHandler = () => tmuxOk('2\t/bar\n');
    assert.strictEqual(ocmux.windowNameByIndex(2), '/bar');
  });

  it('returns null for an unknown index', () => {
    tmuxHandler = () => tmuxOk('2\t/bar\n');
    assert.strictEqual(ocmux.windowNameByIndex(9), null);
  });
});

describe('activeWindowIndex', () => {
  it('returns the active window index', () => {
    tmuxHandler = () => tmuxOk('1 0\n2 1\n');
    assert.strictEqual(ocmux.activeWindowIndex(), 2);
  });

  it('returns null when tmux fails', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.strictEqual(ocmux.activeWindowIndex(), null);
  });
});

describe('paneCount', () => {
  it('counts panes', () => {
    tmuxHandler = () => tmuxOk('%0\n%1\n');
    assert.strictEqual(ocmux.paneCount(1), 2);
  });
});

describe('ensureSession', () => {
  it('creates the session when missing', () => {
    tmuxHandler = (args) => (args[0] === 'has-session' ? tmuxFail(1) : tmuxOk(''));
    ocmux.ensureSession();
    const newCall = spawnSyncCalls.find(c => c.args[0] === 'new-session');
    assert.ok(newCall);
  });

  it('is a no-op when the session exists', () => {
    tmuxHandler = (args) => (args[0] === 'has-session' ? tmuxOk('') : tmuxOk(''));
    ocmux.ensureSession();
    assert.ok(!spawnSyncCalls.some(c => c.args[0] === 'new-session'));
  });
});

describe('pinWindowName', () => {
  it('sends set-window-option automatic-rename off', () => {
    ocmux.pinWindowName(2);
    const call = spawnSyncCalls.find(c => c.args[0] === 'set-window-option');
    assert.ok(call);
    assert.deepStrictEqual(call.args, ['set-window-option', '-t', 'Opencode:2', 'automatic-rename', 'off']);
  });
});

describe('isWindowZoomed', () => {
  it('detects a zoomed window', () => {
    tmuxHandler = () => tmuxOk('1|0\n2|1\n');
    assert.strictEqual(ocmux.isWindowZoomed(2), true);
    assert.strictEqual(ocmux.isWindowZoomed(1), false);
  });
});

// ───────────────────────────────────────────────────────────────────
// listProjects
// ───────────────────────────────────────────────────────────────────
describe('listProjects', () => {
  it('lists windows that hold a .ocmux.json with session/server/status', () => {
    const s1 = JSON.stringify({ version: 2, directory: '/proj1', session: 's1', server: 'http://x:4096' });
    mockFiles[path.join('/proj1', '.ocmux.json')] = s1;
    const s2 = JSON.stringify({ version: 2, directory: '/proj2', session: null, server: 'http://x:4097' });
    mockFiles[path.join('/proj2', '.ocmux.json')] = s2;
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxOk('');
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj1\n2\t/proj2\n3\t/bash\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n%1\t1\n');
      return tmuxOk('');
    };
    const rows = ocmux.listProjects();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].dir, '/proj1');
    assert.strictEqual(rows[0].session, 's1');
    assert.strictEqual(rows[0].server, 'http://x:4096');
    assert.strictEqual(rows[0].status, 'alive');
    assert.strictEqual(rows[1].status, 'alive');
  });

  it('returns [] when the tmux session does not exist', () => {
    tmuxHandler = (args) => (args[0] === 'has-session' ? tmuxFail(1) : tmuxOk(''));
    assert.deepStrictEqual(ocmux.listProjects(), []);
  });
});

// ───────────────────────────────────────────────────────────────────
// activateProject / relaunchTui / closeProjectWindow / createProjectWindow
// ───────────────────────────────────────────────────────────────────
describe('activateProject', () => {
  it('opens a TUI when the window has none', () => {
    // No panes at all → tuiPaneId null → send the TUI command to pane .0
    tmuxHandler = (args) => {
      if (args[0] === 'list-panes') return tmuxOk('');
      if (args[0] === 'list-windows') return tmuxOk('1|0\n2|0\n');
      return tmuxOk('');
    };
    const ok = ocmux.activateProject('/proj', 1, 'http://x:4096', 's1');
    assert.strictEqual(ok, true);
    const keys = spawnSyncCalls.find(c => c.args[0] === 'send-keys' && c.args.join(' ').includes('Opencode:1.0'));
    assert.ok(keys);
    assert.ok(keys.args.join(' ').includes('--session \'s1\''));
  });

  it('does not respawn when the TUI is alive', () => {
    tmuxHandler = (args) => {
      if (args[0] === 'list-panes') return tmuxOk('%1\t1\n');
      if (args[0] === 'list-windows') return tmuxOk('1|1\n');
      return tmuxOk('');
    };
    ocmux.activateProject('/proj', 1, 'http://x:4096', 's1');
    assert.ok(!spawnSyncCalls.some(c => c.args[0] === 'respawn-pane'));
  });
});

describe('relaunchTui', () => {
  it('respaws the TUI pane onto the given session', () => {
    tmuxHandler = (args) => {
      if (args[0] === 'list-panes') return tmuxOk('%1\t1\n');
      if (args[0] === 'list-windows') return tmuxOk('1|0\n');
      return tmuxOk('');
    };
    ocmux.relaunchTui(1, '/proj', 'http://x:4096', 'ses_9');
    const respawn = spawnSyncCalls.find(c => c.args[0] === 'respawn-pane');
    assert.ok(respawn);
    assert.ok(respawn.args.join(' ').includes('--session \'ses_9\''));
  });
});

describe('closeProjectWindow', () => {
  it('kills the tmux window', () => {
    ocmux.closeProjectWindow(3);
    assert.ok(spawnSyncCalls.some(c => c.args[0] === 'kill-window' && c.args[2] === 'Opencode:3'));
  });

  it('throws when kill fails', () => {
    tmuxHandler = () => tmuxFail(1);
    assert.throws(() => ocmux.closeProjectWindow(3), /failed to kill window/);
  });
});

describe('createProjectWindow', () => {
  it('creates a window, opens the TUI and writes a v2 state file', () => {
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxFail(1);
      if (args[0] === 'new-window') return tmuxOk('2\n');
      if (args[0] === 'list-windows') return tmuxOk('2|0\n');
      if (args[0] === 'list-panes') return tmuxOk('%5\t0\n');
      return tmuxOk('');
    };
    const r = ocmux.createProjectWindow('/proj', 'http://x:4096', 'ses_1');
    assert.strictEqual(r.index, 2);
    const stateWrite = fsWrites.find(w => w.path === path.join('/proj', '.ocmux.json'));
    assert.ok(stateWrite);
    const state = JSON.parse(stateWrite.data);
    assert.strictEqual(state.version, 2);
    assert.strictEqual(state.directory, '/proj');
    assert.strictEqual(state.session, 'ses_1');
    assert.strictEqual(state.server, 'http://x:4096');
    const keys = spawnSyncCalls.find(c => c.args[0] === 'send-keys');
    assert.ok(keys);
    assert.ok(keys.args.join(' ').includes("opencode --server 'http://x:4096' --session 'ses_1'"));
  });
});

// ───────────────────────────────────────────────────────────────────
// bin/ocmux — the child-session "Subagents" panel workaround was removed:
// child/subagent sessions are no longer listed in the picker, so the Escape
// key trick (which could in theory interrupt a running prompt) is unnecessary.

// ───────────────────────────────────────────────────────────────────
// bin/ocmux — CLI behavior
// ───────────────────────────────────────────────────────────────────
describe('ocmux CLI', () => {
  let exitThrown;
  let stdoutOutput;
  let stderrOutput;
  let origExit;
  let origArgv;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  before(() => {
    origExit = process.exit;
    origArgv = process.argv;
    process.stdin.isTTY = true;
    process.stdout.write = (chunk) => {
      stdoutOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    process.stderr.write = (chunk) => {
      stderrOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
  });

  after(() => {
    process.exit = origExit;
    process.argv = origArgv;
    process.stdin.isTTY = false;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  });

  function setupProcessMocks() {
    exitThrown = null;
    stdoutOutput = [];
    stderrOutput = [];
    process.exit = (code) => { exitThrown = code; throw new Error('EXIT:' + code); };
    process.argv = ['node', 'ocmux'];
    process.stdin.isTTY = true;
  }

  async function runMain(args) {
    process.argv = ['node', 'ocmux', ...args];
    delete require.cache[require.resolve('../bin/ocmux')];
    const { main } = require('../bin/ocmux');
    try {
      const pm = main();
      pm.catch(() => {}); // never surface as an uncaught rejection
      await pm;
    } catch (e) {
      if (!e.message || !e.message.startsWith('EXIT:')) throw e;
    }
  }

  beforeEach(() => {
    setupProcessMocks();
  });

  afterEach(() => {
    process.exit = origExit;
    process.argv = origArgv;
    delete require.cache[require.resolve('../bin/ocmux')];
  });

  it('errors when the default command finds no .ocmux.json', async () => {
    await runMain([]);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('no .ocmux.json found')));
  });

  it('errors when there is no state file for the session subcommand', async () => {
    await runMain(['session', 'ses_1']);
    assert.strictEqual(exitThrown, 1);
  });

  it('errors when --server lacks a value', async () => {
    await runMain(['serve', '/proj', '--server']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes("'--server' requires a URL")));
  });

  it('serve errors when the server is not reachable', async () => {
    httpMode = 'down';
    await runMain(['serve', '/proj', '--server', 'http://x:4096']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('not reachable')));
  });

  it('serve creates a project window and records the session', async () => {
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxFail(1);
      if (args[0] === 'new-window') return tmuxOk('4\n');
      if (args[0] === 'list-windows') return tmuxOk('4|0\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    nodeMock.method(opencode, 'listSessions', async (server, dir) => []);
    nodeMock.method(opencode, 'createSession', async (server, title, loc) => ({ id: 'new_ses' }));
    nodeMock.method(opencode, 'createSessionWithModel', async (server, title, loc) => ({ id: 'new_ses' }));
    await runMain(['serve', '/proj', '--server', 'http://x:4096']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    const stateWrite = lastStateWrite('/proj');
    assert.ok(stateWrite);
    const state = JSON.parse(stateWrite.data);
    assert.strictEqual(state.server, 'http://x:4096');
    assert.strictEqual(state.session, 'new_ses');
    assert.strictEqual(state.directory, '/proj');
  });

  it('serve scopes session listing by the project directory', async () => {
    let listedDir = null;
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxFail(1);
      if (args[0] === 'new-window') return tmuxOk('4\n');
      if (args[0] === 'list-windows') return tmuxOk('4|0\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    nodeMock.method(opencode, 'listSessions', async (server, dir) => { listedDir = dir; return [{ id: 'existing' }]; });
    await runMain(['serve', '/proj', '--server', 'http://x:4096']);
    assert.strictEqual(listedDir, '/proj');
  });

  it('serve errors when a project already exists', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] = '{}';
    await runMain(['serve', '/proj', '--server', 'http://x:4096']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('already exists')));
  });

  it('list prints headers and project rows', async () => {
    const s1 = JSON.stringify({ version: 2, directory: '/proj1', session: 'ses_1', server: 'http://x:4096' });
    mockFiles[path.join('/proj1', '.ocmux.json')] = s1;
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxOk('');
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj1\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    await runMain(['list']);
    assert.ok(stdoutOutput.join('').includes('/proj1'));
    assert.ok(stdoutOutput.join('').includes('ses_1'));
  });

  it('list reports no projects when the tmux session is empty', async () => {
    tmuxHandler = (args) => (args[0] === 'has-session' ? tmuxFail(1) : tmuxOk(''));
    await runMain(['list']);
    assert.ok(stdoutOutput.join('').includes('No opencode projects running.'));
  });

  it('session <ref> updates the state file and relaunches the TUI', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 'old', server: 'http://x:4096' });
    tmuxHandler = (args) => {
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    nodeMock.method(opencode, 'listSessions', async (server, dir) => [
      { id: 'ses_target', title: 'Target' },
    ]);
    await runMain(['session', 'ses_target', '/proj']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    const stateWrite = lastStateWrite('/proj');
    assert.ok(stateWrite);
    assert.strictEqual(JSON.parse(stateWrite.data).session, 'ses_target');
    const respawn = spawnSyncCalls.find(c => c.args[0] === 'respawn-pane');
    assert.ok(respawn && respawn.args.join(' ').includes('ses_target'));
  });

  it('default interactive command errors when the server is down', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 's1', server: 'http://x:4096' });
    tmuxHandler = (args) => {
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj\n');
      return tmuxOk('');
    };
    httpMode = 'down';
    await runMain(['/proj']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('not reachable')));
  });

  it('reports that the switch subcommand was removed (use p in the picker)', async () => {
    await runMain(['switch']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("'switch' subcommand was removed"));
  });

  it('switch rejects a directory argument with the removal message', async () => {
    await runMain(['switch', '/proj']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("'switch' subcommand was removed"));
  });

  it('kill closes the window but keeps the state file (status: stopped)', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 's1', server: 'http://x:4096' });
    tmuxHandler = (args) => {
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj\n');
      return tmuxOk('');
    };
    await runMain(['kill', '/proj']);
    assert.strictEqual(exitThrown, null);
    assert.ok(spawnSyncCalls.some(c => c.args[0] === 'kill-window'));
    assert.ok(!fsUnlinks.includes(path.join('/proj', '.ocmux.json')));
    const write = lastStateWrite('/proj');
    assert.ok(write && JSON.parse(write.data).status === 'stopped');
  });

  it('kill errors without a state file', async () => {
    await runMain(['kill', '/nope']);
    assert.strictEqual(exitThrown, 1);
  });

  it('resurrect recreates the project window from state', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 's1', server: 'http://x:4096' });
    // No existing window for /proj → windowByDir returns null (list-windows shows only /other)
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxFail(1);
      if (args[0] === 'list-windows') return tmuxOk('3\t/other\n');
      if (args[0] === 'new-window') return tmuxOk('5\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    await runMain(['resurrect', '/proj']);
    assert.strictEqual(exitThrown, null);
    assert.ok(spawnSyncCalls.some(c => c.args[0] === 'new-window'));
    const write = lastStateWrite('/proj');
    assert.ok(write && JSON.parse(write.data).session === 's1');
  });

  it('reports that the model subcommand was removed (use m in the picker)', async () => {
    await runMain(['model', 'deepseek']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("'model' subcommand was removed"));
  });

  it('reports the model removal even combined with --git', async () => {
    await runMain(['--git', 'model']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("'model' subcommand was removed"));
  });

  it('rejects --git with switch', async () => {
    await runMain(['--git', 'switch']);
    assert.strictEqual(exitThrown, 1);
  });

  it('migrate rewrites legacy state files to v2', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ url: 'http://x:4096', window_index: 1 });
    tmuxHandler = (args) => {
      if (args[0] === 'has-session') return tmuxOk('');
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    await runMain(['migrate']);
    const write = lastStateWrite('/proj');
    assert.ok(write);
    const state = JSON.parse(write.data);
    assert.strictEqual(state.version, 2);
    assert.strictEqual(state.server, 'http://x:4096');
    assert.strictEqual(state.directory, '/proj');
  });

  it('serve --force repoints an existing project to a new server', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 's1', server: 'http://old:4096' });
    tmuxHandler = (args) => {
      if (args[0] === 'list-windows') return tmuxOk('1\t/proj\n');
      if (args[0] === 'list-panes') return tmuxOk('%0\t0\n');
      return tmuxOk('');
    };
    nodeMock.method(opencode, 'listSessions', async () => [{ id: 's1' }, { id: 's2' }]);
    await runMain(['serve', '/proj', '--server', 'http://new:4096', '--force']);
    assert.strictEqual(exitThrown, null);
    const w = lastStateWrite('/proj');
    assert.ok(w);
    const st = JSON.parse(w.data);
    assert.strictEqual(st.server, 'http://new:4096');
    assert.strictEqual(st.session, 's1');
  });

  it('serve without --force still refuses an existing project', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] = JSON.stringify({ version: 2, directory: '/proj', server: 'http://x:4096' });
    await runMain(['serve', '/proj', '--server', 'http://new:4096']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes('already exists'));
  });

  it('--help exits 0 with usage', async () => {
    await runMain(['--help']);
    assert.strictEqual(exitThrown, 0);
    assert.ok(stderrOutput.some(s => s.includes('Usage: ocmux')));
  });

  it('--version prints the package version', async () => {
    await runMain(['--version']);
    assert.strictEqual(exitThrown, 0);
  });
});
// ───────────────────────────────────────────────────────────────────
// '/' incremental search helpers
// ───────────────────────────────────────────────────────────────────
describe('search helpers', () => {
  it('filterByPattern matches case-insensitively and ANDs whitespace tokens', () => {
    const items = [{ t: 'Alpha GPT' }, { t: 'Beta' }, { t: 'ALPHA small' }];
    const text = (x) => x.t;
    assert.strictEqual(binOcmux.filterByPattern(items, '', text), items);
    assert.deepStrictEqual(binOcmux.filterByPattern(items, 'alpha', text).map(text), ['Alpha GPT', 'ALPHA small']);
    assert.deepStrictEqual(binOcmux.filterByPattern(items, 'alpha small', text).map(text), ['ALPHA small']);
    assert.deepStrictEqual(binOcmux.filterByPattern(items, 'zzz', text), []);
  });

  it('handleSearch drives the live/committed/clear lifecycle', () => {
    const s = binOcmux.newSearchState();
    assert.strictEqual(binOcmux.handleSearch('x', { name: 'x' }, s), 'pass');
    assert.strictEqual(binOcmux.handleSearch('/', { name: 'slash' }, s), 'edit');
    assert.ok(s.active && s.live);
    assert.strictEqual(binOcmux.handleSearch('b', { name: 'b' }, s), 'edit');
    assert.strictEqual(s.value, 'b');
    assert.strictEqual(binOcmux.handleSearch('', { name: 'up' }, s), 'pass'); // arrows navigate
    assert.strictEqual(binOcmux.handleSearch('', { name: 'return' }, s), 'done');
    assert.strictEqual(s.live, false);
    assert.strictEqual(s.value, 'b');
    assert.strictEqual(binOcmux.handleSearch('/', { name: 'slash' }, s), 'edit'); // resume editing
    assert.ok(s.live);
    assert.strictEqual(binOcmux.handleSearch('', { name: 'escape' }, s), 'close');
    assert.ok(!s.active);

    // Committed filter (kept after Enter): ESC clears, Backspace resumes.
    binOcmux.handleSearch('/', { name: 'slash' }, s);
    binOcmux.handleSearch('a', { name: 'a' }, s);
    binOcmux.handleSearch('', { name: 'return' }, s);
    assert.ok(s.active && !s.live);
    assert.strictEqual(binOcmux.handleSearch('', { name: 'backspace' }, s), 'edit');
    assert.ok(s.live && s.value === '');

    // Empty commit closes the search entirely.
    binOcmux.handleSearch('', { name: 'return' }, s);
    assert.ok(!s.active);
  });

  it('searchFooter shows the caret while typing and the kept pattern once committed', () => {
    const s = binOcmux.newSearchState();
    assert.strictEqual(binOcmux.searchFooter(s, 'keys'), 'keys');
    binOcmux.handleSearch('/', { name: 'slash' }, s);
    binOcmux.handleSearch('a', { name: 'a' }, s);
    binOcmux.handleSearch('b', { name: 'b' }, s);
    assert.strictEqual(binOcmux.searchFooter(s, 'keys'), 'Search: ab▏');
    binOcmux.handleSearch('', { name: 'return' }, s);
    assert.strictEqual(binOcmux.searchFooter(s, 'keys'), 'Search: ab · /: edit');
    assert.strictEqual(binOcmux.SEARCH_HINT, 'Enter: confirm · Esc: cancel');
  });

  it('Backspace on an empty search exits it; removing the last char keeps it open', () => {
    const s = binOcmux.newSearchState();
    binOcmux.handleSearch('/', { name: 'slash' }, s);
    assert.ok(s.active && s.live);
    // Empty field: Backspace closes the search.
    assert.strictEqual(binOcmux.handleSearch('', { name: 'backspace' }, s), 'close');
    assert.ok(!s.active);
    // One char: Backspace removes it and stays open (now empty).
    binOcmux.handleSearch('/', { name: 'slash' }, s);
    binOcmux.handleSearch('a', { name: 'a' }, s);
    assert.strictEqual(binOcmux.handleSearch('', { name: 'backspace' }, s), 'edit');
    assert.ok(s.active && s.live && s.value === '');
    // Now empty: next Backspace closes.
    assert.strictEqual(binOcmux.handleSearch('', { name: 'backspace' }, s), 'close');
    assert.ok(!s.active);
  });

  it('renderList left-aligns the footer when footerLeft is set', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a'], cursor: 0, row: (i, it) => it,
      footer: 'Search: ab', footerLeft: true, cols: 20, rows: 10,
    });
    assert.ok(out.includes('\x1b[7mSearch: ab' + ' '.repeat(10) + '\x1b[0m'));
  });

  it('renderList pins a right-aligned hint (footerRight) on the footer bar', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a'], cursor: 0, row: (i, it) => it,
      footer: 'Search: ab', footerLeft: true, footerRight: 'Enter: confirm · Esc: cancel',
      cols: 40, rows: 10,
    });
    assert.ok(out.includes('Search: ab'));
    // The right hint ends the (full-width) inverted bar.
    assert.ok(/\x1b\[7m.*Enter: confirm · Esc: cancel\x1b\[0m/.test(out));
    const bar = out.split('\n').find((l) => l.includes('Search: ab'));
    assert.strictEqual(bar.replace(/\x1b\[[0-9;]*m/g, '').length, 40);
  });
});

// ───────────────────────────────────────────────────────────────────
// Interactive sessionMenu (broadcast exit + '/' search) with a stubbed TTY
// ───────────────────────────────────────────────────────────────────
async function driveSessionMenu({ sessions, current, opts = {}, keys }) {
  const saved = {
    isTTY: process.stdin.isTTY,
    setRawMode: process.stdin.setRawMode,
    resume: process.stdin.resume,
    pause: process.stdin.pause,
    write: process.stderr.write,
  };
  const output = [];
  process.stdin.isTTY = true;
  process.stdin.setRawMode = () => {};
  process.stdin.resume = () => {};
  process.stdin.pause = () => {};
  process.stderr.write = (s) => { output.push(String(s)); return true; };
  try {
    const menuPromise = binOcmux.sessionMenu(sessions, current, {}, 'http://server', opts);
    for (const [str, name, ctrl] of keys) {
      await new Promise((r) => setTimeout(r, 5));
      process.stdin.emit('keypress', str, { name, ctrl: !!ctrl, meta: false });
    }
    const result = await Promise.race([
      menuPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sessionMenu did not finish')), 2000)),
    ]);
    return { result, output };
  } finally {
    if (saved.isTTY === undefined) delete process.stdin.isTTY; else process.stdin.isTTY = saved.isTTY;
    process.stdin.setRawMode = saved.setRawMode;
    process.stdin.resume = saved.resume;
    process.stdin.pause = saved.pause;
    process.stderr.write = saved.write;
    process.stdin.removeAllListeners('keypress');
  }
}

describe('sessionMenu broadcast exit', () => {
  const sessions = [
    { id: 'sA', title: 'Alpha' },
    { id: 'sB', title: 'Beta' },
    { id: 'sC', title: 'Gamma' },
  ];

  it('ESC cancels broadcast and restores the TUI to the stored current session', async () => {
    const calls = [];
    const { result } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onPick: async (row) => { calls.push(['pick', row.id]); },
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [['', 'down'], [' ', 'space'], ['', 'escape'], ['q', 'q']],
    });
    assert.strictEqual(result, null);
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['bc', []],
      ['inspect', 'sA'],
    ]);
  });

  it('deselecting down to one session selects the remaining one', async () => {
    const calls = [];
    await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onPick: async (row) => { calls.push(['pick', row.id]); },
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [
        ['', 'down'], [' ', 'space'], // add Beta
        ['', 'down'], [' ', 'space'], // add Gamma
        ['', 'up'], [' ', 'space'],   // remove Beta
        ['', 'up'], [' ', 'space'],   // remove Alpha -> Gamma is left
        ['q', 'q'],
      ],
    });
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['inspect', 'sC'],
      ['bc', ['sA', 'sB', 'sC']],
      ['bc', ['sA', 'sC']],
      ['bc', []],
      ['pick', 'sC'],
    ]);
  });

  it('a "/" filter narrows the list live and ESC clears it', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['/', 'slash'], ['b', 'b'], ['', 'return'], ['', 'escape'], ['q', 'q']],
    });
    assert.ok(output.some((o) => o.includes('Search: b▏') && o.includes('Beta') && !o.includes('Alpha')),
      'expected a live-filtered frame showing only Beta');
    assert.ok(output.some((o) => /Search: b · \/: edit/.test(o)),
      'expected the committed filter footer to keep the pattern');
    assert.ok(output.some((o) => o.includes('Search: b') && o.includes('Enter: confirm · Esc: cancel')),
      'expected the confirm/cancel hint on the right of the search line');
    const filteredAt = output.findIndex((o) => o.includes('Search: b▏'));
    assert.ok(filteredAt >= 0);
    assert.ok(output.slice(filteredAt + 1).some((o) => o.includes('Alpha')),
      'expected ESC to restore the full list');
  });

  it('Backspace on an empty live search exits it (backspace again resumes navigation)', async () => {
    const { result, output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['/', 'slash'], ['', 'backspace'], ['', 'down'], ['q', 'q']],
    });
    assert.strictEqual(result, null);
    // Closing the search returns to the unfiltered list; the following 'q' quits.
    assert.ok(output.some((o) => o.includes('Enter: switch · Space: broadcast')),
      'expected the search to close back to the normal session list');
  });

  it('q in broadcast mode cancels back to the session list (does not quit)', async () => {
    const calls = [];
    const { result, output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [
        ['', 'down'], [' ', 'space'],   // enter broadcast with Beta
        ['q', 'q'],                     // cancels broadcast (back to sessions)
        ['h', 'h'], ['q', 'q'], ['q', 'q'], // h proves we are in the session menu
      ],
    });
    assert.strictEqual(result, null);
    assert.ok(output.some((o) => o.includes('ocmux session picker — help')),
      'expected q to return to the session menu (the help screen is reachable)');
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['bc', []],
      ['inspect', 'sA'],
    ]);
  });

  it('Ctrl+C fully exits from broadcast mode', async () => {
    const calls = [];
    const { result } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [['', 'down'], [' ', 'space'], ['', 'c', true]],
    });
    assert.strictEqual(result, null);
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['bc', []],
      ['inspect', 'sA'],
    ]);
  });

  it('Ctrl+C fully exits from the new-session input prompt', async () => {
    const { result, output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['n', 'n'], ['', 'c', true]],
    });
    assert.strictEqual(result, null);
    assert.ok(output.some((o) => o.includes('New session name')),
      'expected the input prompt before quitting');
  });

  it('shows notices about sessions moved to another directory', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: { notices: ['⚠ Current session moved to /worktree', '  Run: ocmux serve /worktree'] },
      keys: [['q', 'q']],
    });
    assert.ok(output.some(o => o.includes('Current session moved to /worktree')));
    assert.ok(output.some(o => o.includes('ocmux serve /worktree')));
  });

  it('marks a newly created session as current', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onPick: async (row) => row.new ? { id: 'sNew', title: row.name } : null,
      },
      keys: [['n', 'n'], ['N', 'N'], ['e', 'e'], ['w', 'w'], ['', 'return'], ['q', 'q']],
    });
    assert.ok(output.some(o => /New\s+\*/.test(o)), 'expected the new session to carry the current marker');
  });
});

// Interactive project switcher harness (mirrors driveSessionMenu).
async function driveSwitchMenu(rows, keys) {
  const output = [];
  const orig = {
    isTTY: process.stdin.isTTY,
    setRawMode: process.stdin.setRawMode,
    resume: process.stdin.resume,
    pause: process.stdin.pause,
  };
  const origWrite = process.stderr.write;
  process.stdin.isTTY = true;
  process.stdin.setRawMode = () => {};
  process.stdin.resume = () => {};
  process.stdin.pause = () => {};
  process.stderr.write = (s) => { output.push(String(s)); return true; };
  try {
    const p = binOcmux.switchMenu(rows, false);
    for (const [str, name, ctrl] of keys) {
      await new Promise((r) => setTimeout(r, 5));
      process.stdin.emit('keypress', str, { name, ctrl: !!ctrl, meta: false });
    }
    const result = await Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('switchMenu timed out')), 1000)),
    ]);
    return { result, output };
  } finally {
    process.stdin.isTTY = orig.isTTY;
    process.stdin.setRawMode = orig.setRawMode;
    process.stdin.resume = orig.resume;
    process.stdin.pause = orig.pause;
    process.stderr.write = origWrite;
    process.stdin.removeAllListeners('keypress');
  }
}

describe('switchMenu (project switcher)', () => {
  const rows = [
    { dir: '/proj1', status: 'running', session: 's1', index: 1 },
    { dir: '/proj2', status: 'running', session: 's2', index: 2 },
  ];

  it("'q' closes the menu without exiting (no selection => back to sessions)", async () => {
    const { result, output } = await driveSwitchMenu(rows, [['q', 'q']]);
    assert.strictEqual(result, null);
    assert.ok(output.some((o) => o.includes('project switcher')));
    assert.ok(!output.some((o) => o.includes('project switcher — help')));
  });

  it('Enter focuses a project and q returns its directory', async () => {
    const { result } = await driveSwitchMenu(rows, [['', 'return'], ['q', 'q']]);
    assert.strictEqual(result, '/proj1');
  });

  it("'h' opens the help overlay", async () => {
    const { result, output } = await driveSwitchMenu(rows, [['h', 'h'], ['q', 'q'], ['q', 'q']]);
    assert.strictEqual(result, null);
    assert.ok(output.some((o) => o.includes('project switcher — help')));
  });

  it('Ctrl+C fully exits via the SWITCH_QUIT sentinel', async () => {
    const { result } = await driveSwitchMenu(rows, [['', 'c', true]]);
    assert.strictEqual(result, binOcmux.SWITCH_QUIT);
  });

  it('search shows the confirm/cancel hint on the right', async () => {
    const { output } = await driveSwitchMenu(rows, [['/', 'slash'], ['p', 'p'], ['', 'escape'], ['q', 'q']]);
    assert.ok(output.some((o) => o.includes('Search: p') && o.includes('Enter: confirm · Esc: cancel')));
  });
});
