'use strict';

// OpenCode v2 HTTP/SSE session API client.
//
// v2-only: endpoints live under `/api`, responses are wrapped in a `{data}`
// envelope, and the SSE event schema is `{id, type, data}` (text streams via
// `session.text.delta`, completion via `session.execution.succeeded|failed`,
// interruption via `session.execution.interrupted`). Legacy (v1) support has
// been removed.

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

// v2 is the only supported protocol now; kept for API compatibility.
function v2Mode() {
  return true;
}

function detectV2() {
  return Promise.resolve(true);
}

function _setApiVersion() { /* v2 only — kept as a no-op for compatibility */ }
function _resetApiCache() { /* v2 only — kept as a no-op for compatibility */ }

// Base URL for API requests (v2: `server/api`).
async function apiBase(server) {
  const key = String(server).replace(/\/+$/, '');
  return `${key}/api`;
}

// v2 wraps responses in `{ data: ... }`; unwrap it when present.
function parseBody(body) {
  const parsed = JSON.parse(body);
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

function makeRequest(options, data, cancelRef, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = (req) => {
      if (cancelRef && cancelRef.current === req) cancelRef.current = null;
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        cleanup(req);
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
        cleanup(req);
        reject(new Error('Request timed out'));
      });
    }
    req.on('error', (err) => {
      cleanup(req);
      reject(err);
    });
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

// Send a complete text string to the server's ACTIVE session (no TUI prompt
// endpoints exist in v2).
async function sendText(server, text) {
  const base = await apiBase(server);
  const { status, body } = await makeRequest(buildJsonRequest(`${base}/session/active`, 'GET'));
  if (status !== 200) return;
  let active = null;
  try {
    // GET /session/active → { data: { <sessionID>: {...running} } }
    const data = parseBody(body);
    const ids = data && typeof data === 'object' ? Object.keys(data) : [];
    if (ids.length > 0) active = ids[0];
  } catch {}
  if (!active) return;
  const pbody = JSON.stringify({ text, delivery: 'queue' });
  await makeRequest(buildJsonRequest(`${base}/session/${encodeURIComponent(active)}/prompt`, 'POST', pbody), pbody);
}

// Listen for the assistant's answer from the v2 SSE stream.
// onText(chunk) is called for each text part received.
// cancelRef — if provided, { current: null } is populated with the request so
// it can be aborted. Returns a Promise resolving with the full collected text.
function listenForFinalAnswer(server, onText, cancelRef) {
  return listenV2(server, null, { onText }, cancelRef);
}

