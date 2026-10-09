'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { EventEmitter } = require('events');

const ocmux = require('../lib/ocmux');
const binOcmux = require('../bin/ocmux');
const opencode = require('../lib/opencode');
const tuiRegistry = require('../lib/tui-registry');

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
let httpDownFor = null;       // (opts) => bool, per-request failure override
let httpResponder = null;     // (opts) => body-string | null, per-request override

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
      if (httpMode === 'down' || (httpDownFor && httpDownFor(opts))) {
        if (req._errHandler) req._errHandler(new Error('ECONNREFUSED'));
        return;
      }
      callback(res);
      const custom = httpResponder ? httpResponder(opts) : null;
      // Emit a v2 envelope so makeRequest()-based helpers settle.
      res._emit('data', custom != null ? custom : '{"data":[]}');
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
  httpDownFor = null;
  httpResponder = null;
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
  httpDownFor = null;
  httpResponder = null;
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
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(plain.includes('  a'));
    assert.ok(plain.includes('▶ b'));
    assert.ok(!out.includes('/2'));
  });

  it('paints the pointer light-yellow and keeps it visible on reverse rows', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a', 'b'], cursor: 1,
      row: (i, it) => (it === 'b' ? { text: 'b', reverse: true } : it),
      footer: 'F', cols: 40, rows: 24,
    });
    assert.ok(out.includes(`${binOcmux.LIGHT_YELLOW}▶\x1b[0m `));
    // The pointer's own reset must not swallow the row's reverse video.
    assert.ok(out.includes('\x1b[7mb\x1b[0m'));
  });

  it('uses the brown title/status bars instead of reverse video', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a'], cursor: 0, row: (i, it) => it,
      footer: 'Key hints', cols: 30, rows: 8,
    });
    const lines = out.split('\n').filter((l) => l.includes(binOcmux.BAR_BG));
    assert.strictEqual(lines.length, 2, 'expected the title and status bar');
    assert.ok(!out.includes('\x1b[7m'));
  });

  it('renders a question-bar footer on its own light-yellow background', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a'], cursor: 0, row: (i, it) => it,
      footer: 'Delete session "x"?', footerBg: binOcmux.QUESTION_BG,
      cols: 40, rows: 8,
    });
    assert.ok(out.includes(binOcmux.BAR_BG), 'title bar keeps the default background');
    const footerLine = out.split('\n').find((l) => l.startsWith(binOcmux.QUESTION_BG));
    assert.ok(footerLine && footerLine.includes('Delete session "x"?'),
      'footer bar uses the light-yellow question background');
    assert.ok(!out.includes(binOcmux.BAR_BG + 'Delete session'),
      'footer no longer uses the default background');
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

  it('colours labels light-yellow when highlighted, brown otherwise', () => {
    const s = { id: 's1', title: 'T' };
    const plain = binOcmux.sessionInfoLines(s, new Set(), new Map(), 120, false).join('\n');
    const yellow = binOcmux.sessionInfoLines(s, new Set(), new Map(), 120, true).join('\n');
    assert.ok(plain.includes(binOcmux.BROWN));
    assert.ok(!plain.includes(binOcmux.LIGHT_YELLOW));
    assert.ok(yellow.includes(binOcmux.LIGHT_YELLOW));
    assert.ok(!yellow.includes(binOcmux.BROWN));
  });
});

