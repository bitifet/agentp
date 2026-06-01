'use strict';

const http = require('http');
const { URL } = require('url');

function getAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return { 'Authorization': `Basic ${encoded}` };
}

function makeRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('OpenCode server authentication failed. Set OPENCODE_SERVER_PASSWORD to match the server password.'));
        } else {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function buildJsonRequest(url, method, body) {
  const parsed = new URL(url);
  const opts = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + (parsed.search || ''),
    method,
    headers: { ...getAuthHeaders() }
  };
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(body);
  }
  return opts;
}

async function clearPrompt(server) {
  const url = `${server}/tui/clear-prompt`;
  await makeRequest(buildJsonRequest(url, 'POST', '{}'), '{}');
}

async function appendPrompt(server, text) {
  const url = `${server}/tui/append-prompt`;
  const body = JSON.stringify({ text });
  await makeRequest(buildJsonRequest(url, 'POST', body), body);
}

async function submitPrompt(server) {
  const url = `${server}/tui/submit-prompt`;
  await makeRequest(buildJsonRequest(url, 'POST', '{}'), '{}');
}

// Send a complete text string as a prompt (clear + append + submit).
async function sendText(server, text) {
  await clearPrompt(server);
  await appendPrompt(server, text);
  await submitPrompt(server);
}

// Listen for the final answer from the OpenCode event stream.
// onText(chunk) is called for each text part received (optional; defaults to no-op).
// cancelRef — if provided, { current: null } is populated with the request so it can be aborted.
// Returns a Promise that resolves with the full collected response string.
function listenForFinalAnswer(server, onText, cancelRef) {
  return new Promise((resolve, reject) => {
    const url = `${server}/event`;
    const parsed = new URL(url);
    const write = typeof onText === 'function' ? onText : null;

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', ...getAuthHeaders() }
    }, (res) => {
      if (res.statusCode === 401) {
        res.resume();
        reject(new Error('OpenCode server authentication failed. Set OPENCODE_SERVER_PASSWORD to match the server password.'));
        return;
      }
      let buffer = '';
      const userMessageIDs = new Set();
      let collected = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();

        // Split by double newline (SSE event separator)
        while (buffer.includes('\n\n')) {
          const eventEnd = buffer.indexOf('\n\n');
          const eventData = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);

          // Extract data lines
          const lines = eventData.split('\n');
          let jsonStr = '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              jsonStr += line.slice(6);
            }
          }

          if (!jsonStr.trim()) continue;

          try {
            const event = JSON.parse(jsonStr);

            // Track user message IDs
            if (event.type === 'message.updated' && event.properties?.info?.role === 'user') {
              userMessageIDs.add(event.properties.info.id);
            }

            // Check for session.idle to detect completion
            if (event.type === 'session.idle') {
              cleanup();
              req.destroy();
              res.destroy();
              resolve(collected);
              return;
            }

            const part = event.properties?.part;
            if (!part) continue;

            // Filter out user input by checking messageID
            if (part.messageID && userMessageIDs.has(part.messageID)) {
              continue;
            }

            if (part.type === 'text' && part.text != null && part.text !== '') {
              if (write) write(part.text);
              collected += part.text;
            }
          } catch (e) {
            // Malformed SSE event — skip and continue processing
          }
        }
      });

      res.on('end', () => {
        cleanup();
        resolve(collected);
      });
    });

    const cleanup = () => {
      if (cancelRef) cancelRef.current = null;
    };

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });

    if (cancelRef) cancelRef.current = req;
    req.end();
  });
}

// List all sessions from the OpenCode server.
// Optionally filter by project directory.
async function listSessions(server, directory) {
  let url = `${server}/session`;
  if (directory) url += '?directory=' + encodeURIComponent(directory);
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list sessions: ${status}`);
  return JSON.parse(body);
}

// Send a message directly to a specific session via the session API.
// Returns the collected text from all text parts in the response.
async function sendToSession(server, sessionId, text) {
  const url = `${server}/session/${encodeURIComponent(sessionId)}/message`;
  const body = JSON.stringify({ parts: [{ type: 'text', text }] });
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to send to session: ${status}`);
  const result = JSON.parse(responseBody);
  const texts = (result.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('');
  return texts;
}

// List all agents from the OpenCode server.
async function listAgents(server) {
  const url = `${server}/agent`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list agents: ${status}`);
  return JSON.parse(body);
}

// List all providers/models from the OpenCode server.
async function listProviders(server) {
  const url = `${server}/provider`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list providers: ${status}`);
  return JSON.parse(body);
}

module.exports = {
  getAuthHeaders,
  makeRequest,
  buildJsonRequest,
  clearPrompt,
  appendPrompt,
  submitPrompt,
  sendText,
  listenForFinalAnswer,
  listSessions,
  sendToSession,
  listAgents,
  listProviders,
};