// Quiescence window after a terminal `session.execution.*` event. OpenCode v2
// can signal completion before the agent is truly done (a retry may schedule a
// new execution, or a sub-agent may resume later). We resolve only after this
// window elapses with no further activity — and ANY event on the stream
// (including child-session/sub-agent events) resets it. `interrupted` resolves
// immediately.
//
// The window must comfortably exceed the longest SILENT gap of a turn (e.g. a
// long `bash`/tool call, or a sub-agent that emits nothing for a while);
// otherwise the answer gets truncated. Tunable via AGENTP_COMPLETION_GRACE_MS.
const DEFAULT_COMPLETION_GRACE_MS = 15000;
let completionGraceMs = (() => {
  const env = parseInt(process.env.AGENTP_COMPLETION_GRACE_MS, 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_COMPLETION_GRACE_MS;
})();

// Test hook: override the quiescence window (e.g. to speed up tests).
function _setCompletionGraceMs(ms) { completionGraceMs = ms; }

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
      let currentTextStart = null;
      let currentTextHadDelta = false;
      let resolved = false;
      let completionTimer = null;

      const cleanup = () => { if (cancelRef) cancelRef.current = null; };

      const clearCompletionTimer = () => {
        if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      };

      const finishResolve = (val) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        clearCompletionTimer();
        cleanup();
        req.destroy();
        res.destroy();
        resolve(val);
      };
      const finishReject = (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        clearCompletionTimer();
        cleanup();
        req.destroy();
        res.destroy();
        reject(err);
      };

      const safetyTimer = setTimeout(() => {
        sseLog(`  [SSE] safety timeout (90s), collected ${collected.length} chars\n`);
        finishResolve(collected);
      }, 90000);

      const scheduleCompletion = () => {
        if (resolved || completionTimer) return;
        completionTimer = setTimeout(async () => {
          completionTimer = null;
          // Optional second opinion: if the caller can verify the session is
          // truly idle (its idle marker newer than the send time), keep waiting
          // — otherwise a terminal signal from an OLDER queued execution would
          // resolve with an empty/partial answer.
          if (opts && typeof opts.verify === 'function' && !(await opts.verify())) {
            sseLog('  [SSE] session not yet idle after quiescence — waiting more\n');
            scheduleCompletion();
            return;
          }
          sseLog(`  [SSE] terminal signal confirmed after quiescence (${collected.length} chars)\n`);
          finishResolve(collected);
        }, completionGraceMs);
      };
      const cancelCompletion = () => {
        if (completionTimer) {
          clearCompletionTimer();
          sseLog(`  [SSE] activity after terminal signal — continuing\n`);
        }
      };

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

          // Interrupted → resolve immediately with what we have. Every other
          // in-scope event counts as activity and defers completion: we only
          // finish after a silent grace window following the last terminal
          // signal (a long-running tool would otherwise truncate the answer).
          if (ev.type === 'session.execution.interrupted') {
            sseLog(`  [SSE] session.execution.interrupted for session ${sessionId || 'any'}\n`);
            finishResolve(collected);
            return;
          }
          cancelCompletion();

          if (ev.type === 'session.text.started') {
            // v2 emits one text segment per step; separate them so the answer
            // doesn't run adjacent segments together (as the TUI shows them).
            if (collected !== '' && !collected.endsWith('\n\n')) {
              const sep = '\n\n';
              if (callbacks.onText) callbacks.onText(sep);
              collected += sep;
            }
            currentTextStart = collected.length;
            currentTextHadDelta = false;
          } else if (ev.type === 'session.text.delta') {
            if (data.delta != null && data.delta !== '') {
              if (currentTextStart === null) {
                currentTextStart = collected.length;
                currentTextHadDelta = false;
              }
              if (callbacks.onText) callbacks.onText(data.delta);
              collected += data.delta;
              currentTextHadDelta = true;
            }
          } else if (ev.type === 'session.text.ended') {
            if (data.text != null) {
              if (currentTextStart === null) {
                if (collected !== '' && !collected.endsWith('\n\n')) {
                  const sep = '\n\n';
                  if (callbacks.onText) callbacks.onText(sep);
                  collected += sep;
                }
                currentTextStart = collected.length;
                currentTextHadDelta = false;
              }
              const replacement = String(data.text);
              collected = collected.slice(0, currentTextStart) + replacement;
              if (!currentTextHadDelta && callbacks.onText && replacement) callbacks.onText(replacement);
              currentTextStart = null;
              currentTextHadDelta = false;
            }
          } else if (ev.type === 'session.reasoning.delta') {
            if (data.delta != null && data.delta !== '' && callbacks.onThinking) callbacks.onThinking(data.delta);
          } else if (ev.type === 'session.execution.started' || ev.type === 'session.retry.scheduled') {
            // activity → completion already cancelled above
          } else if (ev.type === 'permission.asked') {
            if (callbacks.onPermission) callbacks.onPermission(data);
          } else if (ev.type === 'permission.replied') {
            if (callbacks.onPermissionReplied) callbacks.onPermissionReplied(data);
          } else if (ev.type === 'form.created' || ev.type === 'question.asked') {
            if (callbacks.onQuestion) callbacks.onQuestion(data);
          } else if (ev.type === 'session.execution.succeeded'
            || ev.type === 'session.execution.failed') {
            sseLog(`  [SSE] ${ev.type} for session ${sessionId || 'any'} — awaiting quiescence\n`);
            scheduleCompletion();
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

// List sessions with a running (foreground) drain, as a Set of session IDs.
async function getActiveSessions(server) {
  try {
    const base = await apiBase(server);
    const { status, body } = await makeRequest(buildJsonRequest(`${base}/session/active`, 'GET'));
    if (status !== 200) return new Set();
    const data = parseBody(body);
    return new Set(data && typeof data === 'object' ? Object.keys(data) : []);
  } catch {
    return new Set();
  }
}

// List all sessions from the OpenCode server, optionally filtered by project
// directory (exact match on the session's location.directory).
async function listSessions(server, directory) {
  const base = `${await apiBase(server)}/session`;
  let cursor = null;
  const seen = new Set();
  const sessions = [];
  do {
    const params = new URLSearchParams();
    params.set('limit', '200');
    if (directory) params.set('directory', directory);
    if (cursor) params.set('cursor', cursor);
    const { status, body } = await makeRequest(buildJsonRequest(`${base}?${params}`, 'GET'));
    if (status !== 200) throw new Error(`Failed to list sessions: ${status}`);
    const parsed = JSON.parse(body);
    const page = parsed && typeof parsed === 'object' && Array.isArray(parsed.data)
      ? parsed.data
      : (Array.isArray(parsed) ? parsed : []);
    sessions.push(...page);
    const next = parsed && parsed.cursor && parsed.cursor.next;
    cursor = typeof next === 'string' && next && !seen.has(next) ? next : null;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return sessions;
}

// List projects known to the connected OpenCode data store.
async function listProjects(server) {
  const url = `${await apiBase(server)}/project`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list projects: ${status}`);
  const result = parseBody(body);
  return Array.isArray(result) ? result : [];
}

// Wait for OpenCode's foreground execution drain to become idle. The v2 wait
// endpoint follows successor executions admitted during cleanup, unlike a
// client-side silence timer. Returns false only when an older v2 server does
// not implement the experimental route.
async function waitForSessionIdle(server, sessionId, cancelRef) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  const { status } = await makeRequest(
    buildJsonRequest(`${base}/experimental/session/${encoded}/wait`, 'POST'),
    null,
    cancelRef,
  );
  if (status === 204) return true;
  if (status === 404 || status === 503) return false;
  throw new Error(`Failed to wait for session: ${status}`);
}

// Read message pages newest-first until the submitted prompt is found. The
// returned array contains only messages newer than that prompt, in timeline
// order. This avoids loading an entire long session while still respecting the
// API's pagination contract.
async function messagesAfterPrompt(server, sessionId, promptId, cancelRef) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  let cursor = null;
  const seen = new Set();
  const newer = [];
  do {
    const params = new URLSearchParams({ limit: '200', order: 'desc' });
    if (cursor) {
      params.delete('order');
      params.set('cursor', cursor);
    }
    const url = `${base}/session/${encoded}/message?${params}`;
    const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'), null, cancelRef);
    if (status !== 200) throw new Error(`Failed to read session messages: ${status}`);
    const parsed = JSON.parse(body);
    const page = parsed && typeof parsed === 'object' && Array.isArray(parsed.data)
      ? parsed.data
      : (Array.isArray(parsed) ? parsed : []);
    for (const message of page) {
      if (String(message.id) === String(promptId)) return newer.reverse();
      newer.push(message);
    }
    const next = parsed && parsed.cursor && parsed.cursor.next;
    cursor = typeof next === 'string' && next && !seen.has(next) ? next : null;
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new Error(`Submitted prompt ${promptId} was not found in session messages`);
}

function answerFromTurn(messages) {
  const idle = messages.findIndex(message => message && message.type === 'idle');
  const turn = idle === -1 ? messages : messages.slice(0, idle);
  const text = [];
  for (const message of turn) {
    if (!message || message.type !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && part.type === 'text' && part.text != null && part.text !== '') text.push(String(part.text));
    }
  }
  return text.join('\n\n');
}

async function readTurnAnswer(server, sessionId, promptId, cancelRef) {
  return answerFromTurn(await messagesAfterPrompt(server, sessionId, promptId, cancelRef));
}

// Compatibility fallback for v2 servers predating the wait route. Do not use a
// deadline that can turn a valid long response into a successful partial one:
// wait until the submitted prompt is projected and a newer idle transition is
// visible while the process reports no active drain.
async function pollForSessionIdle(server, sessionId, promptId, admittedAt, cancelRef) {
  for (;;) {
    let messages = null;
    try { messages = await messagesAfterPrompt(server, sessionId, promptId, cancelRef); } catch {}
    const hasIdle = messages && messages.some(message => message && message.type === 'idle');
    const active = await getActiveSessions(server);
    let idle = 0;
    try {
      const session = await getSession(server, sessionId);
      idle = session && session.time && session.time.idle || 0;
    } catch {}
    if (hasIdle && !active.has(String(sessionId)) && (!admittedAt || idle >= admittedAt)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Send a message directly to a specific session. Prompt admission gives us a
// durable message ID; wait for OpenCode to become idle, then reconstruct the
// answer from projected messages so missed/late SSE deltas cannot truncate it.
async function sendToSession(server, sessionId, text, agent, cancelRef) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  if (agent != null) {
    const body = JSON.stringify({ agent });
    const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/agent`, 'POST', body), body);
    if (status !== 200 && status !== 204) throw new Error(`Failed to set agent: ${status}`);
  }
  const body = JSON.stringify({ text, delivery: 'steer' });
  const { status, body: responseBody } = await makeRequest(
    buildJsonRequest(`${base}/session/${encoded}/prompt`, 'POST', body),
    body,
    cancelRef,
  );
  if (status !== 200) throw new Error(`Failed to send to session: ${status}`);
  let admitted;
  try { admitted = parseBody(responseBody); } catch {}
  const promptId = admitted && admitted.id;
  if (!promptId) throw new Error('OpenCode did not return the submitted prompt ID');

  const supported = await waitForSessionIdle(server, sessionId, cancelRef);
  if (!supported) {
    // Confirm the session still exists before interpreting a 404 as an older
    // server without the experimental route.
    await getSession(server, sessionId);
    const admittedAt = admitted.time && admitted.time.created;
    await pollForSessionIdle(server, sessionId, promptId, admittedAt, cancelRef);
  }
  return readTurnAnswer(server, sessionId, promptId, cancelRef);
}

