'use strict';

const { sendTelegramMessage } = require('./telegram-api.js');

// Lightweight Markdown to Telegram HTML conversion.
function convertMarkdownToHtml(text) {
  const parts = text.split('```');

  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // Code block ─ strip language tag, escape entities, wrap in <pre>
      const nl = part.indexOf('\n');
      const inner = nl >= 0 ? part.slice(nl + 1) : part;
      return '<pre>' + inner
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;') + '</pre>';
    }

    // Text segment

    // Phase 1: extract table blocks into placeholders
    const placeholders = [];
    let processed = '';
    const lines = part.split('\n');
    let li = 0;
    while (li < lines.length) {
      if (/^\|/.test(lines[li])) {
        const table = [];
        while (li < lines.length && /^\|/.test(lines[li])) {
          table.push(lines[li]);
          li++;
        }
        const hasSep = table.some(l => /^\|[-:| ]+\|$/.test(l));
        if (table.length >= 2 && hasSep) {
          const cleaned = table
            .map(l => l.replace(/^\|/, '').replace(/\|$/, ''))
            .filter(l => !/^\s*[|:\- ]+\s*$/.test(l));
          if (cleaned.length > 0) {
            const escaped = cleaned.map(l =>
              l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            );
            const idx = placeholders.length;
            placeholders.push('<pre>' + escaped.join('\n') + '</pre>');
            processed += '\0T' + idx + '\0\n';
            continue;
          }
        }
        for (const l of table) { processed += l + '\n'; }
      } else {
        processed += lines[li] + '\n';
        li++;
      }
    }

    // Phase 2: escape entities and apply markdown on non-table text
    let html = processed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    html = html.replace(/^\s*-{3,}\s*$/gm, '────────────────────');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');

    // Phase 3: restore table placeholders
    for (let j = 0; j < placeholders.length; j++) {
      html = html.split('\0T' + j + '\0').join(placeholders[j]);
    }

    return html;
  }).join('');
}

// Split text into chunks of at most maxLength characters,
// breaking at newlines when possible.
function splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const newlinePos = text.lastIndexOf('\n', end);
      if (newlinePos > start) {
        end = newlinePos + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// Send a text message to a Telegram chat, splitting into multiple
// messages if it exceeds the 4096-character limit.
// Converts Markdown to Telegram HTML formatting.
// Splits the raw text first, then converts each chunk independently
// to avoid broken HTML tags across messages.
async function sendLongMessage(token, chatIdOrState, text, replyTo, threadId) {
  // Accept either (token, chatState, ...) or (token, rawChatId, ...)
  const chatId = typeof chatIdOrState === 'object' && chatIdOrState.chatId != null
    ? chatIdOrState.chatId : chatIdOrState;
  const effectiveThreadId = threadId || (typeof chatIdOrState === 'object' ? chatIdOrState.threadId : undefined);
  const chunks = splitMessage(text);
  let msgIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const html = convertMarkdownToHtml(chunks[i]);
    const result = await sendTelegramMessage(token, chatId, html, 'HTML', i === 0 ? replyTo : undefined, effectiveThreadId);
    if (result && result.result) msgIds.push(result.result.message_id);
  }
  return msgIds;
}

module.exports = {
  convertMarkdownToHtml,
  splitMessage,
  sendLongMessage,
};
