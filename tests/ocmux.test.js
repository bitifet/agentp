'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ocmux = require('../lib/ocmux');
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
    on(ev, fn) { return this; },
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
      if (httpMode === 'ok') {
        callback(res);
      } else if (httpMode === 'down' && req._errHandler) {
        req._errHandler(new Error('ECONNREFUSED'));
      }
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

  it('switch errors without a TTY', async () => {
    process.stdin.isTTY = false;
    await runMain(['switch']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes('requires a TTY')));
  });

  it('switch reports no projects when there are none', async () => {
    tmuxHandler = (args) => (args[0] === 'has-session' ? tmuxFail(1) : tmuxOk(''));
    await runMain(['switch']);
    assert.ok(stdoutOutput.join('').includes('No opencode projects running.'));
  });

  it('switch rejects a directory argument', async () => {
    await runMain(['switch', '/proj']);
    assert.strictEqual(exitThrown, 1);
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

  it('model without a state file errors', async () => {
    await runMain(['model', 'deepseek']);
    assert.strictEqual(exitThrown, 1);
  });

  it('rejects --git with model', async () => {
    await runMain(['--git', 'model']);
    assert.strictEqual(exitThrown, 1);
    assert.ok(stderrOutput.some(s => s.includes("'--git' and '--GIT' are only valid with 'serve'")));
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