'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const registry = require('../lib/tui-registry');
const ocmux = require('../lib/ocmux');

describe('tui-registry', { concurrency: false }, () => {
  let root;
  let panes;
  let calls;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmux-tui-registry-'));
    process.env.OCMUX_RUNTIME_DIR = root;
    panes = new Map();
    calls = [];
    mock.method(child_process, 'spawnSync', (cmd, args) => {
      calls.push({ cmd, args });
      assert.strictEqual(cmd, 'tmux');
      let i = 0;
      let socket = null;
      if (args[0] === '-S') {
        socket = args[1];
        i = 2;
      }
      const command = args[i];
      const targetAt = args.indexOf('-t');
      const pane = targetAt >= 0 ? args[targetAt + 1] : null;
      const key = `${socket}:${pane}`;
      if (command === 'set-option') {
        const state = panes.get(key) || { dead: false, id: '', token: '', pid: 999 };
        const unset = args.includes('-pu');
        const option = args[args.length - (unset ? 1 : 2)];
        const value = unset ? '' : args[args.length - 1];
        if (option === registry.PANE_ID_OPTION) state.id = value;
        if (option === registry.PANE_TOKEN_OPTION) state.token = value;
        panes.set(key, state);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'display-message') {
        const state = panes.get(key);
        if (!state) return { status: 1, stdout: '', stderr: 'missing' };
        return {
          status: 0,
          stdout: `${state.dead ? 1 : 0}\t${state.id}\t${state.token}\t${state.pid}\n`,
          stderr: '',
        };
      }
      if (command === 'respawn-pane') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    mock.restoreAll();
    delete process.env.OCMUX_RUNTIME_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses pane and socket identity from the tmux environment', () => {
    assert.deepStrictEqual(registry.parseTmuxEnvironment({
      TMUX: '/tmp/tmux-1000/default,1,2',
      TMUX_PANE: '%47',
    }), { socket: '/tmp/tmux-1000/default', pane: '%47' });
    assert.strictEqual(registry.parseTmuxEnvironment({}), null);
  });

  it('prefers a dedicated project TUI and falls back to the one shared TUI', () => {
    const shared = registry.register({
      socket: '/tmp/shared', pane: '%1', shared: true,
      directory: '/first', server: 'http://one', session: 's1', pid: 101,
    }).instance;
    const dedicated = registry.register({
      socket: '/tmp/project', pane: '%2', shared: false,
      directory: '/project', server: 'http://two', session: 's2', pid: 102,
    }).instance;

    assert.strictEqual(registry.resolve('/project').instance.id, dedicated.id);
    assert.strictEqual(registry.resolve('/other').instance.id, shared.id);
    assert.strictEqual(registry.resolve('/other').kind, 'shared');
  });

  it('replaces a slot and protects a newer owner from stale unregistration', () => {
    const first = registry.register({
      socket: '/tmp/a', pane: '%1', shared: true, directory: '/a', pid: 101,
    }).instance;
    const secondResult = registry.register({
      socket: '/tmp/b', pane: '%2', shared: true, directory: '/b', pid: 102,
    });
    assert.strictEqual(secondResult.displaced.id, first.id);
    const interrupted = calls.find(c => c.args.includes('send-keys') && c.args.includes('C-c'));
    assert.ok(interrupted);
    assert.deepStrictEqual(interrupted.args.slice(0, 2), ['-S', '/tmp/a']);
    assert.strictEqual(registry.unregister(first.id, first.token), false);
    assert.strictEqual(registry.resolve('/anything').instance.id, secondResult.instance.id);
  });

  it('does not interrupt itself when a respawned wrapper re-registers the same pane', () => {
    const first = registry.register({
      socket: '/tmp/same', pane: '%3', shared: true, directory: '/a', pid: 101,
    }).instance;
    calls.length = 0;
    const second = registry.register({
      socket: '/tmp/same', pane: '%3', shared: true, directory: '/b', pid: 102,
    }).instance;
    assert.notStrictEqual(second.id, first.id);
    assert.ok(!calls.some(c => c.args.includes('send-keys')));
    assert.strictEqual(registry.resolve('/anything').instance.id, second.id);
  });

  it('moves one pane between dedicated and shared slots without duplicating it', () => {
    registry.register({ socket: '/tmp/mode', pane: '%4', directory: '/project' });
    const shared = registry.register({
      socket: '/tmp/mode', pane: '%4', shared: true, directory: '/project',
    }).instance;
    const stored = registry.readRegistry();
    assert.strictEqual(Object.keys(stored.instances).length, 1);
    assert.strictEqual(stored.shared, shared.id);
    assert.strictEqual(stored.projects['/project'], undefined);
  });

  it('unregisters on matching ID/token and then falls back to shared', () => {
    const shared = registry.register({ socket: '/tmp/s', pane: '%1', shared: true, directory: '/a' }).instance;
    const dedicated = registry.register({ socket: '/tmp/d', pane: '%2', directory: '/project' }).instance;
    assert.strictEqual(registry.unregister(dedicated.id, dedicated.token), true);
    assert.strictEqual(registry.resolve('/project').instance.id, shared.id);
  });

  it('respawns the registered pane on another project/server through ocmux tui', () => {
    registry.register({ socket: '/tmp/s', pane: '%7', shared: true, directory: '/old' });
    const result = ocmux.switchTui('/new project', 'http://server:5096', 'ses_new', '/opt/agentp/bin/ocmux');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.kind, 'shared');
    const call = calls.find(c => c.args.includes('respawn-pane'));
    assert.ok(call);
    assert.deepStrictEqual(call.args.slice(0, 2), ['-S', '/tmp/s']);
    assert.ok(call.args.includes('%7'));
    const command = call.args[call.args.length - 1];
    assert.ok(command.includes("'/opt/agentp/bin/ocmux' tui --shared"));
    assert.ok(command.includes("--server 'http://server:5096'"));
    assert.ok(command.includes("--session-id 'ses_new'"));
    assert.ok(command.includes("'/new project'"));
  });

  it('prunes a registration after its pane disappears', () => {
    const instance = registry.register({ socket: '/tmp/s', pane: '%9', shared: true, directory: '/a' }).instance;
    panes.delete(`${instance.socket}:${instance.pane}`);
    assert.strictEqual(registry.resolve('/a'), null);
    const dead = registry.pruneDead();
    assert.strictEqual(dead.length, 1);
    assert.strictEqual(registry.readRegistry().shared, null);
  });
});