// ───────────────────────────────────────────────────────────────────
// TUI launch arguments (v2-only)
// ───────────────────────────────────────────────────────────────────
describe('tuiArgs', () => {
  it('uses --session when a session is given', () => {
    const args = ocmux.tuiArgs('http://127.0.0.1:4096', 'ses_1', '/proj');
    assert.deepStrictEqual(args, ['--server', 'http://127.0.0.1:4096', '--session', 'ses_1', '/proj']);
  });

  it('uses --continue when no session is given', () => {
    const args = ocmux.tuiArgs('http://127.0.0.1:4096', null, '/proj');
    assert.deepStrictEqual(args, ['--server', 'http://127.0.0.1:4096', '--continue', '/proj']);
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

  it('serve initializes project state and records the session', async () => {
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
    nodeMock.method(opencode, 'listProjects', async () => [{ canonical: '/proj1' }]);
    await runMain(['list']);
    assert.ok(stdoutOutput.join('').includes('/proj1'));
    assert.ok(stdoutOutput.join('').includes('ses_1'));
  });

  it('list reports no configured projects when OpenCode knows none', async () => {
    nodeMock.method(opencode, 'listProjects', async () => []);
    await runMain(['list']);
    assert.ok(stdoutOutput.join('').includes('No configured ocmux projects found.'));
  });

  it('session <ref> updates state even when no TUI is registered', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 'old', server: 'http://x:4096' });
    nodeMock.method(opencode, 'listSessions', async (server, dir) => [
      { id: 'ses_target', title: 'Target' },
    ]);
    await runMain(['session', 'ses_target', '/proj']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    const stateWrite = lastStateWrite('/proj');
    assert.ok(stateWrite);
    assert.strictEqual(JSON.parse(stateWrite.data).session, 'ses_target');
    assert.ok(!spawnSyncCalls.some(c => c.args[0] === 'respawn-pane'));
  });

  it('default interactive command errors when the server is down', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 's1', server: 'http://x:4096' });
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

  it('does not retain --global as a TUI option', async () => {
    await runMain(['tui', '--global']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("unknown option '--global'"));
  });

  it('accepts --shared only with tui', async () => {
    await runMain(['--shared']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.join('').includes("'--shared' is only valid"));
  });

  it('tui --list prints live runtime registrations', async () => {
    nodeMock.method(tuiRegistry, 'list', () => [{
      shared: true,
      pane: '%8',
      directory: '/proj',
      server: 'http://x:4096',
      session: 'ses_1',
    }]);
    await runMain(['tui', '--list']);
    assert.strictEqual(exitThrown, null);
    assert.ok(stdoutOutput.join('').includes('shared  %8  /proj'));
  });

  it('tui --detach --shared unregisters without killing the pane', async () => {
    const instance = { id: 'tui_1', token: 'tok', pane: '%8', shared: true };
    const calls = [];
    nodeMock.method(tuiRegistry, 'shared', () => instance);
    nodeMock.method(tuiRegistry, 'unregister', (...args) => { calls.push(args); return true; });
    await runMain(['tui', '--detach', '--shared']);
    assert.strictEqual(exitThrown, null);
    assert.deepStrictEqual(calls, [['tui_1', 'tok']]);
    assert.ok(!spawnSyncCalls.some(c => c.args.includes('kill-pane')));
  });

  it('tui --shared wraps OpenCode and unregisters when it exits', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 'ses_1', server: 'http://x:4096' });
    const calls = [];
    nodeMock.method(tuiRegistry, 'parseTmuxEnvironment', () => ({ socket: '/tmp/tmux/default', pane: '%9' }));
    nodeMock.method(tuiRegistry, 'register', (input) => {
      calls.push(['register', input]);
      return { instance: { ...input, id: 'tui_1', token: 'tok' }, displaced: { id: 'old', pid: 2 } };
    });
    nodeMock.method(tuiRegistry, 'updateInstance', (...args) => { calls.push(['update', ...args]); });
    nodeMock.method(tuiRegistry, 'unregister', (...args) => { calls.push(['unregister', ...args]); return true; });
    nodeMock.method(opencode, 'getSession', async () => ({
      id: 'ses_1', location: { directory: '/proj' },
    }));
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = () => {};
    nodeMock.method(child_process, 'spawn', (cmd, args, opts) => {
      calls.push(['spawn', cmd, args, opts]);
      process.nextTick(() => child.emit('exit', 0));
      return child;
    });
    // This is the exact argument shape generated by registry.respawn(). The
    // `--` must apply to /proj, not to the earlier `tui` positional token.
    await runMain(['tui', '--shared', '--server', 'http://x:4096', '--session-id', 'ses_1', '--', '/proj']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    assert.ok(calls.some(c => c[0] === 'register' && c[1].shared === true));
    const spawn = calls.find(c => c[0] === 'spawn');
    assert.deepStrictEqual(spawn[2], ['--server', 'http://x:4096', '--session', 'ses_1', '/proj']);
    assert.ok(calls.some(c => c[0] === 'unregister' && c[1] === 'tui_1' && c[2] === 'tok'));
  });

  it('tui --shared runs without a state file, defaulting to the default server', async () => {
    const calls = [];
    nodeMock.method(tuiRegistry, 'parseTmuxEnvironment', () => ({ socket: '/tmp/tmux/default', pane: '%9' }));
    nodeMock.method(tuiRegistry, 'register', (input) => {
      calls.push(['register', input]);
      return { instance: { ...input, id: 'tui_1', token: 'tok' }, displaced: null };
    });
    nodeMock.method(tuiRegistry, 'updateInstance', (...args) => { calls.push(['update', ...args]); });
    nodeMock.method(tuiRegistry, 'unregister', (...args) => { calls.push(['unregister', ...args]); return true; });
    nodeMock.method(opencode, 'getSession', async () => ({
      id: 'ses_1', location: { directory: process.cwd() },
    }));
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = () => {};
    nodeMock.method(child_process, 'spawn', (cmd, args, opts) => {
      calls.push(['spawn', cmd, args, opts]);
      process.nextTick(() => child.emit('exit', 0));
      return child;
    });
    const def = process.env.OCMUX_SERVER || 'http://localhost:4096';
    await runMain(['tui', '--shared', '--session-id', 'ses_1']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    const reg = calls.find(c => c[0] === 'register');
    assert.ok(reg, 'expected the shared TUI to register without a state file');
    assert.strictEqual(reg[1].shared, true);
    assert.strictEqual(reg[1].server, def);
    assert.ok(!fsWrites.some(w => String(w.path).endsWith('.ocmux.json')),
      'expected no state file to be created for the shared TUI');
  });

  it('offers to repoint a project to the default server when its own is down', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 'old', server: 'http://dead:4096' });
    httpDownFor = (opts) => opts.hostname === 'dead';
    nodeMock.method(opencode, 'listSessions', async () => [{ id: 'ses_1', title: 'One' }]);
    nodeMock.method(readline, 'createInterface', () => ({
      question: (_q, cb) => cb('y'),
      close() {},
      on() { return this; },
    }));
    await runMain(['session', 'ses_1', '/proj']);
    assert.strictEqual(exitThrown, null, 'stderr=' + JSON.stringify(stderrOutput));
    const repointed = fsWrites.some(w => String(w.path).startsWith(path.join('/proj', '.ocmux.json'))
      && String(w.data).includes('localhost:4096'));
    assert.ok(repointed, 'expected .ocmux.json to be repointed to the default server');
  });

  it('keeps the unreachable-server error when the user declines the default', async () => {
    mockFiles[path.join('/proj', '.ocmux.json')] =
      JSON.stringify({ version: 2, directory: '/proj', session: 'old', server: 'http://dead:4096' });
    httpDownFor = (opts) => opts.hostname === 'dead';
    nodeMock.method(readline, 'createInterface', () => ({
      question: (_q, cb) => cb(''),
      close() {},
      on() { return this; },
    }));
    await runMain(['session', 'ses_1', '/proj']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('not reachable')));
    assert.ok(!fsWrites.some(w => String(w.data).includes('localhost:4096')),
      'expected no repoint when the user declines');
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
    nodeMock.method(opencode, 'listProjects', async () => [{ canonical: '/proj' }]);
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

  it('--help documents --all-projects', async () => {
    await runMain(['--help']);
    const out = stderrOutput.join('');
    assert.ok(out.includes('--all-projects'), 'expected the flag in the options list');
    assert.ok(out.includes('you always return to your own project’s list.'));
  });

  it('--all-projects is a known option (dispatch still runs)', async () => {
    await runMain(['--all-projects']);
    const out = stderrOutput.join('');
    assert.strictEqual(exitThrown, 1);
    assert.ok(out.includes('no .ocmux.json found'), 'expected the default command to dispatch');
    assert.ok(!out.includes('unknown option'));
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
    assert.ok(out.includes(binOcmux.BAR_BG + 'Search: ab' + ' '.repeat(10) + '\x1b[0m'));
  });

  it('renderList pins a right-aligned hint (footerRight) on the status bar', () => {
    const out = binOcmux.renderList({
      title: 'T', items: ['a'], cursor: 0, row: (i, it) => it,
      footer: 'Search: ab', footerLeft: true, footerRight: 'Enter: confirm · Esc: cancel',
      cols: 40, rows: 10,
    });
    assert.ok(out.includes('Search: ab'));
    const bar = out.split('\n').find((l) => l.includes('Enter: confirm · Esc: cancel'));
    assert.ok(bar && bar.includes(binOcmux.BAR_BG), 'expected the hint on the status bar');
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

  it('deleting the current session adopts and highlights the next one', async () => {
    const calls = [];
    const { output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onDelete: async (row) => { calls.push(['delete', row.id]); },
        onPick: async (row) => { calls.push(['pick', row.id]); },
      },
      keys: [['d', 'd'], ['y', 'y'], ['q', 'q']],
    });
    // The row under the cursor (Beta) becomes the new current: it is recorded
    // (onPick -> applySession in the real caller) and highlighted.
    assert.deepStrictEqual(calls, [['delete', 'sA'], ['pick', 'sB']]);
    assert.ok(output.some(o => /Beta\s+\*/.test(o)),
      'expected the adopted session to carry the current marker');
  });

  it('deleting a non-current session leaves the current selection alone', async () => {
    const calls = [];
    const { output } = await driveSessionMenu({
      sessions, current: 'sB',
      opts: {
        onDelete: async (row) => { calls.push(['delete', row.id]); },
        onPick: async (row) => { calls.push(['pick', row.id]); },
      },
      keys: [['d', 'd'], ['y', 'y'], ['q', 'q']],
    });
    assert.deepStrictEqual(calls, [['delete', 'sA']]);
    assert.ok(output.some(o => /Beta\s+\*/.test(o)),
      'expected Beta to stay the highlighted current session');
  });

  it('D asks to delete ALL selected sessions in the status bar', async () => {
    const calls = [];
    const { output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onDelete: async (row) => { calls.push(['delete', row.id]); },
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [
        ['', 'down'], [' ', 'space'],   // broadcast with Beta
        ['', 'down'], [' ', 'space'],   // add Gamma
        ['D', 'd'],                     // Shift+d → delete all
        ['', 'escape'],                 // cancel (back to broadcast)
        ['q', 'q'],                     // cancel broadcast
        ['', 'escape'],                 // ignore stray escape
        ['q', 'q'],                     // quit
      ],
    });
    const frame = output.find((o) => o.includes('Delete all 3 selected sessions?'));
    assert.ok(frame, 'expected a delete-all confirmation frame');
    const isBar = (l) => l.startsWith(binOcmux.BAR_BG) || l.startsWith(binOcmux.QUESTION_BG);
    const bar = frame.split('\n').filter(isBar).pop() || '';
    assert.ok(bar.includes('Delete all 3 selected sessions?'), 'prompt should be in the status bar');
    assert.ok(bar.includes('y: delete'), 'expected the confirm hint');
    assert.ok(bar.includes('n/Esc: cancel'), 'expected the cancel hint');
    assert.ok(bar.startsWith(binOcmux.QUESTION_BG),
      'expected the question bar in light yellow (matching the list pointer)');
    assert.ok(!frame.split('\n').some(l => l.includes('Delete all 3') && !isBar(l)),
      'prompt should not sit in the list area');
    // Cancelling must not delete anything.
    assert.ok(!calls.some((c) => c[0] === 'delete'), 'expected no deletes after cancelling');
  });

  it('D + y deletes every broadcast-selected session and adopts the cursor row', async () => {
    const calls = [];
    const four = [
      { id: 'sA', title: 'Alpha' },
      { id: 'sB', title: 'Beta' },
      { id: 'sC', title: 'Gamma' },
      { id: 'sD', title: 'Delta' },
    ];
    const { output } = await driveSessionMenu({
      sessions: four, current: 'sA',
      opts: {
        onDelete: async (row) => { calls.push(['delete', row.id]); },
        onPick: async (row) => { calls.push(['pick', row.id]); },
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [
        ['', 'down'], [' ', 'space'],   // broadcast with Beta
        ['', 'down'], [' ', 'space'],   // add Gamma (Delta stays unselected)
        ['D', 'd'],                     // Shift+d → delete all
        ['y', 'y'],                     // confirm
        ['q', 'q'],                     // quit
      ],
    });
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['inspect', 'sC'],
      ['bc', ['sA', 'sB', 'sC']],
      ['delete', 'sA'],
      ['delete', 'sB'],
      ['delete', 'sC'],
      ['bc', []],
      ['pick', 'sD'],
    ]);
    // The surviving Delta becomes the new current (highlighted), matching the
    // single-delete behavior.
    assert.ok(output.some(o => /Delta\s+\*/.test(o)),
      'expected the surviving session to carry the current marker');
  });

  it('D + n cancels and keeps the broadcast selection intact', async () => {
    const calls = [];
    const { result } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: {
        onDelete: async (row) => { calls.push(['delete', row.id]); },
        onBroadcastChange: (ids) => calls.push(['bc', ids.slice()]),
        onInspectSession: (id) => calls.push(['inspect', id]),
      },
      keys: [
        ['', 'down'], [' ', 'space'],   // broadcast with Beta
        ['', 'down'], [' ', 'space'],   // add Gamma
        ['D', 'd'],                     // Shift+d → delete all
        ['n', 'n'],                     // decline
        ['q', 'q'],                     // cancel broadcast
        ['q', 'q'],                     // quit
      ],
    });
    assert.strictEqual(result, null);
    assert.deepStrictEqual(calls, [
      ['bc', ['sA', 'sB']],
      ['inspect', 'sB'],
      ['inspect', 'sC'],
      ['bc', ['sA', 'sB', 'sC']],
      ['bc', []],
      ['inspect', 'sA'],
    ]);
  });
});

