'use strict';

const { describe, it, before, after, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const opencode = require('../lib/opencode');

// ── HTTP mock for simple request/response tests ────────────────────
let mockCfg = null;
let mockCallIdx = 0;

function mockHttp(opts, callback) {
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
    _emit(ev, data) { (this._listeners[ev] || []).forEach(fn => fn(data)); },
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
    setTimeout(ms, fn) { if (mockCfg.timeout) fn(); },
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
        res._emit('data', String(mockCfg.body));
        res._emit('end');
      } else {
        res._emit('end');
      }
    },
  };
  return req;
}

function setupMock(initial) {
  mockCfg = { ...initial };
  mockCallIdx = 0;
  nodeMock.method(http, 'request', mockHttp);
  return {
    lastReq: () => mockCfg && mockCfg._lastReq,
    reset(c) { mockCfg = { ...c }; mockCallIdx = 0; },
    callIdx: () => mockCallIdx,
  };
}

function tearDownMock() {
  nodeMock.restoreAll();
  mockCfg = null;
  mockCallIdx = 0;
}

// ── Real HTTP/SSE server helper ────────────────────────────────────
// Serves /api/event with the given SSE events; other paths return 200.
function startSseServer(events, onRequest) {
  const server = http.createServer((req, res) => {
    if (onRequest) onRequest(req, res);
    if (req.url === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      req.on('close', () => res.end());
    } else {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function serverUrl(server) {
  const a = server.address();
  return `http://127.0.0.1:${a.port}`;
}

function sse(json) {
  return `data: ${JSON.stringify(json)}\n\n`;
}

// ───────────────────────────────────────────────────────────────────
// Auth / requests / parsing
// ───────────────────────────────────────────────────────────────────
describe('getAuthHeaders', () => {
  const savedPw = process.env.OPENCODE_SERVER_PASSWORD;
  const savedUser = process.env.OPENCODE_SERVER_USERNAME;
  after(() => {
    if (savedPw === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = savedPw;
    if (savedUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = savedUser;
  });

  it('returns {} when no password is set', () => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    assert.deepStrictEqual(opencode.getAuthHeaders(), {});
  });

  it('builds Basic auth from OPENCODE_SERVER_PASSWORD/USERNAME', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'sekret';
    process.env.OPENCODE_SERVER_USERNAME = 'admin';
    const h = opencode.getAuthHeaders();
    assert.ok(h.Authorization.startsWith('Basic '));
    assert.strictEqual(Buffer.from(h.Authorization.slice(6), 'base64').toString(), 'admin:sekret');
  });
});

describe('apiBase / parseBody', () => {
  it('appends /api (v2)', async () => {
    assert.strictEqual(await opencode.apiBase('http://localhost:4096'), 'http://localhost:4096/api');
    assert.strictEqual(await opencode.apiBase('http://localhost:4096/'), 'http://localhost:4096/api');
  });

  it('detectV2 is always true', async () => {
    assert.strictEqual(await opencode.detectV2('http://x:1'), true);
  });

  it('parseBody unwraps the data envelope', () => {
    assert.deepStrictEqual(opencode.parseBody('{"data":{"id":"s1"}}'), { id: 's1' });
    assert.deepStrictEqual(opencode.parseBody('{"a":1}'), { a: 1 });
  });
});

describe('makeRequest', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('resolves with status and body', async () => {
    ctrl.reset({ status: 200, body: '{"ok":true}' });
    const r = await opencode.makeRequest(opencode.buildJsonRequest('http://localhost:4096/api/x', 'GET'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '{"ok":true}');
  });

  it('rejects on 401', async () => {
    ctrl.reset({ status: 401, body: '' });
    await assert.rejects(
      () => opencode.makeRequest(opencode.buildJsonRequest('http://localhost:4096/api/x', 'GET')),
      /authentication failed/,
    );
  });

  it('rejects on network error', async () => {
    ctrl.reset({ netError: new Error('ECONNREFUSED') });
    await assert.rejects(
      () => opencode.makeRequest(opencode.buildJsonRequest('http://localhost:4096/api/x', 'GET')),
      /ECONNREFUSED/,
    );
  });

  it('passes data to req.write', async () => {
    ctrl.reset({ status: 200, body: '{}' });
    await opencode.makeRequest(opencode.buildJsonRequest('http://localhost:4096/api/x', 'POST'), '{"a":1}');
    assert.deepStrictEqual(ctrl.lastReq().req._written, ['{"a":1}']);
  });
});

describe('buildJsonRequest', () => {
  it('sets path with search and JSON headers when body present', () => {
    const o = opencode.buildJsonRequest('http://localhost:4096/api/s?directory=%2Fx', 'GET');
    assert.strictEqual(o.path, '/api/s?directory=%2Fx');
    assert.strictEqual(o.method, 'GET');
  });
});

// ───────────────────────────────────────────────────────────────────
// Sessions
// ───────────────────────────────────────────────────────────────────
describe('sendText (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('GETs /api/session/active and POSTs a queued prompt to the running session', async () => {
    ctrl.reset({ body: JSON.stringify({ data: { ses_1: { type: 'running' } } }) });
    await opencode.sendText('http://localhost:4096', 'hi');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/ses_1/prompt');
    assert.strictEqual(ctrl.lastReq().opts.method, 'POST');
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.strictEqual(body.delivery, 'queue');
    assert.strictEqual(body.text, 'hi');
  });

  it('does nothing when no session is active', async () => {
    ctrl.reset({ body: JSON.stringify({ data: {} }) });
    await opencode.sendText('http://localhost:4096', 'hi');
    // only the active listing happened
    assert.strictEqual(ctrl.callIdx(), 1);
  });
});

describe('listSessions', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('returns parsed array on success', async () => {
    ctrl.reset({ body: JSON.stringify({ data: [{ id: 's1' }] }) });
    const r = await opencode.listSessions('http://localhost:4096');
    assert.strictEqual(r[0].id, 's1');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(() => opencode.listSessions('http://localhost:4096'), /Failed to list sessions/);
  });

  it('adds ?directory= when a filter is provided', async () => {
    ctrl.reset({ body: '{"data":[]}' });
    await opencode.listSessions('http://localhost:4096', '/home/proj');
    assert.match(ctrl.lastReq().opts.path, /directory=/);
    assert.match(ctrl.lastReq().opts.path, /%2Fhome%2Fproj/);
  });

  it('follows pagination cursors', async () => {
    const paths = [];
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx, opts) => {
      paths.push(opts.path);
      return idx === 1
        ? { body: JSON.stringify({ data: [{ id: 's2' }], cursor: { next: 'next-page' } }) }
        : { body: JSON.stringify({ data: [{ id: 's1' }], cursor: {} }) };
    };
    const result = await opencode.listSessions('http://localhost:4096', '/home/proj');
    assert.deepStrictEqual(result.map(s => s.id), ['s2', 's1']);
    assert.match(paths[1], /cursor=next-page/);
  });
});

