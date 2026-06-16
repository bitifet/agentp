'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseTelegramLine, extractTelegramCommands } = require('../bin/tgagentp');

describe('parseTelegramLine', () => {
  it('parses a valid [Telegram] JSON line', () => {
    const result = parseTelegramLine('[Telegram]{"command":"upload","path":"file.txt"}');
    assert.deepStrictEqual(result, { command: 'upload', path: 'file.txt' });
  });

  it('parses with msg field', () => {
    const result = parseTelegramLine('[Telegram]{"command":"upload","path":"f.txt","msg":"here"}');
    assert.deepStrictEqual(result, { command: 'upload', path: 'f.txt', msg: 'here' });
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
});

describe('extractTelegramCommands', () => {
  it('returns null when no [Telegram] lines present', () => {
    assert.strictEqual(extractTelegramCommands('hello\nworld'), null);
  });

  it('extracts single payload and strips line', () => {
    const { payloads, text } = extractTelegramCommands(
      'hello\n[Telegram]{"command":"upload","path":"f.txt"}\nworld'
    );
    assert.strictEqual(payloads.length, 1);
    assert.deepStrictEqual(payloads[0], { command: 'upload', path: 'f.txt' });
    assert.strictEqual(text, 'hello\nworld');
  });

  it('extracts multiple payloads', () => {
    const { payloads, text } = extractTelegramCommands(
      '[Telegram]{"command":"a"}\nsome text\n[Telegram]{"command":"b"}'
    );
    assert.strictEqual(payloads.length, 2);
    assert.strictEqual(payloads[0].command, 'a');
    assert.strictEqual(payloads[1].command, 'b');
    assert.strictEqual(text, 'some text');
  });

  it('handles payload with unknown command', () => {
    const { payloads, text } = extractTelegramCommands(
      'hello\n[Telegram]{"command":"future-feature","data":42}\nworld'
    );
    assert.strictEqual(payloads.length, 1);
    assert.deepStrictEqual(payloads[0], { command: 'future-feature', data: 42 });
    assert.strictEqual(text, 'hello\nworld');
  });

  it('skips lines with other text before [Telegram]', () => {
    const { payloads, text } = extractTelegramCommands(
      'prefix [Telegram]{"command":"x"}\n[Telegram]{"command":"y"}'
    );
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].command, 'y');
    assert.ok(text.includes('prefix [Telegram]{"command":"x"}'));
  });
});