// Create a new session. Optionally set a title and pin it to a project
// location (directory → Location.PublicRef `{ directory }`).
async function createSession(server, title, location) {
  const url = `${await apiBase(server)}/session`;
  const payload = {};
  if (title != null) payload.title = title;
  if (location != null) payload.location = { directory: location };
  const body = JSON.stringify(payload);
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(url, 'POST', body), body);
  if (status !== 200) throw new Error(`Failed to create session: ${status}`);
  return parseBody(responseBody);
}

// Update a session's properties (title via PATCH, agent/model via dedicated
// endpoints).
async function updateSession(server, sessionId, title, agent, model) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  let session = null;
  if (title != null) {
    const body = JSON.stringify({ title });
    const { status, body: responseBody } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}`, 'PATCH', body), body);
    // v2 returns 204 No Content on success; the updated session comes from the
    // GET below.
    if (status !== 200 && status !== 204) throw new Error(`Failed to update session: ${status}`);
    if (status === 200) session = parseBody(responseBody);
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
  const { status, body: responseBody } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}`, 'GET'));
  if (status !== 200) throw new Error(`Failed to update session: ${status}`);
  return parseBody(responseBody);
}

// Tell the TUI to navigate to a specific session. v2 has no HTTP endpoint to
// steer the TUI; the TUI keeps itself in sync, and ocmux relaunches the TUI on
// the chosen session instead.
async function selectSession() {
  return;
}