describe('sessionMenu status-bar prompts', () => {
  const sessions = [
    { id: 'sA', title: 'Alpha' },
    { id: 'sB', title: 'Beta' },
  ];

  // The status bar is the last bar-background line of a frame (the first such
  // line is the title). d/n/r/R prompts must live there, not in the list area,
  // and the bar flips to light yellow (QUESTION_BG) while a prompt is active.
  const isBar = (l) => l.startsWith(binOcmux.BAR_BG) || l.startsWith(binOcmux.QUESTION_BG);
  const statusBar = (frame) => {
    const lines = frame.split('\n').filter(isBar);
    return lines[lines.length - 1] || '';
  };
  const outsideBar = (frame, needle) =>
    frame.split('\n').some((l) => l.includes(needle) && !isBar(l));
  const assertQuestionBar = (bar) => {
    assert.ok(bar.startsWith(binOcmux.QUESTION_BG),
      'expected the question bar in light yellow (matching the list pointer)');
    return bar;
  };

  it('n asks for the new name in the status bar with keep/cancel hints', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['n', 'n'], ['', 'escape'], ['q', 'q']],
    });
    const frame = output.find((o) => o.includes('New session name'));
    assert.ok(frame, 'expected a create-name prompt frame');
    const bar = assertQuestionBar(statusBar(frame));
    assert.ok(bar.includes('New session name'), 'prompt should be in the status bar');
    assert.ok(bar.includes('Enter: create'), 'expected the confirm hint');
    assert.ok(bar.includes('Esc: cancel'), 'expected the cancel hint');
    assert.ok(!outsideBar(frame, 'New session name'), 'prompt should not sit in the list area');
  });

  it('r asks for the new name in the status bar', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['r', 'r'], ['', 'escape'], ['q', 'q']],
    });
    const frame = output.find((o) => o.includes('Rename to:'));
    assert.ok(frame, 'expected a rename prompt frame');
    const bar = assertQuestionBar(statusBar(frame));
    assert.ok(bar.includes('Rename to:'), 'prompt should be in the status bar');
    assert.ok(bar.includes('Enter: rename'));
    assert.ok(bar.includes('Esc: cancel'));
    assert.ok(!outsideBar(frame, 'Rename to:'), 'prompt should not sit in the list area');
  });

  it('R asks for the reminder in the status bar', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['R', 'R'], ['', 'escape'], ['q', 'q']],
    });
    const frame = output.find((o) => o.includes('Reminder (blank clears)'));
    assert.ok(frame, 'expected a reminder prompt frame');
    const bar = assertQuestionBar(statusBar(frame));
    assert.ok(bar.includes('Reminder (blank clears)'), 'prompt should be in the status bar');
    assert.ok(bar.includes('Enter: save'));
    assert.ok(bar.includes('Esc: cancel'));
    assert.ok(!outsideBar(frame, 'Reminder'), 'prompt should not sit in the list area');
  });

  it('d asks for delete confirmation in the status bar', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['d', 'd'], ['', 'escape'], ['q', 'q']],
    });
    const frame = output.find((o) => o.includes('Delete session'));
    assert.ok(frame, 'expected a delete-confirmation frame');
    const bar = assertQuestionBar(statusBar(frame));
    assert.ok(bar.includes('Delete session "Alpha"?'), 'prompt should be in the status bar');
    assert.ok(bar.includes('y: delete'));
    assert.ok(bar.includes('n/Esc: cancel'));
    assert.ok(!outsideBar(frame, 'Delete session'), 'prompt should not sit in the list area');
  });
});

