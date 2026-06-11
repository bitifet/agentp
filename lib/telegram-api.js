'use strict';

const https = require('https');

// Make a JSON request to the Telegram Bot API.
function telegramRequest(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getUpdates(token, offset, timeout) {
  return telegramRequest(token, 'getUpdates', {
    offset,
    timeout: timeout != null ? timeout : 30,
    allowed_updates: ['message'],
  });
}

function sendTelegramMessage(token, chatId, text, parseMode, replyTo, threadId) {
  const params = { chat_id: chatId, text };
  if (parseMode) params.parse_mode = parseMode;
  if (replyTo) params.reply_to_message_id = replyTo;
  if (threadId) params.message_thread_id = threadId;
  return telegramRequest(token, 'sendMessage', params);
}

// Download a file from Telegram's file storage.
// Returns a Buffer of the file contents.
async function downloadTelegramFile(token, fileId) {
  const fileInfo = await telegramRequest(token, 'getFile', { file_id: fileId });
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error('Failed to get file info from Telegram');
  }
  const filePath = fileInfo.result.file_path;
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.telegram.org/file/bot${token}/${filePath}`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

// Send a document to Telegram using multipart/form-data.
async function sendTelegramDocument(token, chatIdOrState, fileData, fileName, caption) {
  const chatId = typeof chatIdOrState === 'object' && chatIdOrState.chatId != null
    ? chatIdOrState.chatId : chatIdOrState;
  const threadId = typeof chatIdOrState === 'object' ? chatIdOrState.threadId : undefined;

  const boundary = '----tgagentpBoundary' + Math.random().toString(36).slice(2);
  const parts = [];

  // chat_id field
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));

  // message_thread_id field (if present)
  if (threadId) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${threadId}\r\n`));
  }

  // document field (the file)
  const mimeType = 'application/octet-stream';
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from('\r\n'));

  // caption field (optional)
  if (caption) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
  }

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) resolve(result);
          else reject(new Error(result.description || 'Telegram API error'));
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  telegramRequest,
  getUpdates,
  sendTelegramMessage,
  downloadTelegramFile,
  sendTelegramDocument,
};