// Get a single session by ID, including its message history.
async function getSession(server, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  const urls = [`${base}/session/${encoded}`];
  for (const url of urls) {
    try {
      const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'), null, null, 10000);
      if (status === 200) {
        try {
          const parsed = parseBody(body);
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

// List all agents from the OpenCode server.
async function listAgents(server) {
  const url = `${await apiBase(server)}/agent`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list agents: ${status}`);
  return parseBody(body);
}

// List all providers from the OpenCode server.
async function listProviders(server) {
  const url = `${await apiBase(server)}/provider`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list providers: ${status}`);
  return parseBody(body);
}

// List available models as { providerID, id, label: "providerID/id", name, variants: [] }.
// `name` is the friendly display name (e.g. "Kimi K2") when the server provides it.
async function listModels(server) {
  const url = `${await apiBase(server)}/model`;
  const { status, body } = await makeRequest(buildJsonRequest(url, 'GET'));
  if (status !== 200) throw new Error(`Failed to list models: ${status}`);
  const data = parseBody(body) || [];
  const out = [];
  const toVariants = (variants) => (Array.isArray(variants)
    ? variants.map(v => (typeof v === 'string' ? v : (v && v.id))).filter(Boolean)
    : []);
  const push = (providerID, id, name, variants, context) => {
    if (!providerID || !id) return;
    if (out.some(m => m.providerID === providerID && m.id === id)) return;
    out.push({
      providerID,
      id,
      label: `${providerID}/${id}`,
      name: name && String(name) !== String(id) ? String(name) : null,
      variants: toVariants(variants),
      context: context || null,
    });
  };
  for (const m of data) push(m.providerID, m.id, m.name || m.label, m.variants, m.limit && m.limit.context);
  return out;
}

// Parse a model reference: "providerID/modelID", "modelID", optionally with a
// "#variant" suffix. Returns { providerID, id, variant } (providerID may be null).
function parseModelRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  let variant = null;
  let base = s;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    variant = s.slice(hashIdx + 1) || null;
    base = s.slice(0, hashIdx);
  }
  const slashIdx = base.indexOf('/');
  if (slashIdx === -1) return { providerID: null, id: base, variant };
  return { providerID: base.slice(0, slashIdx) || null, id: base.slice(slashIdx + 1) || null, variant };
}

// Resolve a (possibly partial) model reference against available models.
// Returns { model, matches, error }; `model` is set only when exactly one
// candidate matches. Matching is case-insensitive and, besides the canonical
// "providerID/modelID" label and bare id, also matches the friendly display
// name (e.g. "Kimi K2"); separators/quotes are ignored so "deep seek" matches
// "DeepSeek V4" and "deepseek-v4-flash".
function resolveModelRef(models, ref) {
  const q = String(ref || '').trim();
  if (!q) return { model: null, matches: models, error: null };
  const parsed = parseModelRef(q);
  const variant = parsed ? parsed.variant : null;
  const baseQ = parsed
    ? (parsed.providerID ? `${parsed.providerID}/${parsed.id}` : parsed.id)
    : q;
  const baseQLower = baseQ.toLowerCase();
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.'’]/g, '');

  // 1) Exact canonical label ("providerID/modelID").
  const byLabel = models.filter(m => m.label.toLowerCase() === baseQLower);
  if (byLabel.length === 1) return { model: { ...byLabel[0], variant }, matches: byLabel, error: null };
  if (byLabel.length > 1) {
    return { model: null, matches: byLabel, error: `multiple models match "${q}" (${byLabel.length}): ${byLabel.map(m => m.label).join(', ')}` };
  }

  // 2) Exact bare id (only when the reference has no provider prefix).
  if (!parsed || !parsed.providerID) {
    const byId = models.filter(m => m.id.toLowerCase() === baseQLower);
    if (byId.length === 1) return { model: { ...byId[0], variant }, matches: byId, error: null };
    if (byId.length > 1) {
      return { model: null, matches: byId, error: `multiple models match "${q}" (${byId.length}): ${byId.map(m => m.label).join(', ')}` };
    }
  }

  // 3) Substring match on label, bare id, or display name (raw and normalized).
  const qLower = q.toLowerCase();
  const qNorm = norm(q);
  const matches = models.filter(m =>
    m.label.toLowerCase().includes(qLower)
    || m.id.toLowerCase().includes(qLower)
    || (m.name != null && m.name.toLowerCase().includes(qLower))
    || (qNorm !== '' && (norm(m.label).includes(qNorm) || norm(m.id).includes(qNorm) || (m.name != null && norm(m.name).includes(qNorm))))
  );
  if (matches.length === 1) return { model: { ...matches[0], variant }, matches, error: null };
  const error = matches.length === 0
    ? `no model matches "${q}"`
    : `multiple models match "${q}" (${matches.length}): ${matches.map(m => m.label).join(', ')}`;
  return { model: null, matches, error };
}

// Switch the session's model immediately (POST /api/session/:id/model).
async function switchModel(server, sessionId, model) {
  const encoded = encodeURIComponent(sessionId);
  const mObj = model && typeof model === 'object' ? model : (parseModelRef(model) || {});
  if (!mObj.id || !mObj.providerID) {
    throw new Error(`Invalid model reference: ${model}`);
  }
  const base = await apiBase(server);
  const bodyObj = { model: { providerID: mObj.providerID, id: mObj.id } };
  if (mObj.variant) bodyObj.model.variant = mObj.variant;
  const body = JSON.stringify(bodyObj);
  const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/model`, 'POST', body), body);
  if (status !== 200 && status !== 204) throw new Error(`Failed to switch model: ${status}`);
}

// Send a message asynchronously (non-blocking enqueue). Optionally set an
// agent/model first. v2's noReply has no equivalent; the prompt is queued.
async function sendToSessionAsync(server, sessionId, text, agent, model) {
  const encoded = encodeURIComponent(sessionId);
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
  const body = JSON.stringify({ text, delivery: 'queue' });
  const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/prompt`, 'POST', body), body);
  if (status !== 200 && status !== 201 && status !== 202 && status !== 204) {
    throw new Error(`Failed to send async message: ${status}`);
  }
}