// Interactive project switcher harness (mirrors driveSessionMenu).
async function driveSwitchMenu(rows, keys, options = {}) {
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
    const p = binOcmux.switchMenu(rows, options);
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
    { dir: '/proj1', status: 'running', session: 's1', index: 1, server: 'http://server' },
    { dir: '/proj2', status: 'running', session: 's2', index: 2, server: 'http://server' },
  ];
  // A project window recorded before `--server` was mandatory.
  const noServerRows = [
    { dir: '/proj1', status: 'running', session: 's1', index: 1 },
    { dir: '/proj2', status: 'running', session: 's2', index: 2 },
  ];

  it("'q' closes the menu without exiting (no selection => back to sessions)", async () => {
    const { result, output } = await driveSwitchMenu(rows, [['q', 'q']]);
    assert.strictEqual(result, null);
    assert.ok(output.some((o) => o.includes('project switcher')));
    assert.ok(!output.some((o) => o.includes('project switcher — help')));
  });

  it('Enter routes a project for inspection but never leaves the current project', async () => {
    const opened = [];
    const { result, output } = await driveSwitchMenu(rows, [['', 'return'], ['q', 'q']], {
      onOpen: (project, id) => opened.push([project.dir, id]),
    });
    assert.strictEqual(result, null, 'the switcher must not move the picker by default');
    assert.deepStrictEqual(opened, [['/proj1', 's1']]);
    assert.ok(output.some((o) => o.includes('Enter: view')), 'expected the inspect-mode status bar');
    assert.strictEqual(fsWrites.length, 0, '.ocmux.json must stay untouched');
  });

  it('--all-projects lets Enter move the picker to the selected project', async () => {
    const { result, output } = await driveSwitchMenu(rows, [['', 'return'], ['q', 'q']], { allProjects: true });
    assert.strictEqual(result, '/proj1');
    assert.ok(output.some((o) => o.includes('Enter: switch')), 'expected the switch-mode status bar');
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

  const serveProjectSessions = () => {
    httpResponder = (opts) => (opts.path && opts.path.startsWith('/api/session')
      ? JSON.stringify({ data: [
          { id: 'sX', title: 'Other', time: {} },
          { id: 's1', title: 'Stored', time: {} },
        ] })
      : null);
  };
  const projRows = [{ dir: '/proj1', status: 'alive', session: 's1', index: 1, server: 'http://server' }];
  const viewSessionKeys = [
    [' ', 'space'],   // unfold
    ['', 'down'],     // first session row
    ['', 'return'],   // show it in the TUI
    ['q', 'q'],       // leave the switcher
  ];

  it('Space unfolds a project’s sessions and Enter views one without writing state', async () => {
    serveProjectSessions();
    const opened = [];
    const { result, output } = await driveSwitchMenu(projRows, viewSessionKeys, {
      onOpen: (project, id) => opened.push([project.dir, id]),
    });
    assert.strictEqual(result, null, 'inspection must not move the picker');
    const frame = output.find((o) => o.includes('Other'));
    assert.ok(frame, 'expected unfolded session rows');
    const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(plain.includes('▾ proj1'), 'expected the project shown as unfolded');
    assert.ok(plain.includes('Stored  *  s1'), 'expected the stored session marked');
    assert.deepStrictEqual(opened, [['/proj1', 'sX']]);
    assert.strictEqual(fsWrites.length, 0, '.ocmux.json must stay untouched (view selector)');
  });

  it('--all-projects lets a session row move the picker to that project', async () => {
    serveProjectSessions();
    const opened = [];
    const { result } = await driveSwitchMenu(projRows, viewSessionKeys, {
      allProjects: true,
      onOpen: (project, id) => opened.push([project.dir, id]),
    });
    assert.strictEqual(result, '/proj1');
    assert.deepStrictEqual(opened, [['/proj1', 'sX']]);
    assert.strictEqual(fsWrites.length, 0, 'the switcher itself never writes state');
  });

  it('Space on a project without a server reports it; Enter does not route it', async () => {
    const opened = [];
    const { result, output } = await driveSwitchMenu(noServerRows, [[' ', 'space'], ['', 'return'], ['q', 'q']], {
      onOpen: (project, id) => opened.push([project.dir, id]),
    });
    assert.strictEqual(result, null, 'inspection must not move the picker');
    assert.deepStrictEqual(opened, []);
    const plain = output.map((o) => o.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    assert.ok(plain.includes('! proj1: no server recorded'), 'expected a fold error, not a hang');
    const unfolded = output.find((o) => o.includes('no server recorded'));
    assert.ok(unfolded && unfolded.includes('▾ proj1'), 'expected the project shown as open');
  });

  it('help explains the mode: inspect-only vs --all-projects', async () => {
    const inspect = await driveSwitchMenu(rows, [['h', 'h'], ['q', 'q'], ['q', 'q']]);
    assert.ok(inspect.output.some((o) => o.includes('You always come back to your own project’s list')));
    const multi = await driveSwitchMenu(rows, [['h', 'h'], ['q', 'q'], ['q', 'q']], { allProjects: true });
    assert.ok(multi.output.some((o) => o.includes('--all-projects: selecting moves the picker')));
    assert.ok(multi.output.some((o) => o.includes('ocmux — project switcher (all projects)')));
  });
});

// ───────────────────────────────────────────────────────────────────
// Model picker: sorted by provider, cursor on the current model
// ───────────────────────────────────────────────────────────────────
describe('model picker ordering', () => {
  const models = [
    { providerID: 'zzz', id: 'model' },
    { providerID: 'aaa', id: 'model' },
    { providerID: 'openai', id: 'gpt' },
  ];
  const sortedLabels = ['aaa/model', 'openai/gpt', 'zzz/model'];
  const serveModels = () => {
    httpResponder = (opts) => (opts.path && opts.path.startsWith('/api/model')
      ? JSON.stringify({ data: models })
      : null);
  };
  const pointerLine = (output, title = 'ocmux — Models') => {
    const frame = output.find((o) => o.includes(title));
    assert.ok(frame, `expected "${title}" to open`);
    const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
    const order = sortedLabels.map((t) => plain.indexOf(t));
    assert.ok(order.every((v) => v >= 0), 'expected every model listed');
    assert.ok(order[0] < order[1] && order[1] < order[2], 'expected models sorted by provider');
    return plain.split('\n').find((l) => l.includes('▶'));
  };

  it('sortModels orders by provider then id', () => {
    const sorted = binOcmux.sortModels(models);
    assert.deepStrictEqual(sorted.map((m) => `${m.providerID}/${m.id}`), sortedLabels);
    assert.deepStrictEqual(binOcmux.sortModels(null), []);
  });

  it('indexOfModel locates a session’s current model (or -1)', () => {
    // `models` is deliberately unsorted: openai/gpt sits at index 2 there.
    assert.strictEqual(binOcmux.indexOfModel(models, { providerID: 'openai', id: 'gpt' }), 2);
    assert.strictEqual(binOcmux.indexOfModel(models, { providerID: 'OpenAI', id: 'GPT' }), 2);
    assert.strictEqual(binOcmux.indexOfModel(models, { providerID: 'nope', id: 'x' }), -1);
    assert.strictEqual(binOcmux.indexOfModel(models, null), -1);
  });

  it('m opens the picker with the cursor on the current model', async () => {
    serveModels();
    const { output } = await driveSessionMenu({
      sessions: [{ id: 'sA', title: 'Alpha', model: { providerID: 'openai', id: 'gpt' } }],
      current: 'sA', opts: {},
      keys: [['m', 'm'], ['q', 'q'], ['q', 'q']],
    });
    assert.strictEqual(pointerLine(output), '▶ openai/gpt');
  });

  it('broadcast m starts from the cursor session’s model', async () => {
    serveModels();
    const { output } = await driveSessionMenu({
      sessions: [
        { id: 'sA', title: 'Alpha', model: { providerID: 'openai', id: 'gpt' } },
        { id: 'sB', title: 'Beta', model: { providerID: 'aaa', id: 'model' } },
      ],
      current: 'sA', opts: {},
      keys: [['', 'down'], [' ', 'space'], ['m', 'm'], ['q', 'q'], ['q', 'q'], ['q', 'q']],
    });
    assert.strictEqual(pointerLine(output, 'ocmux — Broadcast model'), '▶ aaa/model');
  });
});

// ───────────────────────────────────────────────────────────────────
// The session list names the project it is showing
// ───────────────────────────────────────────────────────────────────
describe('session list title', () => {
  const sessions = [{ id: 'sA', title: 'Alpha' }];

  it('heads the title bar with the project name', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA',
      opts: { dir: '/home/joanmi/Nextcloud/prj/tools/agentp' },
      keys: [['q', 'q']],
    });
    assert.ok(output.some((o) => o.includes('ocmux — agentp sessions')));
    assert.ok(!output.some((o) => o.includes('ocmux — sessions')),
      'the bare title must not appear once a project is known');
  });

  it('falls back to the plain title when no project dir is given', async () => {
    const { output } = await driveSessionMenu({
      sessions, current: 'sA', opts: {},
      keys: [['q', 'q']],
    });
    assert.ok(output.some((o) => o.includes('ocmux — sessions')));
  });
});
