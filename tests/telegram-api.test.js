'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const https = require('https');

const {
  telegramRequest,
  getUpdates,
  sendTelegramMessage,
  downloadTelegramFile,
  sendTelegramDocument,
} = require('../lib/telegram-api');

// ── Mock https.request / https.get ─────────────────────────────────
let mockCfg = null;
let mockCallIdx = 0;
let originalRequest = null;
let originalGet = null;

function mockRequest(opts, callback) {
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
    on(ev, fn) {
      if (ev === 'error') this._errHandler = fn;
      return this;
    },
    write(d) { this._written = d; },
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

function mockGet(url, callback) {
  // https.get(url, callback) converts URL string to options internally
  const urlObj = new URL(url);
  const opts = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname + urlObj.search,
    protocol: urlObj.protocol,
  };
  const req = mockRequest(opts, callback);
  req.end();
  return req;
}

function setupMock() {
  mockCfg = {};
  mockCallIdx = 0;
  originalRequest = https.request;
  originalGet = https.get;
  https.request = mockRequest;
  https.get = mockGet;
}

function tearDown() {
  https.request = originalRequest;
  https.get = originalGet;
  mockCfg = null;
  mockCallIdx = 0;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('telegram-api', () => {
  before(setupMock);
  after(tearDown);
  beforeEach(() => {
    mockCfg = {};
    mockCallIdx = 0;
  });

  describe('telegramRequest', () => {
    it('resolves with parsed JSON on success', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: { message_id: 42 } });
      const result = await telegramRequest('test-token', 'sendMessage', { chat_id: 123 });
      assert.deepStrictEqual(result, { ok: true, result: { message_id: 42 } });
      assert.strictEqual(mockCfg._lastReq.opts.hostname, 'api.telegram.org');
      assert.strictEqual(mockCfg._lastReq.opts.path, '/bottest-token/sendMessage');
      assert.strictEqual(mockCfg._lastReq.opts.method, 'POST');
    });

    it('rejects when JSON parsing fails', async () => {
      mockCfg.body = 'not json';
      await assert.rejects(
        telegramRequest('test-token', 'getMe', {}),
        /Failed to parse Telegram response/
      );
    });

    it('rejects on network error', async () => {
      mockCfg.netError = new Error('ECONNREFUSED');
      await assert.rejects(
        telegramRequest('test-token', 'getMe', {}),
        /ECONNREFUSED/
      );
    });
  });

  describe('getUpdates', () => {
    it('calls telegramRequest with correct params', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: [] });
      await getUpdates('test-token', 100, 60);
      assert.strictEqual(mockCfg._lastReq.opts.path, '/bottest-token/getUpdates');
      const sent = JSON.parse(mockCfg._lastReq.req._written);
      assert.deepStrictEqual(sent, {
        offset: 100,
        timeout: 60,
        allowed_updates: ['message'],
      });
    });

    it('uses default timeout of 30', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: [] });
      await getUpdates('test-token', 100);
      const sent = JSON.parse(mockCfg._lastReq.req._written);
      assert.strictEqual(sent.timeout, 30);
    });
  });

  describe('sendTelegramMessage', () => {
    it('sends message with HTML parse mode', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: { message_id: 1 } });
      await sendTelegramMessage('token', 123, '<b>hello</b>', 'HTML', 99, 5);
      const sent = JSON.parse(mockCfg._lastReq.req._written);
      assert.deepStrictEqual(sent, {
        chat_id: 123,
        text: '<b>hello</b>',
        parse_mode: 'HTML',
        reply_to_message_id: 99,
        message_thread_id: 5,
      });
    });

    it('sends message without optional params', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: { message_id: 2 } });
      await sendTelegramMessage('token', 456, 'plain text');
      const sent = JSON.parse(mockCfg._lastReq.req._written);
      assert.deepStrictEqual(sent, {
        chat_id: 456,
        text: 'plain text',
      });
    });
  });

  describe('downloadTelegramFile', () => {
    it('downloads file after getting file path', async () => {
      mockCfg.factory = (idx, opts) => {
        if (idx === 1) {
          // First call: getFile
          return {
            body: JSON.stringify({
              ok: true,
              result: { file_path: 'photos/file.jpg' },
            }),
          };
        }
        if (idx === 2) {
          // Second call: download
          return {
            body: Buffer.from('file contents'),
          };
        }
        return {};
      };

      const result = await downloadTelegramFile('token', 'file-id-123');
      assert.deepStrictEqual(result, Buffer.from('file contents'));
      assert.strictEqual(mockCfg._lastReq.opts.path, '/file/bottoken/photos/file.jpg');
    });

    it('throws when getFile fails', async () => {
      mockCfg.body = JSON.stringify({ ok: false });
      await assert.rejects(
        downloadTelegramFile('token', 'bad-id'),
        /Failed to get file info/
      );
    });
  });

  describe('sendTelegramDocument', () => {
    it('sends multipart document with caption', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: { message_id: 3 } });
      await sendTelegramDocument('token', { chatId: 123, threadId: 5 }, Buffer.from('data'), 'test.txt', 'my file');
      const req = mockCfg._lastReq.req;
      assert.ok(Buffer.isBuffer(req._written));
      assert.ok(req._written.length > 0);
      assert.strictEqual(mockCfg._lastReq.opts.path, '/bottoken/sendDocument');
      assert.ok(mockCfg._lastReq.opts.headers['Content-Type'].includes('multipart/form-data'));
    });

    it('sends document without thread or caption', async () => {
      mockCfg.body = JSON.stringify({ ok: true, result: { message_id: 4 } });
      await sendTelegramDocument('token', 456, Buffer.from('data'), 'file.bin');
      const req = mockCfg._lastReq.req;
      assert.ok(Buffer.isBuffer(req._written));
      assert.ok(req._written.length > 0);
    });

    it('rejects on API error', async () => {
      mockCfg.body = JSON.stringify({ ok: false, description: 'Bad Request' });
      await assert.rejects(
        sendTelegramDocument('token', 123, Buffer.from('x'), 'f.txt'),
        /Bad Request/
      );
    });
  });
});
