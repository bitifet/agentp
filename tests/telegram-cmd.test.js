'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseTelegramLine, getHelpText, normalizeUrl } = require('../bin/tgagentp');

describe('parseTelegramLine', () => {
  it('parses a valid [Telegram] JSON line', () => {
    const result = parseTelegramLine('[Telegram]{"command":"upload","path":"file.txt"}');
    assert.deepStrictEqual(result, { command: 'upload', path: 'file.txt' });
  });

  it('parses with all fields', () => {
    const result = parseTelegramLine('[Telegram]{"command":"download","fileId":"abc","path":"f.txt"}');
    assert.deepStrictEqual(result, { command: 'download', fileId: 'abc', path: 'f.txt' });
  });

  it('parses help command', () => {
    const result = parseTelegramLine('[Telegram]{"command":"help"}');
    assert.deepStrictEqual(result, { command: 'help' });
  });

  it('handles trailing whitespace', () => {
    const result = parseTelegramLine('[Telegram]{"command":"upload","path":"x.txt"}   ');
    assert.deepStrictEqual(result, { command: 'upload', path: 'x.txt' });
  });

  it('handles nested JSON braces', () => {
    const result = parseTelegramLine('[Telegram]{"command":"x","nested":{"key":"value"}}');
    assert.deepStrictEqual(result, { command: 'x', nested: { key: 'value' } });
  });

  it('returns null for non [Telegram] lines', () => {
    assert.strictEqual(parseTelegramLine('hello world'), null);
    assert.strictEqual(parseTelegramLine('[Telegram] not json'), null);
    assert.strictEqual(parseTelegramLine('prefix [Telegram]{"c":"x"}'), null);
  });

  it('returns null for malformed JSON', () => {
    assert.strictEqual(parseTelegramLine('[Telegram]{not valid}'), null);
  });

  it('returns null for empty line', () => {
    assert.strictEqual(parseTelegramLine(''), null);
    assert.strictEqual(parseTelegramLine('[Telegram]'), null);
  });

  it('parses msg field in upload', () => {
    const result = parseTelegramLine('[Telegram]{"command":"upload","path":"f.txt","msg":"here it is"}');
    assert.deepStrictEqual(result, { command: 'upload', path: 'f.txt', msg: 'here it is' });
  });
});

describe('getHelpText', () => {
  it('returns general help for no topic', () => {
    const text = getHelpText();
    assert.ok(text.includes('upload'));
    assert.ok(text.includes('download'));
    assert.ok(text.includes('help'));
  });

  it('returns upload help', () => {
    const text = getHelpText('upload');
    assert.ok(text.includes('upload'));
    assert.ok(text.includes('path'));
    assert.ok(text.includes('msg'));
  });

  it('returns download help', () => {
    const text = getHelpText('download');
    assert.ok(text.includes('download'));
    assert.ok(text.includes('fileId'));
    assert.ok(text.includes('path'));
  });

  it('returns help help', () => {
    const text = getHelpText('help');
    assert.ok(text.includes('help'));
    assert.ok(text.includes('topic'));
  });

  it('falls back to general help for unknown topic', () => {
    const text = getHelpText('unknown');
    assert.ok(text.includes('Available commands'));
  });
});

describe('normalizeUrl', () => {
  it('removes trailing slash', () => {
    assert.strictEqual(normalizeUrl('http://localhost:4096/'), 'http://localhost:4096');
  });

  it('removes multiple trailing slashes', () => {
    assert.strictEqual(normalizeUrl('http://localhost:4096///'), 'http://localhost:4096');
  });

  it('replaces 127.0.0.1 with localhost', () => {
    assert.strictEqual(normalizeUrl('http://127.0.0.1:4096'), 'http://localhost:4096');
  });

  it('handles 127.0.0.1 with trailing slash', () => {
    assert.strictEqual(normalizeUrl('http://127.0.0.1:4096/'), 'http://localhost:4096');
  });

  it('normalizes 127.0.0.1 with port only (matches :pattern)', () => {
    assert.strictEqual(normalizeUrl('http://127.0.0.1:8080'), 'http://localhost:8080');
  });

  it('preserves already normalized URL', () => {
    assert.strictEqual(normalizeUrl('http://localhost:4096'), 'http://localhost:4096');
  });

  it('handles non-http URLs unchanged', () => {
    assert.strictEqual(normalizeUrl('https://example.com/api/'), 'https://example.com/api');
  });

  it('returns null/undefined unchanged', () => {
    assert.strictEqual(normalizeUrl(null), null);
    assert.strictEqual(normalizeUrl(undefined), undefined);
  });
});