describe('listProjects', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('lists projects known to the OpenCode data store', async () => {
    ctrl.reset({ body: JSON.stringify([{ id: 'p1', canonical: '/home/proj' }]) });
    const result = await opencode.listProjects('http://localhost:4096');
    assert.strictEqual(result[0].canonical, '/home/proj');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/project');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(() => opencode.listProjects('http://localhost:4096'), /Failed to list projects/);
  });
});

describe('createSession (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('POSTs /api/session with title and unwraps', async () => {
    ctrl.reset({ body: JSON.stringify({ data: { id: 's_new', title: 'T' } }) });
    const r = await opencode.createSession('http://localhost:4096', 'T');
    assert.strictEqual(r.id, 's_new');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session');
    assert.strictEqual(ctrl.lastReq().opts.method, 'POST');
  });

  it('includes location as a PublicRef object when provided', async () => {
    ctrl.reset({ body: JSON.stringify({ data: { id: 's_loc' } }) });
    await opencode.createSession('http://localhost:4096', 'T', '/home/proj');
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.deepStrictEqual(body.location, { directory: '/home/proj' });
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 400 });
    await assert.rejects(() => opencode.createSession('http://localhost:4096'), /Failed to create session/);
  });
});

describe('updateSession (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('PATCHes title', async () => {
    ctrl.reset({ body: JSON.stringify({ data: { id: 's1', title: 'Renamed' } }) });
    const r = await opencode.updateSession('http://localhost:4096', 's1', 'Renamed');
    assert.strictEqual(r.title, 'Renamed');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/s1');
    assert.strictEqual(ctrl.lastReq().opts.method, 'PATCH');
  });

  it('sets agent via the dedicated endpoint, then fetches the session', async () => {
    // 1: POST /session/s1/agent → 204; 2: GET /session/s1 → session
    const calls = [];
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx) => {
      calls.push(idx);
      return idx === 1
        ? { status: 204, body: '' }
        : { status: 200, body: JSON.stringify({ data: { id: 's1', agent: 'a1' } }) };
    };
    const r = await opencode.updateSession('http://localhost:4096', 's1', null, 'a1');
    assert.strictEqual(r.agent, 'a1');
    assert.strictEqual(calls.length, 2);
  });

  it('sets model via the dedicated endpoint, then fetches the session', async () => {
    const paths = [];
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx, opts) => {
      paths.push(opts.path);
      return idx === 1
        ? { status: 204, body: '' }
        : { status: 200, body: JSON.stringify({ data: { id: 's1', model: 'm1' } }) };
    };
    const r = await opencode.updateSession('http://localhost:4096', 's1', null, null, { providerID: 'oc', modelID: 'm1' });
    assert.strictEqual(r.model, 'm1');
    assert.strictEqual(paths[0], '/api/session/s1/model');
  });
});

