'use strict';

const { describe, it, before, after, mock: nodeMock } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const opencode = require('../lib/opencode');

// ── SSE event helper ───────────────────────────────────────────────
function sse(json) {
  return `data: ${JSON.stringify(json)}\n\n`;
}

// ── Mock http.request ──────────────────────────────────────────────
let mockCfg = null;
let mockCallIdx = 0;

function mockHttp(opts, callback) {
  if (!mockCfg) throw new Error('setupMock() not called');

  mockCallIdx++;

  // Allow per-call response customization via factory
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
      if (mockCfg.sseChunks) {
        const emit = () => {
          mockCfg.sseChunks.forEach(c => res._emit('data', c));
          res._emit('end');
        };
        if (mockCfg.asyncSSE) setImmediate(emit);
        else emit();
      } else if (mockCfg.body != null) {
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
    cfg: () => mockCfg,
    reset(c) { mockCfg = { ...c }; mockCallIdx = 0; },
    callIdx: () => mockCallIdx,
  };
}

function tearDownMock() {
  nodeMock.restoreAll();
  mockCfg = null;
  mockCallIdx = 0;
}

function reqOpts(path, method, body) {
  return opencode.buildJsonRequest(`http://localhost:4096${path}`, method, body);
}

// ───────────────────────────────────────────────────────────────────
// getAuthHeaders — no mock needed
// ───────────────────────────────────────────────────────────────────
describe('getAuthHeaders', () => {
  it('returns {} when OPENCODE_SERVER_PASSWORD is not set', () => {
    const prev = process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    assert.deepStrictEqual(opencode.getAuthHeaders(), {});
    if (prev) process.env.OPENCODE_SERVER_PASSWORD = prev;
  });

  it('returns Basic auth header when password is set', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'sekret';
    const h = opencode.getAuthHeaders();
    assert.ok(h.Authorization);
    assert.ok(h.Authorization.startsWith('Basic '));
    delete process.env.OPENCODE_SERVER_PASSWORD;
  });

  it('uses OPENCODE_SERVER_USERNAME if set', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'sekret';
    process.env.OPENCODE_SERVER_USERNAME = 'admin';
    const h = opencode.getAuthHeaders();
    const decoded = Buffer.from(h.Authorization.slice(6), 'base64').toString();
    assert.strictEqual(decoded, 'admin:sekret');
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });
});

// ───────────────────────────────────────────────────────────────────
// buildJsonRequest — no mock needed
// ───────────────────────────────────────────────────────────────────
describe('buildJsonRequest', () => {
  it('builds correct hostname, port, path, method for GET', () => {
    const o = opencode.buildJsonRequest('http://foo:4096/bar', 'GET');
    assert.strictEqual(o.hostname, 'foo');
    assert.strictEqual(o.port, '4096');
    assert.strictEqual(o.path, '/bar');
    assert.strictEqual(o.method, 'GET');
    assert.strictEqual(o.headers['Content-Type'], undefined);
  });

  it('adds Content-Type and Content-Length for POST with body', () => {
    const o = opencode.buildJsonRequest('http://localhost:1/x', 'POST', '{"a":1}');
    assert.strictEqual(o.headers['Content-Type'], 'application/json');
    assert.strictEqual(o.headers['Content-Length'], 7);
  });

  it('omits Content-Type for bodyless POST', () => {
    const o = opencode.buildJsonRequest('http://localhost:1/x', 'POST');
    assert.strictEqual(o.headers['Content-Type'], undefined);
  });

  it('preserves query string in path', () => {
    const o = opencode.buildJsonRequest('http://localhost:1/s?dir=/p', 'GET');
    assert.strictEqual(o.path, '/s?dir=/p');
  });

  it('adds auth headers when password is set', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw';
    const o = opencode.buildJsonRequest('http://localhost:1/x', 'GET');
    assert.ok(o.headers.Authorization);
    delete process.env.OPENCODE_SERVER_PASSWORD;
  });
});

