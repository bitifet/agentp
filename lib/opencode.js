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

// ---------------------------------------------------------------------------
// OpenCode v2 detection
//
// OpenCode v2 moved the HTTP API under the `/api` prefix (besides now serving
// the web UI as HTML at the root), wraps responses in a `{ data }` envelope,
// and changed the SSE event schema from `{type, properties}` to
// `{id, type, data}`. Older versions keep the bare paths and old schemas.
// We probe once per server URL and cache the result.
// ---------------------------------------------------------------------------

let apiVersionOverride = null;          // 'v2' | 'legacy' | null (auto-detect)
const v2Servers = new Set();
const legacyServers = new Set();

// Test hooks: force a protocol version / clear the detection cache.
function _setApiVersion(v) { apiVersionOverride = v; }
function _resetApiCache() {
  v2Servers.clear();
  legacyServers.clear();
  apiVersionOverride = null;
}

// Synchronous fast-path for forced/cached mode; null means auto-detect needed.
function v2Mode(server) {
  if (apiVersionOverride === 'v2') return true;
  if (apiVersionOverride === 'legacy') return false;
  const key = String(server).replace(/\/+$/, '');
  if (v2Servers.has(key)) return true;
  if (legacyServers.has(key)) return false;
  return null;
}

// Returns true when `server` speaks the OpenCode v2 HTTP API.
function detectV2(server) {
  const forced = v2Mode(server);
  if (forced !== null) return Promise.resolve(forced);
  const key = String(server).replace(/\/+$/, '');
  return makeRequest(buildJsonRequest(`${key}/api/info`, 'GET'), null, null, 5000)
    .then(({ status, body }) => {
      let isV2 = status === 401; // a v2 server requires auth; legacy never 401s on /api/info
      if (status === 200) {
        const t = String(body).trim();
        if (t.startsWith('{')) {
          try {
            const info = JSON.parse(t);
            isV2 = !!(info && typeof info.version === 'string');
          } catch {
            isV2 = false;
          }
        }
      }
      (isV2 ? v2Servers : legacyServers).add(key);
      return isV2;
    })
    .catch((err) => {
      // makeRequest rejects on 401; a v2 server requires auth (legacy never
      // 401s on /api/info), so treat an auth failure as v2.
      if (err && /authentication failed/i.test(err.message)) {
        v2Servers.add(key);
        return true;
      }
      legacyServers.add(key);
      return false;
    });
}

// Base URL for API requests: `server/api` on v2, `server` on legacy.
function apiBase(server) {
  return detectV2(server).then((isV2) => {
    const key = String(server).replace(/\/+$/, '');
    return isV2 ? `${key}/api` : key;
  });
}