describe('selectSession (v2)', () => {
  it('is a no-op (TUI steering has no v2 HTTP endpoint)', async () => {
    assert.strictEqual(await opencode.selectSession('http://localhost:4096', 's1'), undefined);
  });
});

describe('getSession (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('fetches /api/session/:id and unwraps', async () => {
    ctrl.reset({ body: JSON.stringify({ data: { id: 's1', title: 'T' } }) });
    const r = await opencode.getSession('http://localhost:4096', 's1');
    assert.strictEqual(r.title, 'T');
    assert.strictEqual(ctrl.callIdx(), 1);
  });

  it('falls back to the session list and throws when missing', async () => {
    // 1: GET /api/session/nope → 404; 2: GET /api/session → 200 with other sessions
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx) => (idx === 1
      ? { status: 404, body: '' }
      : { status: 200, body: JSON.stringify({ data: [{ id: 'other' }] }) });
    await assert.rejects(() => opencode.getSession('http://localhost:4096', 'nope'), /Session nope not found/);
  });
});

// ───────────────────────────────────────────────────────────────────
// Agents / providers / models
// ───────────────────────────────────────────────────────────────────
describe('listAgents / listProviders', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('lists agents (data envelope)', async () => {
    ctrl.reset({ body: JSON.stringify({ data: [{ id: 'a1' }] }) });
    const r = await opencode.listAgents('http://localhost:4096');
    assert.strictEqual(r[0].id, 'a1');
  });

  it('lists providers', async () => {
    ctrl.reset({ body: JSON.stringify({ data: [{ id: 'p1' }] }) });
    const r = await opencode.listProviders('http://localhost:4096');
    assert.strictEqual(r[0].id, 'p1');
  });
});

describe('listModels (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('unwraps {data} and builds labels/variants/names', async () => {
    ctrl.reset({
      body: JSON.stringify({
        data: [
          { providerID: 'oc', id: 'm1', name: 'Model One', variants: [{ id: 'fast' }, 'high'] },
          { providerID: 'oc', id: 'm1', name: 'Model One', variants: [] }, // duplicate → skipped
          { providerID: 'oc', id: 'm2' },
        ],
      }),
    });
    const r = await opencode.listModels('http://localhost:4096');
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].label, 'oc/m1');
    assert.strictEqual(r[0].name, 'Model One');
    assert.deepStrictEqual(r[0].variants, ['fast', 'high']);
    assert.strictEqual(r[1].name, null);
  });
});

describe('parseModelRef', () => {
  it('parses full/partial refs and variants', () => {
    assert.deepStrictEqual(opencode.parseModelRef('oc/m1#high'), { providerID: 'oc', id: 'm1', variant: 'high' });
    assert.deepStrictEqual(opencode.parseModelRef('m1'), { providerID: null, id: 'm1', variant: null });
    assert.deepStrictEqual(opencode.parseModelRef(''), null);
  });
});