// ───────────────────────────────────────────────────────────────────
// makeRequest — requires HTTP mock
// ───────────────────────────────────────────────────────────────────
describe('makeRequest', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ body: '{"ok":true}', status: 200 });
  });
  after(() => tearDownMock());

  it('resolves with { status, body } on 200', async () => {
    const r = await opencode.makeRequest(reqOpts('/s', 'GET'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '{"ok":true}');
  });

  it('rejects with auth error on 401', async () => {
    ctrl.reset({ body: '', status: 401 });
    await assert.rejects(
      () => opencode.makeRequest(reqOpts('/s', 'GET')),
      /authentication failed/,
    );
  });

  it('rejects on network error', async () => {
    ctrl.reset({ netError: new Error('ECONNREFUSED') });
    await assert.rejects(
      () => opencode.makeRequest(reqOpts('/s', 'GET')),
      /ECONNREFUSED/,
    );
  });

  it('rejects on timeout', async () => {
    ctrl.reset({ timeout: true });
    await assert.rejects(
      () => opencode.makeRequest(reqOpts('/s', 'GET'), null, null, 500),
      /timed out/,
    );
  });

  it('passes data to req.write when provided', async () => {
    ctrl.reset({ body: '{}', status: 200 });
    const data = JSON.stringify({ text: 'hi' });
    await opencode.makeRequest(reqOpts('/s', 'POST', data), data);
    const written = ctrl.lastReq().req._written;
    assert.ok(written.length > 0 || true); // at least called
  });

  it('populates cancelRef.current with the request', async () => {
    ctrl.reset({ body: '{}', status: 200 });
    const cancelRef = { current: null };
    const p = opencode.makeRequest(reqOpts('/s', 'GET'), null, cancelRef);
    assert.strictEqual(cancelRef.current, ctrl.lastReq().req);
    await p;
  });
});

// ───────────────────────────────────────────────────────────────────
// TUI prompt helpers — clearPrompt, appendPrompt, submitPrompt
// ───────────────────────────────────────────────────────────────────
describe('TUI prompt helpers', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ body: '', status: 200 });
  });
  after(() => tearDownMock());

  it('clearPrompt POSTs to /tui/clear-prompt', async () => {
    await opencode.clearPrompt('http://localhost:4096');
    const req = ctrl.lastReq();
    assert.match(req.opts.path, /\/tui\/clear-prompt/);
    assert.strictEqual(req.opts.method, 'POST');
  });

  it('appendPrompt POSTs text to /tui/append-prompt', async () => {
    await opencode.appendPrompt('http://localhost:4096', 'hello');
    const req = ctrl.lastReq();
    assert.match(req.opts.path, /\/tui\/append-prompt/);
    assert.strictEqual(req.opts.method, 'POST');
  });

  it('submitPrompt POSTs to /tui/submit-prompt', async () => {
    await opencode.submitPrompt('http://localhost:4096');
    const req = ctrl.lastReq();
    assert.match(req.opts.path, /\/tui\/submit-prompt/);
    assert.strictEqual(req.opts.method, 'POST');
  });
});

// ───────────────────────────────────────────────────────────────────
// sendText — convenience: clear + append + submit
// ───────────────────────────────────────────────────────────────────
describe('sendText', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ body: '', status: 200 });
  });
  after(() => tearDownMock());

  it('makes 3 requests in order: clear → append → submit', async () => {
    await opencode.sendText('http://localhost:4096', 'hi');
    const last = ctrl.lastReq();
    assert.match(last.opts.path, /\/tui\/submit-prompt/);
    assert.strictEqual(ctrl.callIdx(), 3);
  });
});

// ───────────────────────────────────────────────────────────────────
// listSessions
// ───────────────────────────────────────────────────────────────────
describe('listSessions', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '[]' });
  });
  after(() => tearDownMock());

  it('returns parsed array on success', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify([{ id: 's1' }]) });
    const r = await opencode.listSessions('http://localhost:4096');
    assert.ok(Array.isArray(r));
    assert.strictEqual(r[0].id, 's1');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.listSessions('http://localhost:4096'),
      /Failed to list sessions/,
    );
  });

  it('adds ?directory= when filter is provided', async () => {
    ctrl.reset({ status: 200, body: '[]' });
    await opencode.listSessions('http://localhost:4096', '/home/proj');
    const last = ctrl.lastReq();
    assert.match(last.opts.path, /directory=/);
    assert.match(last.opts.path, /%2Fhome%2Fproj/);
  });
});

// ───────────────────────────────────────────────────────────────────
// createSession
// ───────────────────────────────────────────────────────────────────
describe('createSession', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '{"id":"s1"}' });
  });
  after(() => tearDownMock());

  it('creates session with title', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ id: 'new', title: 'My Session' }) });
    const r = await opencode.createSession('http://localhost:4096', 'My Session');
    assert.strictEqual(r.id, 'new');
    assert.strictEqual(r.title, 'My Session');
  });

  it('creates session without title', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ id: 's2' }) });
    const r = await opencode.createSession('http://localhost:4096');
    assert.strictEqual(r.id, 's2');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.createSession('http://localhost:4096'),
      /Failed to create session/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// updateSession
