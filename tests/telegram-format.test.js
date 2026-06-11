'use strict';

const { describe, it, before, after, beforeEach, mock: nodeMock } = require('node:test');
const assert = require('node:assert');

const telegramApi = require('../lib/telegram-api');
const {
  convertMarkdownToHtml,
  splitMessage,
} = require('../lib/telegram-format');

// ── Tests ──────────────────────────────────────────────────────────

describe('telegram-format', () => {
  describe('convertMarkdownToHtml', () => {
    it('escapes HTML entities', () => {
      const result = convertMarkdownToHtml('<script>alert("x")</script>');
      assert.ok(result.includes('&lt;script&gt;'));
      assert.ok(result.includes('alert("x")'));
      assert.ok(result.includes('&lt;/script&gt;'));
    });

    it('converts code blocks to <pre>', () => {
      const result = convertMarkdownToHtml('```js\nconst x = 1;\n```');
      assert.ok(result.includes('<pre>const x = 1;\n</pre>'));
    });

    it('converts inline code to <code>', () => {
      const result = convertMarkdownToHtml('use `npm test` to run');
      assert.ok(result.includes('<code>npm test</code>'));
    });

    it('converts bold to <b>', () => {
      const result = convertMarkdownToHtml('**bold text**');
      assert.ok(result.includes('<b>bold text</b>'));
    });

    it('converts italic to <i>', () => {
      const result = convertMarkdownToHtml('*italic text*');
      assert.ok(result.includes('<i>italic text</i>'));
    });

    it('converts headers to <b>', () => {
      const result = convertMarkdownToHtml('# Header 1\n## Header 2');
      assert.ok(result.includes('<b>Header 1</b>'));
      assert.ok(result.includes('<b>Header 2</b>'));
    });

    it('converts horizontal rules to dashes', () => {
      const result = convertMarkdownToHtml('---');
      assert.ok(result.includes('────────────────────'));
    });

    it('converts tables to <pre>', () => {
      const result = convertMarkdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |');
      assert.ok(result.includes('<pre> A | B \n 1 | 2 </pre>'));
    });

    it('handles nested backticks in code blocks', () => {
      const text = '```\n`single` and ``double``\n```';
      const result = convertMarkdownToHtml(text);
      assert.ok(result.includes('<pre>`single` and ``double``\n</pre>'));
    });
  });

  describe('splitMessage', () => {
    it('returns single chunk for short text', () => {
      const result = splitMessage('short text');
      assert.deepStrictEqual(result, ['short text']);
    });

    it('splits long text at maxLength', () => {
      const long = 'a'.repeat(5000);
      const result = splitMessage(long, 4096);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].length, 4096);
      assert.strictEqual(result[1].length, 904);
    });

    it('prefers splitting at newlines', () => {
      const text = 'line1\n' + 'a'.repeat(4100) + '\nline2';
      const result = splitMessage(text, 4096);
      // Should find newline before 4096
      assert.ok(result[0].endsWith('line1\n') || result[0].endsWith('line1\n\n'));
    });

    it('handles exact maxLength', () => {
      const text = 'a'.repeat(4096);
      const result = splitMessage(text, 4096);
      assert.strictEqual(result.length, 1);
    });
  });

  describe('sendLongMessage', () => {
    let sendLongMessage;
    let sentMessages = [];

    function mockSendTelegramMessage(token, chatId, text, parseMode, replyTo, threadId) {
      sentMessages.push({ token, chatId, text, parseMode, replyTo, threadId });
      return Promise.resolve({ ok: true });
    }

    before(() => {
      nodeMock.method(telegramApi, 'sendTelegramMessage', mockSendTelegramMessage);
      // Re-require telegram-format so it picks up the mocked sendTelegramMessage
      delete require.cache[require.resolve('../lib/telegram-format')];
      ({ sendLongMessage } = require('../lib/telegram-format'));
    });

    after(() => {
      nodeMock.restoreAll();
      delete require.cache[require.resolve('../lib/telegram-format')];
      sentMessages = [];
    });

    beforeEach(() => {
      sentMessages = [];
    });

    it('sends single message for short text', async () => {
      await sendLongMessage('token', 123, 'hello world', 99, 5);
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].chatId, 123);
      assert.strictEqual(sentMessages[0].replyTo, 99);
      assert.strictEqual(sentMessages[0].threadId, 5);
      assert.strictEqual(sentMessages[0].parseMode, 'HTML');
      assert.ok(sentMessages[0].text.includes('hello world'));
    });

    it('splits long text into multiple messages', async () => {
      const longText = 'a'.repeat(5000);
      await sendLongMessage('token', 123, longText);
      assert.strictEqual(sentMessages.length, 2);
      assert.strictEqual(sentMessages[0].chatId, 123);
      assert.strictEqual(sentMessages[1].chatId, 123);
      // Only first message gets replyTo
      assert.strictEqual(sentMessages[0].replyTo, undefined);
      assert.strictEqual(sentMessages[1].replyTo, undefined);
    });

    it('accepts chatState object', async () => {
      await sendLongMessage('token', { chatId: 456, threadId: 7 }, 'hello');
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].chatId, 456);
      assert.strictEqual(sentMessages[0].threadId, 7);
    });

    it('converts Markdown to HTML in each chunk', async () => {
      await sendLongMessage('token', 123, '**bold** and *italic*');
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('<b>bold</b>'));
      assert.ok(sentMessages[0].text.includes('<i>italic</i>'));
    });
  });
});