describe('resolveModelRef', () => {
  const models = [
    { providerID: 'oc', id: 'm1', label: 'oc/m1', name: 'Model One' },
    { providerID: 'oc', id: 'm2', label: 'oc/m2', name: 'Model Two' },
  ];
  it('matches the canonical label', () => {
    const r = opencode.resolveModelRef(models, 'oc/m1');
    assert.strictEqual(r.model.id, 'm1');
  });
  it('matches the friendly name', () => {
    const r = opencode.resolveModelRef(models, 'Model Two');
    assert.strictEqual(r.model.id, 'm2');
  });
  it('flags ambiguity', () => {
    const r = opencode.resolveModelRef([...models, { providerID: 'x', id: 'm1', label: 'x/m1', name: 'X' }], 'm1');
    assert.strictEqual(r.model, null);
    assert.ok(r.matches.length > 1);
  });
  it('reports no matches', () => {
    const r = opencode.resolveModelRef(models, 'nope');
    assert.strictEqual(r.model, null);
    assert.strictEqual(r.matches.length, 0);
  });
});

describe('switchModel (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('POSTs the model to /api/session/:id/model', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.switchModel('http://localhost:4096', 's1', 'oc/m1');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/s1/model');
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.deepStrictEqual(body.model, { providerID: 'oc', id: 'm1' });
  });

  it('includes the variant when provided', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.switchModel('http://localhost:4096', 's1', { providerID: 'oc', id: 'm1', variant: 'high' });
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.strictEqual(body.model.variant, 'high');
  });

  it('rejects references without a provider', async () => {
    await assert.rejects(() => opencode.switchModel('http://localhost:4096', 's1', 'm1'), /Invalid model reference/);
  });
});

// ───────────────────────────────────────────────────────────────────
// SSE listeners (real servers)
// ───────────────────────────────────────────────────────────────────
describe('listenForFinalAnswer (v2)', { concurrency: false }, () => {
  it('collects text and resolves on completion (quiescence)', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.text.delta', data: { delta: 'hello ' } },
      { id: 'b', type: 'session.text.delta', data: { delta: 'world' } },
      { id: 'c', type: 'session.execution.succeeded', data: {} },
    ]);
    const r = await opencode.listenForFinalAnswer(serverUrl(server));
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'hello world');
  });

  it('calls onText for each delta', async () => {
    opencode._setCompletionGraceMs(60);
    const parts = [];
    const server = await startSseServer([
      { id: 'a', type: 'session.text.delta', data: { delta: 'x' } },
      { id: 'b', type: 'session.text.delta', data: { delta: 'y' } },
      { id: 'c', type: 'session.execution.succeeded', data: {} },
    ]);
    await opencode.listenForFinalAnswer(serverUrl(server), (t) => parts.push(t));
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.deepStrictEqual(parts, ['x', 'y']);
  });

  it('separates per-step text segments with a blank line', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.text.started', data: {} },
      { id: 'b', type: 'session.text.delta', data: { delta: 'first' } },
      { id: 'c', type: 'session.text.started', data: {} },
      { id: 'd', type: 'session.text.delta', data: { delta: 'second' } },
      { id: 'e', type: 'session.execution.succeeded', data: {} },
    ]);
    const r = await opencode.listenForFinalAnswer(serverUrl(server));
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'first\n\nsecond');
  });

  it('uses the text payload when only session.text.ended arrives', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.text.ended', data: { text: 'PONG' } },
      { id: 'b', type: 'session.execution.succeeded', data: {} },
    ]);
    const r = await opencode.listenForFinalAnswer(serverUrl(server));
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'PONG');
  });

  it('uses session.text.ended as the authoritative final segment text', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.text.started', data: {} },
      { id: 'b', type: 'session.text.delta', data: { delta: 'incom' } },
      { id: 'c', type: 'session.text.ended', data: { text: 'complete' } },
      { id: 'd', type: 'session.execution.succeeded', data: {} },
    ]);
    const r = await opencode.listenForFinalAnswer(serverUrl(server));
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'complete');
  });

  it('resolves immediately on interruption', async () => {
    const server = await startSseServer([
      { id: 'a', type: 'session.text.delta', data: { delta: 'partial' } },
      { id: 'b', type: 'session.execution.interrupted', data: {} },
    ]);
    const r = await opencode.listenForFinalAnswer(serverUrl(server));
    server.close();
    assert.strictEqual(r, 'partial');
  });
});