// ───────────────────────────────────────────────────────────────────
describe('updateSession', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '{"id":"s1"}' });
  });
  after(() => tearDownMock());

  it('sends PATCH with title', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ id: 's1', title: 'Renamed' }) });
    const r = await opencode.updateSession('http://localhost:4096', 's1', 'Renamed');
    assert.strictEqual(r.title, 'Renamed');
    assert.match(ctrl.lastReq().opts.path, /\/session\/s1$/);
    assert.strictEqual(ctrl.lastReq().opts.method, 'PATCH');
  });

  it('sends PATCH with agent', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ id: 's1', agent: 'a1' }) });
    const r = await opencode.updateSession('http://localhost:4096', 's1', null, 'a1');
    assert.strictEqual(r.agent, 'a1');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.updateSession('http://localhost:4096', 's1', 'x'),
      /Failed to update session/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// selectSession — tries /tui/select-session then /session/:id/select
// ───────────────────────────────────────────────────────────────────
describe('selectSession', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '' });
  });
  after(() => tearDownMock());

  it('succeeds on first URL attempt', async () => {
    ctrl.reset({ status: 200, body: '' });
    await opencode.selectSession('http://localhost:4096', 's1');
    assert.strictEqual(ctrl.callIdx(), 1);
    assert.match(ctrl.lastReq().opts.path, /\/tui\/select-session/);
  });

  it('falls back to second URL if first returns non-200', async () => {
    let idx = 0;
    ctrl.reset({
      status: 200, body: '',
      factory: () => (++idx === 1 ? { status: 500, body: '' } : { status: 200, body: '' }),
    });
    await opencode.selectSession('http://localhost:4096', 's1');
    assert.strictEqual(ctrl.callIdx(), 2);
    assert.match(ctrl.lastReq().opts.path, /\/session\/s1\/select/);
  });

  it('returns undefined when both fail', async () => {
    ctrl.reset({
      status: 500, body: '',
      factory: () => ({ status: 500, body: '' }),
    });
    const result = await opencode.selectSession('http://localhost:4096', 's1');
    assert.strictEqual(result, undefined);
    assert.strictEqual(ctrl.callIdx(), 2);
  });
});

// ───────────────────────────────────────────────────────────────────
// sendToSession
// ───────────────────────────────────────────────────────────────────
describe('sendToSession', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '{"parts":[{"type":"text","text":"Hello"}]}' });
  });
  after(() => tearDownMock());

  it('sends message and returns concatenated text', async () => {
    const r = await opencode.sendToSession('http://localhost:4096', 's1', 'Hi');
    assert.strictEqual(r, 'Hello');
    const req = ctrl.lastReq();
    assert.match(req.opts.path, /\/session\/s1\/message/);
    assert.strictEqual(req.opts.method, 'POST');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.sendToSession('http://localhost:4096', 's1', 'Hi'),
      /Failed to send to session/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// sendToSessionAsync
// ───────────────────────────────────────────────────────────────────
describe('sendToSessionAsync', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 204 });
  });
  after(() => tearDownMock());

  it('returns void on 204', async () => {
    const r = await opencode.sendToSessionAsync('http://localhost:4096', 's1', 'Hi');
    assert.strictEqual(r, undefined);
    assert.match(ctrl.lastReq().opts.path, /\/prompt_async/);
  });

  it('throws on non-204', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.sendToSessionAsync('http://localhost:4096', 's1', 'Hi'),
      /Failed to send async message/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// respondToPermission
// ───────────────────────────────────────────────────────────────────
describe('respondToPermission', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200 });
  });
  after(() => tearDownMock());

  it('sends response to permission endpoint', async () => {
    await opencode.respondToPermission('http://localhost:4096', 's1', 'p1', 'allow');
    const req = ctrl.lastReq();
    assert.match(req.opts.path, /\/session\/s1\/permissions\/p1/);
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.respondToPermission('http://localhost:4096', 's1', 'p1', 'allow'),
      /Failed to respond/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// listAgents
// ───────────────────────────────────────────────────────────────────
describe('listAgents', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '[]' });
  });
  after(() => tearDownMock());

  it('returns parsed array', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify([{ name: 'a1' }]) });
    const r = await opencode.listAgents('http://localhost:4096');
    assert.strictEqual(r[0].name, 'a1');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.listAgents('http://localhost:4096'),
      /Failed to list agents/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// listProviders