// Respond to a permission request (v2 decision enum: once | always | reject).
async function respondToPermission(server, sessionId, permissionId, response, remember) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedP = encodeURIComponent(permissionId);
  const base = await apiBase(server);
  let decision = response === 'allow' ? 'once' : response;
  if (remember && decision !== 'reject') decision = 'always';
  if (!['once', 'always', 'reject'].includes(decision)) decision = 'once';
  const body = JSON.stringify({ decision });
  const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encodedS}/permission/${encodedP}/reply`, 'POST', body), body);
  if (status !== 200 && status !== 204) throw new Error(`Failed to respond to permission: ${status}`);
}

// Listen for session events via the v2 SSE stream, collecting assistant text
// parts and detecting permission requests. Resolves with the collected text.
// callbacks: { onText, onPermission, onThinking, onConnected, onQuestion }
// cancelRef — allows aborting the SSE stream via req.destroy()
// logFn — optional logger
function listenForSessionEvents(server, sessionId, callbacks, cancelRef, logFn) {
  return listenV2(server, sessionId, callbacks, cancelRef, logFn, null);
}

// Check if an OpenCode server is reachable (any HTTP response = alive).
// Returns a Promise resolving to true/false.
function isServerAlive(url) {
  return new Promise((resolve) => {
    const base = String(url).replace(/\/+$/, '');
    const mod = base.startsWith('https') ? https : http;
    let parsed;
    try {
      parsed = new URL(`${base}/api/info`);
    } catch {
      resolve(false);
      return;
    }
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
  }).catch(() => false);
}

// Respond to a question (choice) asked by the AI (v2 form reply). The v2 reply
// body takes a KEYED answer map (one reply settles the whole form), but the
// legacy scalar shape still works for the single-question case.
async function respondToQuestion(server, sessionId, questionId, answer) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedQ = encodeURIComponent(questionId);
  const base = await apiBase(server);
  const body = JSON.stringify({ answer });
  const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encodedS}/form/${encodedQ}/reply`, 'POST', body), body);
  if (status !== 200 && status !== 204) throw new Error(`Failed to respond to question: ${status}`);
}

