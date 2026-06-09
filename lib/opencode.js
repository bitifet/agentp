'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function getAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return { 'Authorization': `Basic ${encoded}` };
}

function makeRequest(options, data, cancelRef, timeoutMs) {
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
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    }
    req.on('error', reject);
    if (cancelRef) cancelRef.current = req;
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

// Send a message directly to a specific session via the synchronous session API.
// Returns the collected text from all text parts in the response.
// Optionally specify an agent to handle the message.
// Optional cancelRef allows aborting the HTTP request (for /cancel support).
async function sendToSession(server, sessionId, text, agent, cancelRef) {
  const url = `${server}/session/${encodeURIComponent(sessionId)}/message`;
  const bodyObj = { parts: [{ type: 'text', text }] };
  if (agent) bodyObj.agent = agent;
  const body = JSON.stringify(bodyObj);
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'POST', body), body, cancelRef);
  if (status !== 200) throw new Error(`Failed to send to session: ${status}`);
  const result = JSON.parse(responseBody);
  const texts = (result.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('');
  return texts;
}

// Create a new session on the OpenCode server. Optionally set a title.
async function createSession(server, title) {
  const url = `${server}/session`;
  const body = JSON.stringify(title != null ? { title } : {});
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to create session: ${status}`);
  return JSON.parse(responseBody);
}

// Update a session's properties (e.g. title).
async function updateSession(server, sessionId, title, agent) {
  const bodyObj = {};
  if (title != null) bodyObj.title = title;
  if (agent != null) bodyObj.agent = agent;
  const url = `${server}/session/${encodeURIComponent(sessionId)}`;
  const body = JSON.stringify(bodyObj);
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'PATCH', body), body);
  if (status !== 200) throw new Error(`Failed to update session: ${status}`);
  return JSON.parse(responseBody);
}

// Tell the TUI to navigate to a specific session (if a TUI is attached).
// Tries multiple approaches since the endpoint varies by opencode version.
async function selectSession(server, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  const attempts = [
    { url: `${server}/tui/select-session`, body: JSON.stringify({ sessionID: sessionId }) },
    { url: `${server}/session/${encoded}/select`, body: '{}' },
  ];
  for (const { url, body } of attempts) {
    try {
      const { status } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
      // /session/:id/select returns 200 with HTML even for bad IDs (TUI page),
      // but doesn't actually navigate. Only consider it a success if the
      // response looks like JSON (i.e. not HTML).
      if (status === 200) return;
    } catch {
      // try next approach
    }
  }
}

// Get a single session by ID, including its message history.
// Tries GET /session/:id first; falls back to filtering the sessions list.
async function getSession(server, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  // Try several endpoint patterns that different opencode versions may expose
  const urls = [
    `${server}/session/${encoded}`,
    `${server}/session/${encoded}/messages`,
    `${server}/session/${encoded}/history`,
    `${server}/session/${encoded}/conversation`,
    `${server}/conversation/${encoded}`,
  ];
  for (const url of urls) {
    try {
      const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'), null, null, 10000);
      if (status === 200) {
        try {
          const parsed = JSON.parse(body);
          if (parsed != null) return parsed;
        } catch {}
      }
    } catch {}
  }
  // Fallback: get all sessions and find the one we need
  const sessions = await listSessions(server);
  const match = sessions.find(s => String(s.id) === String(sessionId));
  if (match) return match;
  throw new Error(`Session ${sessionId} not found`);
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

// Send a message asynchronously (non-blocking). Returns 204 No Content.
async function sendToSessionAsync(server, sessionId, text, agent) {
  const url = `${server}/session/${encodeURIComponent(sessionId)}/prompt_async`;
  const bodyObj = { parts: [{ type: 'text', text }] };
  if (agent) bodyObj.agent = agent;
  const body = JSON.stringify(bodyObj);
  const { status } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 204) throw new Error(`Failed to send async message: ${status}`);
}

// Respond to a permission request.
async function respondToPermission(server, sessionId, permissionId, response, remember) {
  const url = `${server}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`;
  const bodyObj = { response };
  if (remember) bodyObj.remember = true;
  const body = JSON.stringify(bodyObj);
  const { status } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to respond to permission: ${status}`);
}