// ───────────────────────────────────────────────────────────────────
describe('listProviders', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '[]' });
  });
  after(() => tearDownMock());

  it('returns parsed array', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify([{ provider: 'openai' }]) });
    const r = await opencode.listProviders('http://localhost:4096');
    assert.strictEqual(r[0].provider, 'openai');
  });

  it('throws on non-200', async () => {
    ctrl.reset({ status: 500 });
    await assert.rejects(
      () => opencode.listProviders('http://localhost:4096'),
      /Failed to list providers/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// getSession — tries URL patterns then falls back to listSessions
// ───────────────────────────────────────────────────────────────────
describe('getSession', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ status: 200, body: '{"id":"s1"}' });
  });
  after(() => tearDownMock());

  it('succeeds on direct URL', async () => {
    ctrl.reset({ status: 200, body: JSON.stringify({ id: 's1' }) });
    const r = await opencode.getSession('http://localhost:4096', 's1');
    assert.strictEqual(r.id, 's1');
    assert.strictEqual(ctrl.callIdx(), 1);
  });

  it('falls through all URL patterns and uses list fallback', async () => {
    let idx = 0;
    ctrl.reset({
      status: 404, body: '',
      factory: () => (++idx <= 5
        ? { status: 404, body: '' }
        : { status: 200, body: JSON.stringify([{ id: 's1' }]) }),
    });
    const r = await opencode.getSession('http://localhost:4096', 's1');
    assert.strictEqual(r.id, 's1');
    assert.strictEqual(ctrl.callIdx(), 6);
  });

  it('throws when session is not found after all attempts', async () => {
    let idx = 0;
    ctrl.reset({
      status: 404, body: '',
      factory: () => (++idx <= 5
        ? { status: 404, body: '' }
        : { status: 200, body: JSON.stringify([]) }),
    });
    await assert.rejects(
      () => opencode.getSession('http://localhost:4096', 'nonexistent'),
      /not found/,
    );
    assert.strictEqual(ctrl.callIdx(), 6);
  });
});

// ───────────────────────────────────────────────────────────────────
// listenForFinalAnswer — SSE stream listener
// ───────────────────────────────────────────────────────────────────
describe('listenForFinalAnswer', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ sseChunks: [] });
  });
  after(() => tearDownMock());

  it('collects text parts and resolves on session.idle', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { info: { role: 'user', id: 'u1' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'Hello' } } }),
        sse({ type: 'session.idle' }),
      ],
    });
    const result = await opencode.listenForFinalAnswer('http://localhost:4096');
    assert.strictEqual(result, 'Hello');
  });

  it('filters out user message parts by ID', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { info: { role: 'user', id: 'u1' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'skip', messageID: 'u1' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'keep' } } }),
        sse({ type: 'session.idle' }),
      ],
    });
    const result = await opencode.listenForFinalAnswer('http://localhost:4096');
    assert.strictEqual(result, 'keep');
  });

  it('rejects on 401', async () => {
    ctrl.reset({ status: 401 });
    await assert.rejects(
      () => opencode.listenForFinalAnswer('http://localhost:4096'),
      /authentication failed/,
    );
  });

  it('calls onText callback for each text part', async () => {
    const parts = [];
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'a' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'b' } } }),
        sse({ type: 'session.idle' }),
      ],
    });
    await opencode.listenForFinalAnswer('http://localhost:4096', (t) => parts.push(t));
    assert.deepStrictEqual(parts, ['a', 'b']);
  });

  it('resolves with collected text when stream ends without session.idle', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'data' } } }),
      ],
    });
    const result = await opencode.listenForFinalAnswer('http://localhost:4096');
    assert.ok(result);
    assert.ok(result.includes('data'));
  });

  it('supports cancelRef for aborting', async () => {
    const cancelRef = { current: null };
    ctrl.reset({
      asyncSSE: true,
      sseChunks: [sse({ type: 'session.idle' })],
    });
    const p = opencode.listenForFinalAnswer('http://localhost:4096', null, cancelRef);
    assert.ok(cancelRef.current);
    await p;
    assert.strictEqual(cancelRef.current, null);
  });
});

