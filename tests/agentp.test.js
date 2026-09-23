'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const { Readable, Writable } = require('stream');

const opencode = require('../lib/opencode');

// ── Mock http.request ──────────────────────────────────────────────
let mockCfg = null;
let mockCallIdx = 0;

function mockHttpRequest(opts, callback) {
  if (!mockCfg) throw new Error('setupMock() not called');

  mockCallIdx++;

  if (typeof mockCfg.factory === 'function') {
    const overrides = mockCfg.factory(mockCallIdx, opts) || {};
    Object.assign(mockCfg, overrides);
  }

  const res = {
    statusCode: mockCfg.status != null ? mockCfg.status : 200,
    _listeners: {},
    on(ev, fn) {
      if (!this._listeners[ev]) this._listeners[ev] = [];
      this._listeners[ev].push(fn);
      return this;
    },
    _emit(ev, data) {
      (this._listeners[ev] || []).forEach(fn => fn(data));
    },
    resume() {},
    destroy() {},
  };

  const req = {
    _errHandler: null,
    _written: [],
    on(ev, fn) {
      if (ev === 'error') this._errHandler = fn;
      return this;
    },
    setTimeout(ms, fn) {
      if (mockCfg.timeout) fn();
    },
    write(d) { this._written.push(d); },
    destroy() {},
    end() {
      if (mockCfg.netError && req._errHandler) {
        req._errHandler(mockCfg.netError);
        return;
      }
      mockCfg._lastReq = { opts, req, res };
      callback(res);
      if (mockCfg.body != null) {
        const data = Buffer.isBuffer(mockCfg.body) ? mockCfg.body : String(mockCfg.body);
        res._emit('data', data);
        res._emit('end');
      } else {
        res._emit('end');
      }
    },
  };

  return req;
}

// ── Mock infrastructure for process ──────────────────────────────
let stdout = [];
let stderr = [];
let logs = [];
let errors = [];
let originalExit;
let originalStdin;
let originalStdout;
let originalStderr;
let originalLog;
let originalError;
let originalReadFileSync;

function setupProcessMocks() {
  stdout = [];
  stderr = [];
  logs = [];
  errors = [];

  originalExit = process.exit;
  originalStdin = process.stdin;
  originalStdout = process.stdout;
  originalStderr = process.stderr;
  originalLog = console.log;
  originalError = console.error;
  originalReadFileSync = fs.readFileSync;

  // Replace stdout with a Writable that captures (and does NOT pass through):
  // forwarding chunks to the real stdout can interleave with the test runner's
  // own stdout framing under parallel load, corrupting the parent's IPC parse.
  const capOut = new Writable({
    write(chunk, encoding, callback) {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      callback();
    }
  });
  Object.defineProperty(process, 'stdout', {
    get: () => capOut,
    configurable: true,
    enumerable: true,
  });

  // stderr: simple mock is safe (doesn't break node:test IPC or suite detection)
  process.stderr.write = (chunk) => { stderr.push(chunk); return true; };

  process.exit = (code) => {
    throw new Error(`EXIT:${code}`);
  };
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  fs.readFileSync = (path, encoding) => {
    if (mockCfg && mockCfg._fsFiles && mockCfg._fsFiles[path] !== undefined) {
      if (mockCfg._fsFiles[path] === 'ENOENT') {
        throw new Error('ENOENT');
      }
      return mockCfg._fsFiles[path];
    }
    return originalReadFileSync(path, encoding);
  };
}

