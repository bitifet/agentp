const child_process = require('child_process')
const { listenForFinalAnswer } = require('./opencode.js')

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*(?:\x07|\x1b\\)/g, '')
}

function capturePane(paneId, lines) {
  const r = child_process.spawnSync('tmux', ['capture-pane', '-t', paneId, '-p', '-S', '-' + lines], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split('\n').map(l => stripAnsi(l).trim()).filter(l => l.length > 0)
}

// Try to extract new TUI output after a command that produced no SSE events.
function extractTuiOutput(paneId, beforeLines, maxCapture) {
  const after = capturePane(paneId, maxCapture)
  const beforeSet = new Set(beforeLines)
  const newLines = after.filter(l => !beforeSet.has(l))
  return newLines.length > 0 ? newLines.join('\n') : null
}

async function executeTuiCommand(paneId, server, command) {
  const commandWithSpace = command + ' '
  const cancelRef = { current: null }
  const paneLines = 100

  // Snapshot current TUI output before the command (for pane-capture diff)
  const before = capturePane(paneId, paneLines)

  // Start SSE listener BEFORE sending keys so we never miss events.
  // Some TUI commands (like /init loading init instructions) may trigger AI responses.
  const answerPromise = listenForFinalAnswer(server, null, cancelRef)

  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'C-u'])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, '-l', commandWithSpace])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'Enter'])

  // Wait for SSE idle event (AI response) with 15s timeout
  const timeoutMs = 15000
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })

  try {
    return await Promise.race([answerPromise, timeoutPromise])
  } catch {
    if (cancelRef.current) {
      cancelRef.current.destroy()
      cancelRef.current = null
    }
  }

  // SSE timed out — the command produced no AI response.
  // Try to extract visible TUI output that appeared after the command.
  const tuiOutput = extractTuiOutput(paneId, before, paneLines)
  if (tuiOutput) return tuiOutput

  return null
}

module.exports = { executeTuiCommand }
