'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../lib/project-state');

function makeTempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-'));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('project-state', { concurrency: false }, () => {
  let savedEnv;
  before(() => { savedEnv = process.env.AGENTP_NO_STATE; delete process.env.AGENTP_NO_STATE; });
  after(() => {
    if (savedEnv === undefined) delete process.env.AGENTP_NO_STATE;
    else process.env.AGENTP_NO_STATE = savedEnv;
  });

  it('findStatefile walks upward and returns the nearest file', (t) => {
    const root = makeTempProject(t);
    const sub = path.join(root, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, '{}');
    assert.strictEqual(ps.findStatefile(sub), sf);
    assert.strictEqual(ps.findStatefile(root), sf);
  });

  it('findStatefile returns null when there is no state file', (t) => {
    const root = makeTempProject(t);
    assert.strictEqual(ps.findStatefile(root), null);
  });

  it('AGENTP_NO_STATE disables discovery', (t) => {
    const root = makeTempProject(t);
    fs.writeFileSync(path.join(root, '.ocmux.json'), '{}');
    process.env.AGENTP_NO_STATE = '1';
    try {
      assert.strictEqual(ps.findStatefile(root), null);
    } finally {
      delete process.env.AGENTP_NO_STATE;
    }
  });

  it('normalizes legacy files (url → server, directory from file dir)', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ url: 'http://x:4096', logfile: '/tmp/l', window_index: 3 }));
    const s = ps.readProjectState(sf);
    assert.strictEqual(s.server, 'http://x:4096');
    assert.strictEqual(s.directory, root);
    assert.strictEqual(s.session, null);
    assert.strictEqual(s.version, 1);
  });

  it('reads v2 state (directory + session + server)', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root, session: 'ses_1', server: 'http://x:4097' }));
    const s = ps.readProjectState(sf);
    assert.strictEqual(s.directory, root);
    assert.strictEqual(s.session, 'ses_1');
    assert.strictEqual(s.server, 'http://x:4097');
  });

  it('returns null for missing/invalid files', (t) => {
    const root = makeTempProject(t);
    assert.strictEqual(ps.readProjectState(path.join(root, '.ocmux.json')), null);
    fs.writeFileSync(path.join(root, '.ocmux.json'), '{nope');
    assert.strictEqual(ps.readProjectState(path.join(root, '.ocmux.json')), null);
  });

  it('writeProjectState merges v2 fields atomically', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root, server: 'http://x:4097' }));
    ps.writeProjectState(sf, { session: 'ses_9' });
    const s = ps.readProjectState(sf);
    assert.strictEqual(s.version, 2);
    assert.strictEqual(s.directory, root);
    assert.strictEqual(s.server, 'http://x:4097'); // untouched
    assert.strictEqual(s.session, 'ses_9');
    // no leftover tmp file
    assert.ok(!fs.existsSync(sf + '.tmp'));
  });

  it('writeProjectState bootstraps a fresh file with directory', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    ps.writeProjectState(sf, { session: 'ses_a' });
    const s = ps.readProjectState(sf);
    assert.strictEqual(s.version, 2);
    assert.strictEqual(s.directory, root);
    assert.strictEqual(s.session, 'ses_a');
  });

  it('resolveContext returns nulls without a state file, fields with one', (t) => {
    const root = makeTempProject(t);
    const none = ps.resolveContext({ startDir: root });
    assert.strictEqual(none.statefile, null);
    assert.strictEqual(none.directory, null);
    assert.strictEqual(none.session, null);
    assert.strictEqual(none.server, null);

    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root, session: 'ses_2', server: 'http://x:4098' }));
    const ctx = ps.resolveContext({ startDir: root });
    assert.strictEqual(ctx.statefile, sf);
    assert.strictEqual(ctx.directory, root);
    assert.strictEqual(ctx.session, 'ses_2');
    assert.strictEqual(ctx.server, 'http://x:4098');
  });

  it('resolveContext honors an explicit statefile', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root, session: 'ses_3' }));
    const ctx = ps.resolveContext({ statefile: sf });
    assert.strictEqual(ctx.directory, root);
    assert.strictEqual(ctx.session, 'ses_3');
  });
});