function tearDownProcessMocks() {
  process.exit = originalExit;
  Object.defineProperty(process, 'stdin', {
    value: originalStdin,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process, 'stdout', {
    get: () => originalStdout,
    configurable: true,
    enumerable: true,
  });
  process.stderr.write = originalStderr.write.bind(originalStderr);
  console.log = originalLog;
  console.error = originalError;
  fs.readFileSync = originalReadFileSync;
}

function setupOpencodeMocks() {
  mockCfg = {};
  mockCallIdx = 0;
  http.request = mockHttpRequest;

  nodeMock.method(opencode, 'listSessions', async (server) => {
    mockCfg._listSessionsCalled = server;
    return mockCfg.sessions || [];
  });
  nodeMock.method(opencode, 'createSession', async (server, title) => {
    mockCfg._createSessionCalled = { server, title };
    return mockCfg.newSession || { id: 'new-session-id', title };
  });
  nodeMock.method(opencode, 'sendToSession', async (server, sessionId, text) => {
    mockCfg._sendToSessionCalled = { server, sessionId, text };
    return mockCfg.answer || 'test answer';
  });
  nodeMock.method(opencode, 'sendToSessionAsync', async (server, sessionId, text) => {
    mockCfg._sendToSessionAsyncCalled = { server, sessionId, text };
    if (mockCfg._sendToSessionAsyncHook) await mockCfg._sendToSessionAsyncHook(server, sessionId, text);
  });
  nodeMock.method(opencode, 'getSession', async (server, sessionId) => {
    mockCfg._getSessionCalled = { server, sessionId };
    return mockCfg.session || null;
  });
  nodeMock.method(opencode, 'selectSession', async (server, sessionId) => {
    mockCfg._selectSessionCalled = { server, sessionId };
    return mockCfg.selectResult;
  });
}

function tearDownOpencodeMocks() {
  nodeMock.restoreAll();
  mockCfg = null;
  mockCallIdx = 0;
}

function provideStdin(text) {
  const stdin = new Readable({ read() {} });
  stdin.push(text);
  stdin.push(null);
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
}

function setArgv(args) {
  process.argv = ['node', 'agentp', ...args];
}

// ── Tests ──────────────────────────────────────────────────────────

describe('agentp CLI', () => {
  before(() => {
    setupProcessMocks();
  });
  after(() => {
    tearDownProcessMocks();
  });

  beforeEach(() => {
    setupOpencodeMocks();
    stdout = [];
    stderr = [];
    logs = [];
    errors = [];
  });

  afterEach(() => {
    tearDownOpencodeMocks();
    delete require.cache[require.resolve('../bin/agentp')];
  });

  describe('argument parsing', () => {
    it('--version prints version and exits', async () => {
      setArgv(['--version']);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes(require('../package.json').version));
    });

    it('--help prints help and exits', async () => {
      setArgv(['--help']);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.ok(errors.some(e => e.includes('Usage:')));
    });

    it('--session without value errors', async () => {
      setArgv(['--session']);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('--session requires')));
    });

    it('unknown option errors', async () => {
      setArgv(['--unknown']);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('unknown option')));
    });

    it('unexpected argument errors', async () => {
      setArgv(['foo']);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('unexpected argument')));
    });

    it('port number sets server base', async () => {
      setArgv(['8080']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._listSessionsCalled, 'http://localhost:8080');
      assert.strictEqual(mockCfg._sendToSessionCalled.server, 'http://localhost:8080');
    });

    it('URL argument sets server base', async () => {
      setArgv(['http://192.168.1.1:5000/']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._listSessionsCalled, 'http://192.168.1.1:5000');
    });
  });

  describe('session selection', () => {
    it('uses exact session match with --session', async () => {
      setArgv(['--session', 'My Task']);
      provideStdin('hello');
      mockCfg.sessions = [
        { id: 's1', title: 'My Task', time: { updated: 1 } },
        { id: 's2', title: 'Other', time: { updated: 2 } },
      ];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._sendToSessionCalled.sessionId, 's1');
    });

    it('uses partial session match with --session', async () => {
      setArgv(['--session', 'Task']);
      provideStdin('hello');
      mockCfg.sessions = [
        { id: 's1', title: 'My Task', time: { updated: 1 } },
      ];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._sendToSessionCalled.sessionId, 's1');
    });

    it('errors on multiple partial matches with --session', async () => {
      setArgv(['--session', 'Task']);
      provideStdin('hello');
      mockCfg.sessions = [
        { id: 's1', title: 'My Task', time: { updated: 1 } },
        { id: 's2', title: 'Your Task', time: { updated: 2 } },
      ];
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('multiple sessions match')));
    });

    it('creates new session with --session --new', async () => {
      setArgv(['--session', 'New Task', '--new']);
      provideStdin('hello');
      mockCfg.sessions = [];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.deepStrictEqual(mockCfg._createSessionCalled, { server: 'http://localhost:4096', title: 'New Task' });
      assert.strictEqual(mockCfg._sendToSessionCalled.text, 'hello\n');
    });

    it('errors when no session matches and not --new', async () => {
      setArgv(['--session', 'Missing']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'Other', time: { updated: 1 } }];
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('no session found matching')));
    });

    it('picks most recent session without --session', async () => {
      setArgv([]);
      provideStdin('hello');
      mockCfg.sessions = [
        { id: 's1', title: 'Old', time: { updated: 1 } },
        { id: 's2', title: 'New', time: { updated: 3 } },
        { id: 's3', title: 'Mid', time: { updated: 2 } },
      ];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._sendToSessionCalled.sessionId, 's2');
    });

    it('uses time.created as fallback for sorting', async () => {
      setArgv([]);
      provideStdin('hello');
      mockCfg.sessions = [
        { id: 's1', title: 'No updated', time: { created: 5 } },
        { id: 's2', title: 'Has updated', time: { updated: 3, created: 1 } },
      ];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.strictEqual(mockCfg._sendToSessionCalled.sessionId, 's1');
    });

    it('creates agentp session when no sessions exist', async () => {
      setArgv([]);
      provideStdin('hello');
      mockCfg.sessions = [];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.deepStrictEqual(mockCfg._createSessionCalled, { server: 'http://localhost:4096', title: 'agentp' });
    });
  });

  describe('output formatting', () => {
    it('outputs plain answer without --qa', async () => {
      setArgv([]);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      assert.ok(stdout.some(s => s.includes('hi')));
      assert.ok(stdout.some(s => s.includes('\n')));
    });

    it('outputs QA pair with --qa', async () => {
      setArgv(['--qa']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg.answer = 'hi';
      const { main } = require('../bin/agentp');
      await main();
      const output = stdout.join('');
      assert.ok(output.includes('👤:'));
      assert.ok(output.includes('🤖:'));
      assert.ok(output.includes('hello'));
      assert.ok(output.includes('hi'));
    });
  });

  describe('tgagentp gateway', () => {
    it('--tg errors when gateway file missing', async () => {
      setArgv(['--tg']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg._fsFiles = { '/tmp/tgagentp-port': 'ENOENT' };
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(errors.some(e => e.includes('tgagentp gateway not found')));
    });

    it('notifies gateway when tgPort is available', async () => {
      setArgv(['--tg']);
      provideStdin('hello');
      mockCfg.sessions = [{ id: 's1', title: 'test', time: { updated: 1 } }];
      mockCfg.answer = 'hi';
      mockCfg.body = JSON.stringify({ ok: true, buffered: [] });
      mockCfg._fsFiles = { '/tmp/tgagentp-port': '12345' };
      const { main } = require('../bin/agentp');
      await main();
      assert.ok(mockCfg._lastReq);
      assert.strictEqual(mockCfg._lastReq.opts.path, '/send');
      assert.strictEqual(mockCfg._lastReq.opts.port, '12345');
    });
  });

  describe('notifyAgentpGateway', () => {
    it('resolves with buffered messages on success', async () => {
      mockCfg.body = JSON.stringify({ ok: true, buffered: [{ role: 'user', text: 'hi' }] });
      const { notifyAgentpGateway } = require('../bin/agentp');
      const result = await notifyAgentpGateway(12345, 'http://localhost:4096', 'test');
      assert.deepStrictEqual(result, [{ role: 'user', text: 'hi' }]);
    });

    it('resolves with empty array on invalid JSON', async () => {
      mockCfg.body = 'not json';
      const { notifyAgentpGateway } = require('../bin/agentp');
      const result = await notifyAgentpGateway(12345, 'http://localhost:4096', 'test');
      assert.deepStrictEqual(result, []);
    });

    it('rejects on non-200 status', async () => {
      mockCfg.status = 500;
      mockCfg.body = 'Internal Error';
      const { notifyAgentpGateway } = require('../bin/agentp');
      await assert.rejects(
        notifyAgentpGateway(12345, 'http://localhost:4096', 'test'),
        /status 500/
      );
    });

    it('rejects on network error', async () => {
      mockCfg.netError = new Error('ECONNREFUSED');
      const { notifyAgentpGateway } = require('../bin/agentp');
      await assert.rejects(
        notifyAgentpGateway(12345, 'http://localhost:4096', 'test'),
        /ECONNREFUSED/
      );
    });

    it('rejects on timeout', async () => {
      mockCfg.timeout = true;
      const { notifyAgentpGateway } = require('../bin/agentp');
      await assert.rejects(
        notifyAgentpGateway(12345, 'http://localhost:4096', 'test'),
        /Connection timed out/
      );
    });
  });

  describe('deferred execution', () => {
    beforeEach(() => {
      // Mock child spawn so no real detached process runs. When _spawnAnswer
      // is set, simulate a completed child: write the answer and release the lock.
      nodeMock.method(child_process, 'spawn', (cmd, args, opts) => {
        mockCfg._spawn = { cmd, args, opts };
        if (mockCfg._spawnAnswer !== undefined) {
          const outIdx = args.indexOf('--output-file');
          if (outIdx !== -1) {
            const out = args[outIdx + 1];
            fs.writeFileSync(out, mockCfg._spawnAnswer);
            try { fs.unlinkSync(out + '.lock'); } catch {}
          }
        }
        return { unref() {} };
      });
    });

    function cleanupSpawnFiles() {
      if (!mockCfg._spawn) return;
      const args = mockCfg._spawn.args;
      for (const flag of ['--prompt-file', '--output-file']) {
        const idx = args.indexOf(flag);
        if (idx !== -1) {
          try { fs.unlinkSync(args[idx + 1]); } catch {}
          try { fs.unlinkSync(args[idx + 1] + '.lock'); } catch {}
        }
      }
    }

    function parseTicketOutput() {
      const out = stdout.join('');
      assert.ok(out.startsWith('agentp_ticket '), `expected ticket, got: ${out}`);
      return JSON.parse(out.slice('agentp_ticket '.length).trim());
    }

    it('--defer returns a ticket immediately', async () => {
      setArgv(['--defer']);
      provideStdin('hello');
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const t = parseTicketOutput();
      assert.strictEqual(typeof t.ctime, 'string');
      assert.strictEqual(typeof t.path, 'string');
      assert.ok(!('elapsed' in t));
      assert.ok(!('defer' in t));
      assert.strictEqual(t.server, 'http://localhost:4096');
      assert.strictEqual(t.sessionId, 'new-session-id');
      assert.ok(mockCfg._spawn.args.includes('--defer-child'));
      cleanupSpawnFiles();
    });

    it('--defer N includes the defer field in the ticket', async () => {
      setArgv(['--defer', '1']);
      provideStdin('hello');
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const t = parseTicketOutput();
      assert.strictEqual(t.defer, 1);
      assert.strictEqual(t.server, 'http://localhost:4096');
      assert.strictEqual(t.sessionId, 'new-session-id');
      assert.ok(!('elapsed' in t));
      cleanupSpawnFiles();
    });

    it('--onlineTicket prints a compact single-line ticket', async () => {
      setArgv(['--defer', '--onlineTicket']);
      provideStdin('hello');
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const out = stdout.join('').trim();
      assert.ok(out.startsWith('agentp_ticket {'), `expected single-line ticket, got: ${out}`);
      assert.ok(!out.includes('\n'), `expected single line, got: ${out}`);
      const t = parseTicketOutput();
      assert.strictEqual(typeof t.path, 'string');
      cleanupSpawnFiles();
    });

    it('--defer N returns the answer when it arrives within the timeout', async () => {
      setArgv(['--defer', '5']);
      provideStdin('hello');
      mockCfg._spawnAnswer = 'the fast answer';
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const out = stdout.join('');
      assert.ok(out.includes('the fast answer'));
      assert.ok(!out.includes('agentp_ticket'));
      cleanupSpawnFiles();
    });

    it('retrieves the answer from a ticket and removes the temp file', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_retrieve_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, 'the stored answer');
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}"}`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.ok(stdout.join('').includes('the stored answer'));
      assert.ok(!fs.existsSync(tmp));
    });

    it('re-prints the ticket with elapsed when the answer is not ready', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_wait_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, '');
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}"}`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const t = parseTicketOutput();
      assert.ok(t.elapsed >= 0);
      assert.ok(!('defer' in t));
      try { fs.unlinkSync(tmp); } catch {}
    });

    it('queues follow-up text from a not-ready ticket to the original session', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, '');
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}\nPlease also consider edge cases.\n`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.deepStrictEqual(mockCfg._sendToSessionAsyncCalled, {
        server: 'http://localhost:9999',
        sessionId: 's42',
        text: 'Please also consider edge cases.',
      });
      const t = parseTicketOutput();
      assert.strictEqual(t.server, 'http://localhost:9999');
      assert.strictEqual(t.sessionId, 's42');
      assert.ok(t.elapsed >= 0);
      assert.ok(!stdout.join('').includes('Please also consider edge cases.'));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(tmp + '.followups', 'utf8')), ['Please also consider edge cases.']);
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '.followups'); } catch {}
    });

    it('stores but does not print queued follow-up text after a not-ready ticket in QA mode', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_qa_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, '');
      setArgv(['--defer', '--qa']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}\nPlease also consider edge cases.\n`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.deepStrictEqual(mockCfg._sendToSessionAsyncCalled, {
        server: 'http://localhost:9999',
        sessionId: 's42',
        text: 'Please also consider edge cases.',
      });
      const out = stdout.join('');
      assert.ok(!out.includes('Please also consider edge cases.'));
      const t = parseTicketOutput();
      assert.strictEqual(t.server, 'http://localhost:9999');
      assert.strictEqual(t.sessionId, 's42');
      assert.ok(t.elapsed >= 0);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(tmp + '.followups', 'utf8')), ['Please also consider edge cases.']);
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '.followups'); } catch {}
    });

    it('does not queue follow-up text when the ticket answer is ready and preserves it after the answer', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_ready_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, 'done');
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}\nToo late.\n`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.strictEqual(mockCfg._sendToSessionAsyncCalled, undefined);
      assert.strictEqual(stdout.join(''), 'done\nToo late.');
      assert.ok(!fs.existsSync(tmp));
    });

    it('preserves ready-ticket follow-up text after QA output final ruler', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_ready_qa_${Date.now()}.tmp`);
      const qaOutput = '👤: —————————————————\nQuestion\n🤖: —————————————————\nAnswer\n    —————————————————\n';
      fs.writeFileSync(tmp, qaOutput);
      setArgv(['--defer', '--qa']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}\nNext prompt draft.\n`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.strictEqual(mockCfg._sendToSessionAsyncCalled, undefined);
      assert.strictEqual(stdout.join(''), qaOutput + 'Next prompt draft.');
      assert.ok(!fs.existsSync(tmp));
    });

    it('injects stored follow-up text into final QA output prompt block', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_final_qa_${Date.now()}.tmp`);
      const qaOutput = '👤: —————————————————\nQuestion\n🤖: —————————————————\nAnswer\n    —————————————————\n';
      fs.writeFileSync(tmp, qaOutput);
      fs.writeFileSync(tmp + '.followups', JSON.stringify(['First extra.', 'Second extra.']));
      setArgv(['--defer', '--qa']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.strictEqual(stdout.join(''), '👤: —————————————————\nQuestion\n📝 —————————————————\nFirst extra.\n📝 —————————————————\nSecond extra.\n🤖: —————————————————\nAnswer\n    —————————————————\n');
      assert.ok(!fs.existsSync(tmp));
      assert.ok(!fs.existsSync(tmp + '.followups'));
    });

    it('does not print stored follow-up text in final non-QA output', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_final_plain_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, 'plain answer');
      fs.writeFileSync(tmp + '.followups', JSON.stringify(['Hidden extra.']));
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42"}`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.strictEqual(stdout.join(''), 'plain answer');
      assert.ok(!fs.existsSync(tmp));
      assert.ok(!fs.existsSync(tmp + '.followups'));
    });

    it('queues follow-up text before applying the ticket defer wait', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_followup_wait_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, '');
      mockCfg._sendToSessionAsyncHook = async () => {
        fs.writeFileSync(tmp, 'done after follow-up');
      };
      setArgv(['--defer']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","server":"http://localhost:9999","sessionId":"s42","defer":5}\nHurry up.\n`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      assert.deepStrictEqual(mockCfg._sendToSessionAsyncCalled, {
        server: 'http://localhost:9999',
        sessionId: 's42',
        text: 'Hurry up.',
      });
      assert.strictEqual(stdout.join(''), 'done after follow-up');
      assert.ok(!fs.existsSync(tmp));
      assert.ok(!fs.existsSync(tmp + '.followups'));
    });

    it('ignores the --defer argument for tickets and uses the ticket defer property', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_override_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, '');
      // CLI says --defer 999; the ticket says defer 0 — must not wait or error.
      setArgv(['--defer', '999']);
      provideStdin(`agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"${tmp}","defer":0}`);
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:0/);
      const t = parseTicketOutput();
      assert.ok(t.elapsed >= 0);
      try { fs.unlinkSync(tmp); } catch {}
    });

    it('errors when the deferred file is missing', async () => {
      setArgv(['--defer']);
      provideStdin('agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"/tmp/agentp_nope_123.tmp"}');
      const { main } = require('../bin/agentp');
      await assert.rejects(main(), /EXIT:1/);
      assert.ok(stdout.join('').includes('deferred file not found'));
    });
  });

  describe('deferred ticket helpers', () => {
    it('parses a valid ticket', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      const t = parseDeferredTicket('agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"/tmp/x.tmp","defer":5}');
      assert.deepStrictEqual(t, {
        ctime: '2026-08-03T14:30:00.000Z',
        path: '/tmp/x.tmp',
        defer: 5,
        server: null,
        sessionId: null,
      });
    });

    it('trims surrounding whitespace and newlines', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      const t = parseDeferredTicket('\n  agentp_ticket {"path":"/tmp/x.tmp"}  \n');
      assert.deepStrictEqual(t, { ctime: null, path: '/tmp/x.tmp', defer: 0, server: null, sessionId: null });
    });

    it('defaults defer to 0 when absent', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      const t = parseDeferredTicket('agentp_ticket {"path":"/tmp/x.tmp"}');
      assert.strictEqual(t.defer, 0);
    });

    it('returns null for non-ticket input', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      assert.strictEqual(parseDeferredTicket('hello world'), null);
      assert.strictEqual(parseDeferredTicket('<agentp-deferred>/tmp/x.tmp</agentp-deferred>'), null);
    });

    it('returns null for invalid JSON', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      assert.strictEqual(parseDeferredTicket('agentp_ticket {not json'), null);
    });

    it('formats a first-print ticket as pretty JSON without elapsed', () => {
      const { formatTicket } = require('../bin/agentp');
      const s = formatTicket({ ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', defer: 5 });
      assert.ok(s.includes('\n'), 'expected pretty-printed multi-line JSON');
      const data = JSON.parse(s.slice('agentp_ticket '.length));
      assert.deepStrictEqual(data, { ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', defer: 5 });
    });

    it('includes elapsed on re-print', () => {
      const { formatTicket } = require('../bin/agentp');
      const s = formatTicket({ ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', defer: 0 }, 42);
      const data = JSON.parse(s.slice('agentp_ticket '.length));
      assert.deepStrictEqual(data, { ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', elapsed: 42 });
    });

    it('omits defer when 0', () => {
      const { formatTicket } = require('../bin/agentp');
      const s = formatTicket({ ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', defer: 0 });
      assert.ok(!s.includes('defer'));
    });

    it('prints a compact single-line ticket with compact=true', () => {
      const { formatTicket } = require('../bin/agentp');
      const s = formatTicket({ ctime: '2026-08-03T14:30:00.000Z', path: '/tmp/x.tmp', defer: 5 }, undefined, true);
      assert.strictEqual(s, 'agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"/tmp/x.tmp","defer":5}');
    });

    it('parses a pretty-printed multi-line ticket', () => {
      const { parseDeferredTicket } = require('../bin/agentp');
      const pretty = 'agentp_ticket {\n  "ctime": "2026-08-03T14:30:00.000Z",\n  "path": "/tmp/x.tmp",\n  "defer": 5\n}';
      assert.deepStrictEqual(parseDeferredTicket(pretty), {
        ctime: '2026-08-03T14:30:00.000Z',
        path: '/tmp/x.tmp',
        defer: 5,
        server: null,
        sessionId: null,
      });
    });

    it('parses a ticket with trailing follow-up text', () => {
      const { parseDeferredTicketInput } = require('../bin/agentp');
      const parsed = parseDeferredTicketInput('agentp_ticket {"path":"/tmp/x.tmp","server":"http://localhost:4096","sessionId":"s1"}\nAdd this detail.\n');
      assert.deepStrictEqual(parsed, {
        ctime: null,
        path: '/tmp/x.tmp',
        defer: 0,
        server: 'http://localhost:4096',
        sessionId: 's1',
        followupText: 'Add this detail.',
      });
    });

    it('strips the displayed follow-up separator when parsing ticket input', () => {
      const { parseDeferredTicketInput } = require('../bin/agentp');
      const parsed = parseDeferredTicketInput('agentp_ticket {"path":"/tmp/x.tmp","server":"http://localhost:4096","sessionId":"s1"}\n📝 —————————————————\nAdd this detail.\n');
      assert.strictEqual(parsed.followupText, 'Add this detail.');
    });

    it('waitForDeferredResult returns null after timeout', async () => {
      const { waitForDeferredResult } = require('../bin/agentp');
      const t0 = Date.now();
      const result = await waitForDeferredResult('/nonexistent/agentp/result.tmp', 50);
      assert.strictEqual(result, null);
      assert.ok(Date.now() - t0 >= 40);
    });

    it('waitForDeferredResult returns content once available', async () => {
      const tmp = path.join(os.tmpdir(), `agentp_test_waitready_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, 'done');
      const { waitForDeferredResult } = require('../bin/agentp');
      const result = await waitForDeferredResult(tmp, 50);
      assert.strictEqual(result, 'done');
      try { fs.unlinkSync(tmp); } catch {}
    });
  });
});