describe('sendToSession (v2)', { concurrency: false }, () => {
  async function startDurableServer(messages, requests) {
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/api/session/s1/prompt') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'msg_prompt', time: { created: 1000 } } }));
          return;
        }
        if (req.url === '/api/experimental/session/s1/wait') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url.startsWith('/api/session/s1/message?')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: messages, cursor: {} }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  it('waits for idle and returns the durable projected answer', async () => {
    const requests = [];
    const server = await startDurableServer([
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
      { id: 'msg_answer', type: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      { id: 'msg_prompt', type: 'user', text: 'go' },
    ], requests);
    const r = await opencode.sendToSession(serverUrl(server), 's1', 'go');
    server.close();
    assert.strictEqual(r, 'Done');
    assert.deepStrictEqual(requests.map(x => `${x.method} ${x.url.split('?')[0]}`), [
      'POST /api/session/s1/prompt',
      'POST /api/experimental/session/s1/wait',
      'GET /api/session/s1/message',
    ]);
  });

  it('returns complete persisted partial text when execution fails', async () => {
    const requests = [];
    const server = await startDurableServer([
      { id: 'msg_idle', type: 'idle', outcome: 'failed' },
      { id: 'msg_answer', type: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      { id: 'msg_prompt', type: 'user', text: 'go' },
    ], requests);
    const r = await opencode.sendToSession(serverUrl(server), 's1', 'go');
    server.close();
    assert.strictEqual(r, 'partial');
  });
});

describe('durable turn reconstruction', () => {
  it('collects text segments in order and stops at the first idle marker', () => {
    const result = opencode.answerFromTurn([
      { type: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'tool' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'second' }] },
      { type: 'idle', outcome: 'succeeded' },
      { type: 'assistant', content: [{ type: 'text', text: 'later turn' }] },
    ]);
    assert.strictEqual(result, 'first\n\nsecond');
  });
});

describe('v2 completion quiescence', { concurrency: false }, () => {
  it('ignores child-session activity when listening to one target session', async () => {
    opencode._setCompletionGraceMs(60);
    const server = http.createServer((req, res) => {
      if (req.url === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        const w = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
        w({ id: 'a', type: 'session.text.delta', data: { sessionID: 's1', delta: 'first' } });
        w({ id: 'b', type: 'session.execution.succeeded', data: { sessionID: 's1' } });
        setTimeout(() => {
          w({ id: 'c', type: 'session.text.delta', data: { sessionID: 'child', delta: 'subagent working' } });
        }, 20);
        setTimeout(() => {
          w({ id: 'd', type: 'session.text.delta', data: { sessionID: 'child', delta: 'still unrelated' } });
        }, 120);
        req.on('close', () => {});
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => res.end('{}'));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    const url = `http://127.0.0.1:${a.port}`;

    const result = await opencode.listenForSessionEvents(url, 's1', {});
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(result, 'first');
  });
});

describe('listenForSessionEvents (v2)', { concurrency: false }, () => {
  it('filters other sessions and collects the target session text', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.text.delta', data: { sessionID: 'other', delta: 'wrong' } },
      { id: 'b', type: 'session.text.delta', data: { sessionID: 's1', delta: 'right' } },
      { id: 'c', type: 'session.execution.succeeded', data: { sessionID: 's1' } },
    ]);
    const r = await opencode.listenForSessionEvents(serverUrl(server), 's1', {});
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'right');
  });

  it('does not resolve on another session interruption', async () => {
    opencode._setCompletionGraceMs(60);
    const server = await startSseServer([
      { id: 'a', type: 'session.execution.interrupted', data: { sessionID: 'other' } },
      { id: 'b', type: 'session.text.delta', data: { sessionID: 's1', delta: 'right' } },
      { id: 'c', type: 'session.execution.succeeded', data: { sessionID: 's1' } },
    ]);
    const r = await opencode.listenForSessionEvents(serverUrl(server), 's1', {});
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(r, 'right');
  });

  it('reports permission request via callback', async () => {
    opencode._setCompletionGraceMs(60);
    let got = null;
    const server = await startSseServer([
      { id: 'a', type: 'permission.asked', data: { id: 'p1', action: 'bash' } },
      { id: 'b', type: 'session.execution.succeeded', data: { sessionID: 's1' } },
    ]);
    await opencode.listenForSessionEvents(serverUrl(server), 's1', {
      onPermission: (p) => { got = p; },
    });
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(got && got.action, 'bash');
  });

  it('reports a question via callback', async () => {
    opencode._setCompletionGraceMs(60);
    let q = null;
    const server = await startSseServer([
      { id: 'a', type: 'question.asked', data: { id: 'q1' } },
      { id: 'b', type: 'session.execution.succeeded', data: { sessionID: 's1' } },
    ]);
    await opencode.listenForSessionEvents(serverUrl(server), 's1', {
      onQuestion: (x) => { q = x; },
    });
    server.close();
    opencode._setCompletionGraceMs(5000);
    assert.strictEqual(q && q.id, 'q1');
  });
});