// v2 wraps responses in `{ data: ... }`; legacy returns raw JSON.
function parseBody(body, isV2) {
  const parsed = JSON.parse(body);
  if (!isV2) return parsed;
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
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
// v2 has no TUI prompt endpoints; deliver to the active session instead.
async function sendText(server, text) {
  if (await detectV2(server)) {
    const base = await apiBase(server);
    const { status, body } = await makeRequest(buildJsonRequest(`${base}/session/active`, 'GET'));
    if (status !== 200) return;
    let active = null;
    try {
      const data = parseBody(body, true); // data: { <sessionID>: {...} }
      const ids = data && typeof data === 'object' ? Object.keys(data) : [];
      if (ids.length > 0) active = ids[0];
    } catch {}
    if (!active) return;
    const pbody = JSON.stringify({ text, delivery: 'queue' });
    await makeRequest(buildJsonRequest(`${base}/session/${encodeURIComponent(active)}/prompt`, 'POST', pbody), pbody);
    return;
  }
  await clearPrompt(server);
  await appendPrompt(server, text);
  await submitPrompt(server);
}

// Listen for the final answer from the OpenCode event stream.
// onText(chunk) is called for each text part received (optional; defaults to no-op).
// cancelRef — if provided, { current: null } is populated with the request so it can be aborted.
// Returns a Promise that resolves with the full collected response string.
function listenForFinalAnswer(server, onText, cancelRef) {
  const mode = v2Mode(server);
  if (mode === true) return listenV2(server, null, { onText }, cancelRef);
  if (mode === false) return listenLegacyFinalAnswer(server, onText, cancelRef);
  return detectV2(server).then((isV2) =>
    isV2 ? listenV2(server, null, { onText }, cancelRef) : listenLegacyFinalAnswer(server, onText, cancelRef));
}

// Legacy (pre-v2) SSE final-answer listener: events are `{type, properties}`.
function listenLegacyFinalAnswer(server, onText, cancelRef) {
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

// OpenCode v2 SSE processor. Events arrive as `data: {id, type, data}` where
// `data` carries the payload keyed by sessionID. Text streams via
// `session.text.delta`, reasoning via `session.reasoning.delta`, completion is
// signaled by `session.execution.succeeded|failed|interrupted`.
// callbacks: { onText, onThinking, onPermission, onPermissionReplied, onQuestion, onConnected }
// opts.start — optional async fn called once the stream is connected (used to
//   send the prompt AFTER attaching the listener, so no events are missed).
// Resolves with the collected text on completion, stream end, or 90s safety timeout.
function listenV2(server, sessionId, callbacks, cancelRef, logFn, opts) {
  const sseLog = logFn || (() => {});
  return new Promise((resolve, reject) => {
    const base = String(server).replace(/\/+$/, '');
    const parsed = new URL(`${base}/api/event`);
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
      if (callbacks.onConnected) callbacks.onConnected();
      let buffer = '';
      let collected = '';
      let resolved = false;

      const cleanup = () => { if (cancelRef) cancelRef.current = null; };
      const finishResolve = (val) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        cleanup();
        req.destroy();
        res.destroy();
        resolve(val);
      };
      const finishReject = (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        cleanup();
        req.destroy();
        res.destroy();
        reject(err);
      };

      const safetyTimer = setTimeout(() => {
        sseLog(`  [SSE] safety timeout (90s), collected ${collected.length} chars\n`);
        finishResolve(collected);
      }, 90000);

      if (opts && opts.start) {
        opts.start().catch(finishReject);
      }

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

          let ev;
          try {
            ev = JSON.parse(jsonStr);
          } catch {
            continue;
          }
          let data = ev && ev.data;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = null; }
          }
          if (!data || typeof data !== 'object') continue;

          if (sessionId && data.sessionID && String(data.sessionID) !== String(sessionId)) continue;

          if (ev.type === 'session.text.delta') {
            if (data.delta != null && data.delta !== '') {
              if (callbacks.onText) callbacks.onText(data.delta);
              collected += data.delta;
            }
          } else if (ev.type === 'session.text.ended') {
            if (collected === '' && data.text != null) collected = data.text;
          } else if (ev.type === 'session.reasoning.delta') {
            if (data.delta != null && data.delta !== '' && callbacks.onThinking) callbacks.onThinking(data.delta);
          } else if (ev.type === 'permission.asked') {
            if (callbacks.onPermission) callbacks.onPermission(data);
          } else if (ev.type === 'permission.replied') {
            if (callbacks.onPermissionReplied) callbacks.onPermissionReplied(data);
          } else if (ev.type === 'form.created' || ev.type === 'question.asked') {
            if (callbacks.onQuestion) callbacks.onQuestion(data);
          } else if (ev.type === 'session.execution.succeeded'
            || ev.type === 'session.execution.failed'
            || ev.type === 'session.execution.interrupted') {
            sseLog(`  [SSE] ${ev.type} for session ${sessionId || 'any'}\n`);
            finishResolve(collected);
            return;
          }
        }
      });

      res.on('end', () => finishResolve(collected));
      res.on('error', () => finishResolve(collected));
    });

    req.on('error', reject);
    if (cancelRef) cancelRef.current = req;
    req.end();
  });
}

