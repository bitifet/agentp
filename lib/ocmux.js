'use strict';

// TUI routing helpers. OpenCode owns the shared server and sessions; ocmux only
// routes a selected session to an explicitly registered tmux pane when one is
// available. There is no managed tmux session or per-project window layout.

const path = require('path');
const registry = require('./tui-registry');

function tuiArgs(server, session, directory) {
  const args = ['--server', server];
  if (session) args.push('--session', session);
  else args.push('--continue');
  if (directory) args.push(directory);
  return args;
}

function switchTui(directory, server, session, executable) {
  const target = registry.resolve(directory);
  if (!target) return { ok: false, reason: 'none' };
  const result = registry.respawn(target.instance, {
    executable: executable || path.resolve(__dirname, '..', 'bin', 'ocmux'),
    directory,
    server,
    session,
  });
  if (!result.ok) {
    registry.pruneDead();
    return { ok: false, reason: 'failed', kind: target.kind, error: result.error };
  }
  return { ok: true, kind: target.kind, instance: target.instance };
}

module.exports = {
  tuiArgs,
  switchTui,
};