// Pull the human-readable message out of a v2 error payload when possible
// (e.g. `{ _tag: 'FormInvalidAnswerError', message, ... }`).
function serverMessage(body) {
  try {
    const parsed = JSON.parse(body || '');
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
      if (parsed.error && typeof parsed.error.message === 'string' && parsed.error.message) return parsed.error.message;
    }
  } catch { /* not JSON */ }
  return null;
}

// Pending forms (agent questions) across a location (project directory).
// `location` is a deepObject query param ({ directory }): /api/form?location[directory]=…
async function listPendingForms(server, directory) {
  const base = await apiBase(server);
  const params = new URLSearchParams();
  if (directory) params.set('location[directory]', directory);
  const { status, body } = await makeRequest(buildJsonRequest(`${base}/form?${params}`, 'GET'));
  if (status !== 200) throw new Error(`Failed to list pending forms: ${status}`);
  const parsed = parseBody(body);
  return Array.isArray(parsed) ? parsed : [];
}

// Pending forms for a single session (GET /api/session/:id/form). Each entry
// carries its own `fields` array — enough to render an answer UI.
async function listSessionForms(server, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  const { status, body } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/form`, 'GET'));
  if (status !== 200) throw new Error(`Failed to list session forms: ${status}`);
  const parsed = parseBody(body);
  return Array.isArray(parsed) ? parsed : [];
}

// Submit answers to a pending form. `answers` maps field keys to values
// (string | number | boolean | string[] for multiselect); one reply settles
// the whole form. Throws with `err.status` (400 invalid answer, 409 already
// answered) and the server's message when it provides one.
async function replyToForm(server, sessionId, formId, answers) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedF = encodeURIComponent(formId);
  const base = await apiBase(server);
  const body = JSON.stringify({ answer: answers });
  const { status, body: resBody } = await makeRequest(
    buildJsonRequest(`${base}/session/${encodedS}/form/${encodedF}/reply`, 'POST', body), body,
  );
  if (status !== 200 && status !== 204) {
    const err = new Error(serverMessage(resBody) || `Failed to answer form: ${status}`);
    err.status = status;
    throw err;
  }
}

// Pending permission requests across a location (GET /api/permission/request).
// The server returns { location, data: Permission.Request[] }; parseBody
// unwraps the data envelope.
async function listPendingPermissions(server, directory) {
  const base = await apiBase(server);
  const params = new URLSearchParams();
  if (directory) params.set('location[directory]', directory);
  const { status, body } = await makeRequest(buildJsonRequest(`${base}/permission/request?${params}`, 'GET'));
  if (status !== 200) throw new Error(`Failed to list pending permissions: ${status}`);
  const parsed = parseBody(body);
  return Array.isArray(parsed) ? parsed : [];
}

// Reply to a pending permission request. `decision` is 'once' | 'always' |
// 'reject'. Throws with `err.status` and the server's message when it provides
// one.
async function replyToPermission(server, sessionId, requestId, decision) {
  const encodedS = encodeURIComponent(sessionId);
  const encodedR = encodeURIComponent(requestId);
  const base = await apiBase(server);
  const body = JSON.stringify({ decision });
  const { status, body: resBody } = await makeRequest(
    buildJsonRequest(`${base}/session/${encodedS}/permission/${encodedR}/reply`, 'POST', body), body,
  );
  if (status !== 200 && status !== 204) {
    const err = new Error(serverMessage(resBody) || `Failed to reply to permission: ${status}`);
    err.status = status;
    throw err;
  }
}

// Sort sessions most-recently-viewed first (`time.viewed`), tie-broken by
// `time.updated`, then `time.created`. Used for target selection so agentp and
// ocmux line up with what the TUI last showed.
function sortSessionsByRecency(sessions) {
  const score = (s) => {
    const t = (s && s.time) || {};
    return t.viewed || t.updated || t.created || 0;
  };
  return [...(sessions || [])].sort((a, b) => score(b) - score(a));
}

// Delete a session (DELETE /api/session/:id).
async function deleteSession(server, sessionId) {
  const encoded = encodeURIComponent(sessionId);
  const base = await apiBase(server);
  const { status } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}`, 'DELETE'));
  if (status !== 200 && status !== 204) throw new Error(`Failed to delete session: ${status}`);
}

