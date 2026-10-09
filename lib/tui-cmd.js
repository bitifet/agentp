const child_process = require('child_process')
const { listenForFinalAnswer } = require('./opencode.js')

async function executeTuiCommand(paneTarget, server, command) {
  const commandWithSpace = command + ' '
  const cancelRef = { current: null }
  const paneId = typeof paneTarget === 'string' ? paneTarget : paneTarget.pane
  const socketArgs = typeof paneTarget === 'object' && paneTarget.socket
    ? ['-S', paneTarget.socket]
    : []

  const answerPromise = listenForFinalAnswer(server, null, cancelRef)

  child_process.spawnSync('tmux', [...socketArgs, 'send-keys', '-t', paneId, 'C-u'])
  child_process.spawnSync('tmux', [...socketArgs, 'send-keys', '-t', paneId, '-l', commandWithSpace])
  child_process.spawnSync('tmux', [...socketArgs, 'send-keys', '-t', paneId, 'Enter'])

  const timeoutMs = 15000
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })

  try {
    return await Promise.race([answerPromise, timeoutPromise])
  } catch {
    if (cancelRef.current) {
      cancelRef.current.destroy()
      cancelRef.current = null
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = { executeTuiCommand }