// Listen for session events via SSE, collecting assistant text parts and detecting
// permission requests. Resolves with the full collected text when the session goes idle.
// callbacks: { onText(chunk), onPermission(permission), onThinking(chunk), onConnected(), onQuestion(question) }
// cancelRef — allows aborting the SSE stream via req.destroy()
// logFn — optional logger; if provided, used instead of process.stderr.write
function listenForSessionEvents(server, sessionId, callbacks, cancelRef, logFn) {
  const sseLog = logFn || ((msg) => {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    process.stderr.write(`${ts} ${msg}`);
  });
  sseLog(`  [SSE] connecting to ${server}/event for session ${sessionId}\n`);
  return new Promise((resolve, reject) => {
    const url = `${server}/event`;
    const parsed = new URL(url);

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
      sseLog(`  [SSE] connected for session ${sessionId}\n`);
      if (callbacks.onConnected) callbacks.onConnected();
      let buffer = '';
      const userMessageIDs = new Set();
      let collected = '';
      let resolved = false;

      // Safety timeout: resolve with whatever we have after 90s
      const safetyTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        sseLog(`  [SSE] safety timeout (90s) for session ${sessionId}, collected ${collected.length} chars\n`);
        cleanup();
        req.destroy();
        res.destroy();
        resolve(collected);
      }, 90000);

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\n\n')) {
          const eventEnd = buffer.indexOf('\n\n');
          const eventData = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);

          const lines = eventData.split('\n');
          let jsonStr = '';
          for (const line of lines) {
            if (line.startsWith('data: ')) jsonStr += line.slice(6);
          }
          if (!jsonStr.trim()) continue;

          try {
            const event = JSON.parse(jsonStr);
            const props = event.properties || {};

            if (event.type === 'session.status') {
              sseLog(`  [SSE] session.status: type=${props.status?.type} status=${JSON.stringify(props.status)}\n`);
            } else {
              sseLog(`  [SSE] event type=${event.type} sessionID=${props.sessionID} waitSession=${sessionId}\n`);
            }

            // Filter by sessionID when the event carries one (string-compare to handle type mismatches)
            if (props.sessionID && String(props.sessionID) !== String(sessionId)) continue;

            if (event.type === 'message.updated' && props.info?.role === 'user') {
              userMessageIDs.add(props.info.id);
              continue;
            }

            if (event.type === 'permission.asked') {
              const permStr = JSON.stringify(props);
              sseLog(`  [SSE] PERMISSION ASKED: ${permStr}\n`);
              if (callbacks.onPermission) {
                sseLog(`  [SSE] calling onPermission callback\n`);
                callbacks.onPermission(props);
              } else {
                sseLog(`  [SSE] WARNING: no onPermission callback registered\n`);
              }
              continue;
            }

            if (event.type === 'permission.replied') {
              sseLog(`  [SSE] PERMISSION REPLIED: type=${props.type}\n`);
              if (callbacks.onPermissionReplied) {
                callbacks.onPermissionReplied(props);
              }
              continue;
            }

            if (event.type === 'question.asked') {
              const qStr = JSON.stringify(props);
              sseLog(`  [SSE] QUESTION ASKED: ${qStr}\n`);
              if (callbacks.onQuestion) {
                sseLog(`  [SSE] calling onQuestion callback\n`);
                callbacks.onQuestion(props);
              } else {
                sseLog(`  [SSE] WARNING: no onQuestion callback registered\n`);
              }
              continue;
            }

            // Completion signals
            if (event.type === 'session.idle') {
              clearTimeout(safetyTimer);
              if (resolved) return;
              resolved = true;
              cleanup();
              req.destroy();
              res.destroy();
              resolve(collected);
              return;
            }
            if (event.type === 'session.status' && props.status?.type === 'idle') {
              clearTimeout(safetyTimer);
              if (resolved) return;
              resolved = true;
              cleanup();
              req.destroy();
              res.destroy();
              resolve(collected);
              return;
            }

            const part = props.part;
            if (!part) continue;

            // Skip echoed user input
            if (part.messageID && userMessageIDs.has(part.messageID)) continue;

            if (part.type === 'text' && part.text != null && part.text !== '') {
              if (callbacks.onText) callbacks.onText(part.text);
              collected += part.text;
            }

            if ((part.type === 'reasoning' || part.type === 'thinking') && part.text != null && part.text !== '') {
              if (callbacks.onThinking) callbacks.onThinking(part.text);
            }
          } catch (e) {
            // Malformed SSE event — skip
          }
        }
      });

      res.on('end', () => {
        clearTimeout(safetyTimer);
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(collected);
      });

      res.on('error', (err) => {
        clearTimeout(safetyTimer);
        if (resolved) return;
        resolved = true;
        cleanup();
        sseLog(`  [SSE] response stream error for session ${sessionId}: ${err.message}\n`);
        resolve(collected);   // resolve with what we have
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

// Check if an OpenCode server is reachable by making a GET /session request.
// Returns a Promise that resolves to `true` (any response) or `false` (connection error / timeout).
function isServerAlive(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url + '/session');
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: { ...getAuthHeaders() },
    };
    const req = mod.request(opts, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Respond to a question (choice) asked by the AI.
async function respondToQuestion(server, sessionId, questionId, answer) {
  const url = `${server}/session/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`;
  const body = JSON.stringify({ answer });
  const { status } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to respond to question: ${status}`);
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
  respondToQuestion,
  listSessions,
  getSession,
  createSession,
  updateSession,
  selectSession,
  sendToSession,
  sendToSessionAsync,
  respondToPermission,
  listenForSessionEvents,
  listAgents,
  listProviders,
  isServerAlive,
};