// Interrupt a session's active execution (like pressing ESC in the TUI).
// Returns true when an execution was actually interrupted, false otherwise
// (idle / already finished). Best-effort: never throws.
async function interruptSession(server, sessionId) {
  try {
    const encoded = encodeURIComponent(sessionId);
    const base = await apiBase(server);
    const { status, body } = await makeRequest(buildJsonRequest(`${base}/session/${encoded}/interrupt`, 'POST'));
    if (status !== 200) return false;
    try {
      const d = parseBody(body);
      return !!(d && d.interrupted);
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

// The server's default model as { providerID, id, variant? }, or null.
async function getDefaultModel(server) {
  try {
    const base = await apiBase(server);
    const { status, body } = await makeRequest(buildJsonRequest(`${base}/model/default`, 'GET'), null, null, 5000);
    if (status !== 200) return null;
    const d = parseBody(body);
    if (!d) return null;
    const providerID = d.providerID;
    const id = d.id || d.modelID;
    if (!providerID || !id) return null;
    return { providerID, id, variant: d.variant };
  } catch {
    return null;
  }
}

// Create a session and ensure it has a model. v2 sessions created via the API
// start with NO model and will not execute prompts until one is set (the prompt
// just sits in the inbox → an empty answer). Prefer the model of a reference
// session (e.g. the newest one in the project); fall back to the server default.
async function createSessionWithModel(server, title, location, referenceSessions) {
  const created = await createSession(server, title, location);
  let model = null;
  const ref = (referenceSessions || []).find(s => s && s.model && s.model.providerID && (s.model.id || s.model.modelID));
  if (ref) {
    model = {
      providerID: ref.model.providerID,
      id: ref.model.id || ref.model.modelID,
      variant: ref.model.variant,
    };
  }
  if (!model) model = await getDefaultModel(server);
  if (model && model.providerID && model.id) {
    await switchModel(server, created.id, model).catch(() => {});
  }
  return created;
}

module.exports = {
  getAuthHeaders,
  makeRequest,
  buildJsonRequest,
  sendText,
  listenForFinalAnswer,
  respondToQuestion,
  replyToForm,
  listPendingForms,
  listSessionForms,
  listPendingPermissions,
  replyToPermission,
  serverMessage,
  listSessions,
  listProjects,
  getActiveSessions,
  waitForSessionIdle,
  messagesAfterPrompt,
  answerFromTurn,
  readTurnAnswer,
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
  listModels,
  parseModelRef,
  resolveModelRef,
  switchModel,
  isServerAlive,
  detectV2,
  apiBase,
  parseBody,
  listenV2,
  sortSessionsByRecency,
  deleteSession,
  getDefaultModel,
  createSessionWithModel,
  interruptSession,
  _setApiVersion,
  _resetApiCache,
  _setCompletionGraceMs,
};
