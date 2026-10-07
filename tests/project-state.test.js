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

  it('annotations live inside .ocmux.json (single file)', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root }));
    assert.deepStrictEqual(ps.readAnnotations(sf), {});
    assert.strictEqual(ps.writeAnnotation(sf, 'ses_a', 'Remember the worktree'), 'Remember the worktree');
    assert.strictEqual(ps.readAnnotations(sf).ses_a, 'Remember the worktree');
    // the state file now carries the annotation, and no sidecar exists
    const raw = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.strictEqual(raw.annotations.ses_a, 'Remember the worktree');
    assert.ok(!fs.existsSync(ps.annotationsPath(sf)));
    // update / clear
    ps.writeAnnotation(sf, 'ses_a', 'New note');
    assert.strictEqual(ps.readAnnotations(sf).ses_a, 'New note');
    assert.strictEqual(ps.writeAnnotation(sf, 'ses_a', ''), null);
    assert.deepStrictEqual(ps.readAnnotations(sf), {});
    // multiple sessions coexist
    ps.writeAnnotation(sf, 'ses_a', 'x');
    ps.writeAnnotation(sf, 'ses_b', 'y');
    assert.deepStrictEqual(ps.readAnnotations(sf), { ses_a: 'x', ses_b: 'y' });
  });

  it('reads and migrates a legacy annotations.json sidecar', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root }));
    fs.writeFileSync(ps.annotationsPath(sf), JSON.stringify({ ses_old: 'legacy note' }));
    assert.strictEqual(ps.readAnnotations(sf).ses_old, 'legacy note');
    // a write folds it into the state file and removes the sidecar
    ps.writeAnnotation(sf, 'ses_new', 'fresh');
    assert.ok(!fs.existsSync(ps.annotationsPath(sf)));
    assert.strictEqual(ps.readAnnotations(sf).ses_old, 'legacy note');
    assert.strictEqual(ps.readAnnotations(sf).ses_new, 'fresh');
  });

  it('broadcast: persists a multi-session list and clears it', (t) => {
    const root = makeTempProject(t);
    const sf = path.join(root, '.ocmux.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 2, directory: root, session: 's1' }));
    ps.writeProjectState(sf, { broadcast: ['s1', 's2'] });
    assert.deepStrictEqual(ps.readProjectState(sf).broadcast, ['s1', 's2']);
    ps.writeProjectState(sf, { broadcast: ['s1'] }); // <2 → cleared
    assert.strictEqual(ps.readProjectState(sf).broadcast, null);
    assert.strictEqual(ps.readProjectState(sf).session, 's1'); // untouched
    // legacy parse: unknown broadcast is null
    assert.strictEqual(ps.readProjectState(sf).broadcast, null);
  });
});