// List all sessions from the OpenCode server.
// Optionally filter by project directory.
async function listSessions(server, directory) {
  const isV2 = await detectV2(server);
  let url = `${await apiBase(server)}/session`;
  if (directory) url += '?directory=' + encodeURIComponent(directory);
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list sessions: ${status}`);
  return parseBody(body, isV2);
}

// Send a message directly to a specific session via the synchronous session API.
// Returns the collected text from all text parts in the response.
// Optionally specify an agent to handle the message.
// Optional cancelRef allows aborting the HTTP request (for /cancel support).
async function sendToSession(server, sessionId, text, agent, cancelRef) {
  const encoded = encodeURIComponent(sessionId);
  if (await detectV2(server)) {
    const base = await apiBase(server);
    if (agent != null) {
      const body = JSON.stringify({ agent });
      const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/agent`, 'POST', body), body);
      if (status !== 200 && status !== 204) throw new Error(`Failed to set agent: ${status}`);
    }
    // Attach to the event stream FIRST (so no events are missed), then send the
    // prompt, and resolve with the collected text when execution completes.
    return listenV2(server, sessionId, {}, cancelRef, null, {
      start: async () => {
        const body = JSON.stringify({ text, delivery: 'steer' });
        const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/prompt`, 'POST', body), body, cancelRef);
        if (status !== 200) throw new Error(`Failed to send to session: ${status}`);
      },
    });
  }

  const url = `${server}/session/${encoded}/message`;
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
  const isV2 = await detectV2(server);
  const url = `${await apiBase(server)}/session`;
  const body = JSON.stringify(title != null ? { title } : {});
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to create session: ${status}`);
  return parseBody(responseBody, isV2);
}

// Update a session's properties (e.g. title, agent, model).
// model can be a string "providerID/modelID" or an object { providerID, modelID }.
async function updateSession(server, sessionId, title, agent, model) {
  const encoded = encodeURIComponent(sessionId);
  if (await detectV2(server)) {
    // v2 PATCH accepts only title/metadata/permissions; agent and model have
    // dedicated endpoints.
    const base = await apiBase(server);
    let session = null;
    if (title != null) {
      const body = JSON.stringify({ title });
      const { status, body: responseBody } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}`, 'PATCH', body), body);
      if (status !== 200) throw new Error(`Failed to update session: ${status}`);
      session = parseBody(responseBody, true);
    }
    if (agent != null) {
      const body = JSON.stringify({ agent });
      const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/agent`, 'POST', body), body);
      if (status !== 200 && status !== 204) throw new Error(`Failed to set agent: ${status}`);
    }
    if (model != null) {
      const mObj = typeof model === 'string'
        ? { id: model }
        : { providerID: model.providerID, id: model.modelID || model.id };
      const body = JSON.stringify({ model: mObj });
      const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/model`, 'POST', body), body);
      if (status !== 200 && status !== 204) throw new Error(`Failed to set model: ${status}`);
    }
    if (session) return session;
    // Nothing to patch: return the current session info.
    const { status, body: responseBody } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}`, 'GET'));
    if (status !== 200) throw new Error(`Failed to update session: ${status}`);
    return parseBody(responseBody, true);
  }

  const bodyObj = {};
  if (title != null) bodyObj.title = title;
  if (agent != null) bodyObj.agent = agent;
  if (model != null) {
    bodyObj.model = typeof model === 'string'
      ? model
      : { providerID: model.providerID, id: model.modelID || model.id };
  }
  const url = `${server}/session/${encoded}`;
  const body = JSON.stringify(bodyObj);
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'PATCH', body), body);
  if (status !== 200) throw new Error(`Failed to update session: ${status}`);
  return JSON.parse(responseBody);
}

// Tell the TUI to navigate to a specific session (if a TUI is attached).
// Tries multiple approaches since the endpoint varies by opencode version.
async function selectSession(server, sessionId) {
  if (await detectV2(server)) {
    // v2 has no HTTP endpoint to steer the TUI to a session; the TUI keeps
    // itself in sync. Best effort: no-op.
    return;
  }
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
  if (await detectV2(server)) {
    const base = await apiBase(server);
    const urls = [`${base}/session/${encoded}`];
    for (const url of urls) {
      try {
        const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'), null, null, 10000);
        if (status === 200) {
          try {
            const parsed = parseBody(body, true);
            if (parsed != null) return parsed;
          } catch {}
        }
      } catch {}
    }
    const sessions = await listSessions(server);
    const match = sessions.find(s => String(s.id) === String(sessionId));
    if (match) return match;
    throw new Error(`Session ${sessionId} not found`);
  }
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
  const isV2 = await detectV2(server);
  const url = `${await apiBase(server)}/agent`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list agents: ${status}`);
  return parseBody(body, isV2);
}

// List all providers/models from the OpenCode server.
async function listProviders(server) {
  const isV2 = await detectV2(server);
  const url = `${await apiBase(server)}/provider`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list providers: ${status}`);
  return parseBody(body, isV2);
}

