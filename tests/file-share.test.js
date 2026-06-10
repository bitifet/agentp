'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureSharedDir, saveUploadedFile, formatFileSize } = require('../lib/file-share');

describe('file-share', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-share-test-'));
  });

  after(() => {
    // Cleanup: remove all temp directories
    try {
      const entries = fs.readdirSync(os.tmpdir());
      for (const entry of entries) {
        if (entry.startsWith('file-share-test-')) {
          const fullPath = path.join(os.tmpdir(), entry);
          try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch (_) {}
        }
      }
    } catch (_) {}
  });

  describe('ensureSharedDir', () => {
    it('creates telegram-shared/{uploads,downloads}/ directories', () => {
      const sharedDir = ensureSharedDir(tmpDir);
      assert.strictEqual(sharedDir, path.join(tmpDir, 'telegram-shared'));
      assert(fs.existsSync(path.join(tmpDir, 'telegram-shared', 'uploads')));
      assert(fs.existsSync(path.join(tmpDir, 'telegram-shared', 'downloads')));
    });

    it('creates .gitignore if missing and adds telegram-shared/', () => {
      ensureSharedDir(tmpDir);
      const gitignorePath = path.join(tmpDir, '.gitignore');
      assert(fs.existsSync(gitignorePath));
      const content = fs.readFileSync(gitignorePath, 'utf8');
      assert(content.includes('telegram-shared/'));
    });

    it('does not duplicate telegram-shared/ in existing .gitignore', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\ntelegram-shared/\n');
      ensureSharedDir(tmpDir);
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim() === 'telegram-shared/');
      assert.strictEqual(lines.length, 1);
    });
  });

  describe('saveUploadedFile', () => {
    it('saves file with timestamp prefix and returns relative path', () => {
      ensureSharedDir(tmpDir);
      const fileData = Buffer.from('hello world');
      const relativePath = saveUploadedFile(tmpDir, 'test.txt', fileData);
      assert(relativePath.startsWith('telegram-shared/uploads/'));
      assert(relativePath.endsWith('_test.txt'));
      const fullPath = path.join(tmpDir, relativePath);
      assert(fs.existsSync(fullPath));
      assert.strictEqual(fs.readFileSync(fullPath, 'utf8'), 'hello world');
    });

    it('sanitizes unsafe characters in filename', () => {
      ensureSharedDir(tmpDir);
      const fileData = Buffer.from('data');
      const relativePath = saveUploadedFile(tmpDir, 'file@name!123.txt', fileData);
      assert(relativePath.includes('_file_name_123.txt'));
    });
  });

  describe('formatFileSize', () => {
    it('formats bytes', () => {
      assert.strictEqual(formatFileSize(512), '512B');
    });

    it('formats kilobytes', () => {
      assert.strictEqual(formatFileSize(1536), '1.5KB');
    });

    it('formats megabytes', () => {
      assert.strictEqual(formatFileSize(2.5 * 1024 * 1024), '2.5MB');
    });
  });
});
