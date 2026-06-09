const child_process = require('child_process')

async function executeTuiCommand(paneId, command) {
  const commandWithSpace = command + ' '

  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'C-u'])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, '-l', commandWithSpace])
  child_process.spawnSync('tmux', ['send-keys', '-t', paneId, 'Enter'])
}

module.exports = { executeTuiCommand }