// Send a message asynchronously (non-blocking). Returns 204 No Content.
// Optionally specify a model and/or noReply (injects context without AI response).
async function sendToSessionAsync(server, sessionId, text, agent, model, noReply) {
  const encoded = encodeURIComponent(sessionId);
  if (await detectV2(server)) {
    const base = await apiBase(server);
    if (agent != null) {
      const body = JSON.stringify({ agent });
      const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/agent`, 'POST', body), body);
      if (status !== 200 && status !== 204) throw new Error(`Failed to set agent: ${status}`);
    }
    if (model != null) {
      const mObj = typeof model === 'string'
        ? { id: model }
        : { providerID: model.providerID, id: model.modelID || model.id };
      const body = JSON.stringify({ model: mObj });
      const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/model`, 'POST', body), body);
      if (status !== 200 && status !== 204) throw new Error(`Failed to set model: ${status}`);
    }
    // Non-blocking enqueue. (legacy noReply has no v2 equivalent; the prompt is
    // queued and executed when the session processes its inbox.)
    const body = JSON.stringify({ text, delivery: 'queue' });
    const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/prompt`, 'POST', body), body);
    if (status !== 200 && status !== 201 && status !== 202 && status !== 204) {
      throw new Error(`Failed to send async message: ${status}`);
    }
    return;
  }
  const url = `${server}/session/${encoded}/prompt_async`;
  const bodyObj = { parts: [{ type: 'text', text }] };
  if (agent) bodyObj.agent = agent;
  if (model) bodyObj.model = typeof model === 'string' ? model : { providerID: model.providerID, modelID: model.modelID };
  if (noReply) bodyObj.noReply = true;
  const body = JSON.stringify(bodyObj);
  const { status } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 204) throw new Error(`Failed to send async message: ${status}`);
}

// Respond to a permission request.
async function respondToPermission(server, sessionId, permissionId, response, remember) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedP = encodeURIComponent(permissionId);
  if (await detectV2(server)) {
    const base = await apiBase(server);
    // v2 decision enum: once | always | reject
    let decision = response === 'allow' ? 'once' : response;
    if (remember && decision !== 'reject') decision = 'always';
    if (!['once', 'always', 'reject'].includes(decision)) decision = 'once';
    const body = JSON.stringify({ decision });
    const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encodedS}/permission/${encodedP}/reply`, 'POST', body), body);
    if (status !== 200 && status !== 204) throw new Error(`Failed to respond to permission: ${status}`);
    return;
  }
  const url = `${server}/session/${encodedS}/permissions/${encodedP}`;
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
  const mode = v2Mode(server);
  if (mode === true) return listenV2(server, sessionId, callbacks, cancelRef, logFn, null);
  if (mode === false) return listenLegacySessionEvents(server, sessionId, callbacks, cancelRef, logFn);
  return detectV2(server).then((isV2) =>
    isV2
      ? listenV2(server, sessionId, callbacks, cancelRef, logFn, null)
      : listenLegacySessionEvents(server, sessionId, callbacks, cancelRef, logFn));
}

// Legacy (pre-v2) SSE session-event listener: events are `{type, properties}`.
function listenLegacySessionEvents(server, sessionId, callbacks, cancelRef, logFn) {
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
  return detectV2(url).then((isV2) => new Promise((resolve) => {
    const base = String(url).replace(/\/+$/, '');
    const mod = base.startsWith('https') ? https : http;
    const parsed = new URL(`${base}${isV2 ? '/api' : ''}/session`);
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
  })).catch(() => false);
}

// Respond to a question (choice) asked by the AI.
async function respondToQuestion(server, sessionId, questionId, answer) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedQ = encodeURIComponent(questionId);
  if (await detectV2(server)) {
    const base = await apiBase(server);
    const body = JSON.stringify({ answer });
    const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encodedS}/form/${encodedQ}/reply`, 'POST', body), body);
    if (status !== 200 && status !== 204) throw new Error(`Failed to respond to question: ${status}`);
    return;
  }
  const url = `${server}/session/${encodedS}/questions/${encodedQ}`;
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
  detectV2,
  apiBase,
  parseBody,
  listenV2,
  _setApiVersion,
  _resetApiCache,
};