// ───────────────────────────────────────────────────────────────────
// Async send / permission / question (mock-based)
// ───────────────────────────────────────────────────────────────────
describe('sendToSessionAsync (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('enqueues via prompt with queue delivery', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.sendToSessionAsync('http://localhost:4096', 's1', 'note');
    assert.strictEqual(ctrl.callIdx(), 1);
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/s1/prompt');
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.strictEqual(body.delivery, 'queue');
    assert.strictEqual(body.text, 'note');
  });

  it('sets agent and model first', async () => {
    ctrl.reset({ status: 204, body: '' });
    mockCfg.factory = () => ({ status: 204, body: '' });
    await opencode.sendToSessionAsync('http://localhost:4096', 's1', 'note', 'a1', { providerID: 'oc', modelID: 'm1' });
    // 3 requests: agent, model, prompt
    assert.strictEqual(ctrl.callIdx(), 3);
  });
});

describe('respondToPermission (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('maps allow → once and posts to the reply endpoint', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.respondToPermission('http://localhost:4096', 's1', 'p1', 'allow', false);
    assert.match(ctrl.lastReq().opts.path, /\/api\/session\/s1\/permission\/p1\/reply/);
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.deepStrictEqual(body, { decision: 'once' });
  });

  it('maps allow+remember to always', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.respondToPermission('http://localhost:4096', 's1', 'p1', 'allow', true);
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.deepStrictEqual(body, { decision: 'always' });
  });
});

describe('respondToQuestion (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('posts the answer to the form reply endpoint', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.respondToQuestion('http://localhost:4096', 's1', 'q1', 'A');
    assert.match(ctrl.lastReq().opts.path, /\/api\/session\/s1\/form\/q1\/reply/);
    const body = JSON.parse(ctrl.lastReq().req._written.join(''));
    assert.deepStrictEqual(body, { answer: 'A' });
  });
});

// ───────────────────────────────────────────────────────────────────
// Pending forms / permissions + form replies (answer mode support)
// ───────────────────────────────────────────────────────────────────
describe('listPendingForms (v2 location filter)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('GET /api/form?location[directory]=… returns a location form array', async () => {
    ctrl.reset({
      status: 200,
      body: JSON.stringify({ location: { directory: '/proj' }, data: [{ id: 'f1', sessionID: 's1' }] }),
    });
    const forms = await opencode.listPendingForms('http://localhost:4096', '/proj');
    assert.deepStrictEqual(forms, [{ id: 'f1', sessionID: 's1' }]);
    const req = ctrl.lastReq();
    assert.strictEqual(req.opts.method, 'GET');
    assert.ok(req.opts.path.includes('/api/form?'), 'expected the /api/form route');
    assert.ok(req.opts.path.includes('location%5Bdirectory%5D=%2Fproj'),
      'expected the deepObject location[directory] filter');
  });

  it('returns [] for an empty data array', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ data: [] }) });
    assert.deepStrictEqual(await opencode.listPendingForms('http://localhost:4096'), []);
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500, body: '' });
    await assert.rejects(() => opencode.listPendingForms('http://localhost:4096', '/proj'), /Failed to list pending forms/);
  });
});

describe('listSessionForms (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('GET /api/session/:id/form returns the session’s pending forms with fields', async () => {
    ctrl.reset({
      status: 200,
      body: JSON.stringify({
        data: [{
          id: 'f1', sessionID: 's1', title: 'Pick a model',
          fields: [{ key: 'model', type: 'string', options: [{ label: 'A', value: 'a' }] }],
        }],
      }),
    });
    const forms = await opencode.listSessionForms('http://localhost:4096', 's1');
    assert.strictEqual(forms.length, 1);
    assert.strictEqual(forms[0].id, 'f1');
    assert.ok(Array.isArray(forms[0].fields), 'expected the fields payload for the answer UI');
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/s1/form');
  });
});

