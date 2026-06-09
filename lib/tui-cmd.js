const child_process = require('child_process')
const { listenForFinalAnswer } = require('./opencode.js')

async function executeTuiCommand(paneId, server, command) {
  const commandWithSpace = command + ' '
  const cancelRef = { current: null }

  const answerPromise = listenForFinalAnswer(server, null, cancelRef)

  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'C-u'])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, '-l', commandWithSpace])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'Enter'])

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
    return null
  }
}

module.exports = { executeTuiCommand }