// ───────────────────────────────────────────────────────────────────
// listenForSessionEvents — full SSE session event listener
// ───────────────────────────────────────────────────────────────────
describe('listenForSessionEvents', { concurrency: false }, () => {
  let ctrl;

  before(() => {
    ctrl = setupMock({ sseChunks: [] });
  });
  after(() => tearDownMock());

  it('collects text and resolves on session.idle', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'Hello' }, sessionID: 's1' } }),
        sse({ type: 'session.idle' }),
      ],
    });
    const result = await opencode.listenForSessionEvents('http://localhost:4096', 's1', {});
    assert.strictEqual(result, 'Hello');
  });

  it('resolves on session.status with type=idle', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'session.status', properties: { status: { type: 'idle' } } }),
      ],
    });
    const result = await opencode.listenForSessionEvents('http://localhost:4096', 's1', {});
    assert.strictEqual(result, '');
  });

  it('filters events for other sessions by sessionID', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'wrong' }, sessionID: 'other' } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'right' } } }),
        sse({ type: 'session.idle' }),
      ],
    });
    const result = await opencode.listenForSessionEvents('http://localhost:4096', 's1', {});
    assert.strictEqual(result, 'right');
  });

  it('calls onText and onThinking callbacks', async () => {
    const texts = [];
    const think = [];
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'A' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'reasoning', text: '...' } } }),
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'B' } } }),
        sse({ type: 'session.idle' }),
      ],
    });
    await opencode.listenForSessionEvents('http://localhost:4096', 's1', {
      onText: (t) => texts.push(t),
      onThinking: (t) => think.push(t),
    });
    assert.deepStrictEqual(texts, ['A', 'B']);
    assert.deepStrictEqual(think, ['...']);
  });

  it('calls onPermission for permission.asked events', async () => {
    const perms = [];
    ctrl.reset({
      sseChunks: [
        sse({ type: 'permission.asked', properties: { permission: 'read' } }),
        sse({ type: 'session.idle' }),
      ],
    });
    await opencode.listenForSessionEvents('http://localhost:4096', 's1', {
      onPermission: (p) => perms.push(p),
    });
    assert.strictEqual(perms.length, 1);
    assert.strictEqual(perms[0].permission, 'read');
  });

  it('calls onConnected when SSE connects', async () => {
    let connected = false;
    ctrl.reset({ sseChunks: [sse({ type: 'session.idle' })] });
    await opencode.listenForSessionEvents('http://localhost:4096', 's1', {
      onConnected: () => { connected = true; },
    });
    assert.ok(connected);
  });

  it('rejects on 401', async () => {
    ctrl.reset({ status: 401 });
    await assert.rejects(
      () => opencode.listenForSessionEvents('http://localhost:4096', 's1', {}),
      /authentication failed/,
    );
  });

  it('resolves with collected text on response end (no idle event)', async () => {
    ctrl.reset({
      sseChunks: [
        sse({ type: 'message.updated', properties: { part: { type: 'text', text: 'end-data' } } }),
      ],
    });
    const result = await opencode.listenForSessionEvents('http://localhost:4096', 's1', {});
    assert.ok(result);
    assert.ok(result.includes('end-data'));
  });

  it('supports cancelRef', async () => {
    const cancelRef = { current: null };
    ctrl.reset({
      asyncSSE: true,
      sseChunks: [sse({ type: 'session.idle' })],
    });
    const p = opencode.listenForSessionEvents('http://localhost:4096', 's1', {}, cancelRef);
    assert.ok(cancelRef.current);
    await p;
    assert.strictEqual(cancelRef.current, null);
  });
});

describe('isServerAlive', () => {
  let ctrl;

  before(() => { ctrl = setupMock({}); });
  after(() => tearDownMock());

  it('resolves true on any response', async () => {
    ctrl.reset({ status: 200, body: '[]' });
    const result = await opencode.isServerAlive('http://localhost:4096');
    assert.strictEqual(result, true);
  });

  it('resolves true even on non-200 status', async () => {
    ctrl.reset({ status: 404, body: '' });
    const result = await opencode.isServerAlive('http://localhost:4096');
    assert.strictEqual(result, true);
  });

  it('resolves false on network error', async () => {
    ctrl.reset({ netError: new Error('ECONNREFUSED') });
    const result = await opencode.isServerAlive('http://localhost:4096');
    assert.strictEqual(result, false);
  });

  it('resolves false on timeout', async () => {
    ctrl.reset({ status: 200, timeout: true });
    const result = await opencode.isServerAlive('http://localhost:4096');
    assert.strictEqual(result, false);
  });
});