describe('replyToForm (v2 keyed answer)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('POSTs the keyed answer map to the form reply endpoint', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.replyToForm('http://localhost:4096', 's1', 'f1', { model: 'a', tags: ['x', 'y'] });
    const req = ctrl.lastReq();
    assert.strictEqual(req.opts.method, 'POST');
    assert.match(req.opts.path, /\/api\/session\/s1\/form\/f1\/reply/);
    assert.deepStrictEqual(JSON.parse(req.req._written.join('')), { answer: { model: 'a', tags: ['x', 'y'] } });
  });

  it('rejects with err.status 400 and the server message on an invalid answer', async () => {
    ctrl.reset({
      status: 400,
      body: JSON.stringify({ message: 'Invalid answer for field "model".' }),
    });
    await assert.rejects(
      () => opencode.replyToForm('http://localhost:4096', 's1', 'f1', { model: 42 }),
      (err) => {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.message, 'Invalid answer for field "model".');
        return true;
      },
    );
  });

  it('rejects with err.status 409 when the form was already settled', async () => {
    ctrl.reset({ status: 409, body: JSON.stringify({ message: 'Already settled' }) });
    await assert.rejects(
      () => opencode.replyToForm('http://localhost:4096', 's1', 'f1', {}),
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.message, 'Already settled');
        return true;
      },
    );
  });

  it('falls back to a generic message when the body carries no message', async () => {
    ctrl.reset({ status: 400, body: 'not json' });
    await assert.rejects(
      () => opencode.replyToForm('http://localhost:4096', 's1', 'f1', {}),
      (err) => err.status === 400 && /Failed to answer form: 400/.test(err.message),
    );
  });
});

describe('listPendingPermissions (v2 location filter)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('GET /api/permission/request?location[directory]=… returns the request array', async () => {
    ctrl.reset({
      status: 200,
      body: JSON.stringify({
        location: { directory: '/proj' },
        data: [{ id: 'per_a', sessionID: 's1', action: 'run', resources: ['.'] }],
      }),
    });
    const perms = await opencode.listPendingPermissions('http://localhost:4096', '/proj');
    assert.deepStrictEqual(perms, [{ id: 'per_a', sessionID: 's1', action: 'run', resources: ['.'] }]);
    const req = ctrl.lastReq();
    assert.strictEqual(req.opts.method, 'GET');
    assert.ok(req.opts.path.includes('/api/permission/request?'), 'expected the permission route');
    assert.ok(req.opts.path.includes('location%5Bdirectory%5D=%2Fproj'), 'expected the location filter');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500, body: '' });
    await assert.rejects(
      () => opencode.listPendingPermissions('http://localhost:4096', '/proj'),
      /Failed to list pending permissions/,
    );
  });
});

describe('replyToPermission (v2 decision)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('POSTs the decision to the session permission reply endpoint', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.replyToPermission('http://localhost:4096', 's1', 'per_a', 'always');
    const req = ctrl.lastReq();
    assert.strictEqual(req.opts.method, 'POST');
    assert.match(req.opts.path, /\/api\/session\/s1\/permission\/per_a\/reply/);
    assert.deepStrictEqual(JSON.parse(req.req._written.join('')), { decision: 'always' });
  });

  it('rejects with err.status and the server message on failure', async () => {
    ctrl.reset({ status: 400, body: JSON.stringify({ message: 'Permission already resolved.' }) });
    await assert.rejects(
      () => opencode.replyToPermission('http://localhost:4096', 's1', 'per_a', 'once'),
      (err) => {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.message, 'Permission already resolved.');
        return true;
      },
    );
  });

  it('falls back to a generic message when the body carries no message', async () => {
    ctrl.reset({ status: 404, body: 'not json' });
    await assert.rejects(
      () => opencode.replyToPermission('http://localhost:4096', 's1', 'per_a', 'reject'),
      (err) => err.status === 404 && /Failed to reply to permission: 404/.test(err.message),
    );
  });
});

describe('serverMessage', () => {
  it('extracts message from a tagged v2 error body', () => {
    assert.strictEqual(opencode.serverMessage(JSON.stringify({ message: 'nope' })), 'nope');
  });

  it('falls back to error.message', () => {
    assert.strictEqual(opencode.serverMessage(JSON.stringify({ error: { message: 'inner' } })), 'inner');
  });

  it('returns null for non-JSON bodies', () => {
    assert.strictEqual(opencode.serverMessage(''), null);
    assert.strictEqual(opencode.serverMessage('not json'), null);
    assert.strictEqual(opencode.serverMessage(null), null);
  });
});

