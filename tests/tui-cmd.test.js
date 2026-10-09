'use strict';

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const opencode = require('../lib/opencode');

describe('executeTuiCommand', { concurrency: false }, () => {
  afterEach(() => {
    mock.restoreAll();
    delete require.cache[require.resolve('../lib/tui-cmd')];
  });

  it('targets the registered tmux socket as well as its pane', async () => {
    const calls = [];
    mock.method(opencode, 'listenForFinalAnswer', async () => 'done');
    mock.method(child_process, 'spawnSync', (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    });
    delete require.cache[require.resolve('../lib/tui-cmd')];
    const { executeTuiCommand } = require('../lib/tui-cmd');
    const result = await executeTuiCommand({ socket: '/tmp/tmux/default', pane: '%7' }, 'http://x:4096', '/init');
    assert.strictEqual(result, 'done');
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(calls[0].args, ['-S', '/tmp/tmux/default', 'send-keys', '-t', '%7', 'C-u']);
    assert.deepStrictEqual(calls[1].args, ['-S', '/tmp/tmux/default', 'send-keys', '-t', '%7', '-l', '/init ']);
  });
});
