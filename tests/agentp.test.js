'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { Readable } = require('stream');

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
let originalStdoutWrite;
let originalStderrWrite;
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
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  originalLog = console.log;
  originalError = console.error;
  originalReadFileSync = fs.readFileSync;

  process.exit = (code) => {
    throw new Error(`EXIT:${code}`);
  };
  process.stdout.write = (chunk) => { stdout.push(chunk); return true; };
  process.stderr.write = (chunk) => { stderr.push(chunk); return true; };
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
  process.stdin = originalStdin;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
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
      assert.ok(logs[0].includes('0.11.7'));
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
});