// ───────────────────────────────────────────────────────────────────
// Misc
// ───────────────────────────────────────────────────────────────────
describe('sortSessionsByRecency', () => {
  it('sorts by time.viewed first, then updated, then created', () => {
    const rows = [
      { id: 'a', time: { updated: 10, created: 1 } },
      { id: 'b', time: { viewed: 30, updated: 5, created: 1 } },
      { id: 'c', time: { viewed: 20, updated: 99, created: 1 } },
      { id: 'd' },
    ];
    assert.deepStrictEqual(opencode.sortSessionsByRecency(rows).map(s => s.id), ['b', 'c', 'a', 'd']);
  });

  it('tolerates null/empty and returns a new array', () => {
    assert.deepStrictEqual(opencode.sortSessionsByRecency(null), []);
    assert.deepStrictEqual(opencode.sortSessionsByRecency([]), []);
  });
});

describe('deleteSession (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('DELETE /api/session/:id', async () => {
    ctrl.reset({ status: 204, body: '' });
    await opencode.deleteSession('http://localhost:4096', 'ses_1');
    const req = ctrl.lastReq();
    assert.strictEqual(req.opts.path, '/api/session/ses_1');
    assert.strictEqual(req.opts.method, 'DELETE');
  });

  it('throws on non-success status', async () => {
    ctrl.reset({ status: 500, body: '' });
    await assert.rejects(() => opencode.deleteSession('http://localhost:4096', 'ses_1'), /Failed to delete session/);
  });
});

describe('interruptSession (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('POSTs /api/session/:id/interrupt and returns the interrupted flag', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ data: { interrupted: true } }) });
    const r = await opencode.interruptSession('http://localhost:4096', 's1');
    assert.strictEqual(r, true);
    assert.strictEqual(ctrl.lastReq().opts.path, '/api/session/s1/interrupt');
    assert.strictEqual(ctrl.lastReq().opts.method, 'POST');
  });

  it('returns false when the session is already idle', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ data: { interrupted: false } }) });
    assert.strictEqual(await opencode.interruptSession('http://localhost:4096', 's1'), false);
  });

  it('returns false on network error (best-effort)', async () => {
    ctrl.reset({ netError: new Error('ECONNREFUSED') });
    assert.strictEqual(await opencode.interruptSession('http://localhost:4096', 's1'), false);
  });
});

describe('createSessionWithModel (v2)', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('inherits the model of a reference session', async () => {
    const paths = [];
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx, opts) => {
      paths.push(opts.path);
      if (opts.path === '/api/session' && opts.method === 'POST') {
        return { status: 200, body: JSON.stringify({ data: { id: 's_new' } }) };
      }
      return { status: 204, body: '' };
    };
    const created = await opencode.createSessionWithModel('http://localhost:4096', 'T', '/dir', [
      { model: { providerID: 'p', id: 'm' } },
    ]);
    assert.strictEqual(created.id, 's_new');
    assert.ok(paths.includes('/api/session/s_new/model'));
  });

  it('falls back to the server default model', async () => {
    const paths = [];
    ctrl.reset({ status: 200, body: '' });
    mockCfg.factory = (idx, opts) => {
      paths.push(opts.path);
      if (opts.path === '/api/model/default') {
        return { status: 200, body: JSON.stringify({ location: {}, data: { providerID: 'dp', id: 'dm' } }) };
      }
      if (opts.path === '/api/session' && opts.method === 'POST') {
        return { status: 200, body: JSON.stringify({ data: { id: 's2' } }) };
      }
      return { status: 204, body: '' };
    };
    await opencode.createSessionWithModel('http://localhost:4096', 'T', '/dir', []);
    assert.ok(paths.includes('/api/session/s2/model'));
  });
});

describe('isServerAlive', { concurrency: false }, () => {
  let ctrl;
  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('resolves true when the server responds', async () => {
    ctrl.reset({ status: 200, body: '' });
    assert.strictEqual(await opencode.isServerAlive('http://localhost:4096'), true);
  });

  it('resolves false on network error', async () => {
    ctrl.reset({ netError: new Error('ECONNREFUSED') });
    assert.strictEqual(await opencode.isServerAlive('http://localhost:4096'), false);
  });
});
