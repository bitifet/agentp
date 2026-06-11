'use strict';

const fs = require('fs');
const path = require('path');

// Ensure telegram-shared/{uploads,downloads}/ directories exist
// and telegram-shared/ is in .gitignore.
function ensureSharedDir(projectDir) {
  const sharedDir = path.join(projectDir, 'telegram-shared');
  const uploadsDir = path.join(sharedDir, 'uploads');
  const downloadsDir = path.join(sharedDir, 'downloads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
  // Ensure .gitignore has telegram-shared/
  const gitignorePath = path.join(projectDir, '.gitignore');
  let gitignoreContent = '';
  try {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {
    // .gitignore doesn't exist, will create it
  }
  if (!gitignoreContent.split('\n').some(line => line.trim() === 'telegram-shared/' || line.trim() === 'telegram-shared')) {
    const append = gitignoreContent.endsWith('\n') || gitignoreContent === '' ? '' : '\n';
    fs.writeFileSync(gitignorePath, gitignoreContent + append + 'telegram-shared/\n');
  }
  return sharedDir;
}

// Save an uploaded file to the project's telegram-shared/uploads/ directory.
// Returns the relative path (e.g., 'telegram-shared/uploads/20250610_143022_notes.md').
function saveUploadedFile(projectDir, fileName, fileData) {
  const uploadsDir = path.join(projectDir, 'telegram-shared', 'uploads');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueName = `${timestamp}_${safeName}`;
  const filePath = path.join(uploadsDir, uniqueName);
  fs.writeFileSync(filePath, fileData);
  // Ensure data is flushed to disk so the file is immediately visible
  const fd = fs.openSync(filePath, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return path.join('telegram-shared', 'uploads', uniqueName);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = {
  ensureSharedDir,
  saveUploadedFile,
  formatFileSize,
};
