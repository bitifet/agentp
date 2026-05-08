# agentp

`agentp` is a tiny CLI that pipes prompt text into a running OpenCode TUI session and streams the assistant final answer back to stdout.

It is designed for prompt-driven workflows where you want to do things like:

- compose prompts with `cat`, `printf`, or heredocs
- submit them to OpenCode from scripts
- capture output in files or pipe to other tools
- **drive prompts directly from editors** like Vim/Neovim

## Install

From npm:

```bash
npm install -g agentp
```

For local development in this repo:

```bash
npm link
```

## Requirements

- Node.js 18+
- An OpenCode server session listening locally (default port: `4096`)

Notes:

- `agentp` connects to the OpenCode event endpoint over HTTP.
- In practice this means running `opencode --serve` (or equivalent serve mode) so the port is open.
- `opencode --attach` is optional but useful to monitor the full conversation in another terminal/tmux pane.

## Usage

```bash
agentp [options] [port]
```

Options:

- `--qa`: print question/answer separators around the streamed answer
- `--help`: show help message

Arguments:

- `port`: OpenCode TUI port (defaults to `4096`)

## Examples

Send a one-line prompt:

```bash
printf "Summarize the latest logs" | agentp
```

Type and send a multi-line prompt:

```bash
cat | agentp
# (press Ctrl+D to end input)
```

Send a multi-line prompt from a file:

```bash
cat prompt.txt | agentp
```

Use QA separators and explicit port:

```bash
cat prompt.txt | agentp --qa 4096
```

Capture answer to a file:

```bash
cat prompt.txt | agentp > answer.txt
```

From Vim/Neovim, send the current visual selection and replace it in place with the assistant answer:

```vim
:'<,'>!agentp
```

From Vim/Neovim, send the current visual selection and keep QA separators in the same file:

```vim
:'<,'>!agentp --qa
```

## How It Works

1. Clears the current TUI prompt input.
2. Appends each line from stdin to the TUI prompt.
3. Submits the prompt.
4. Listens to the event stream and prints assistant text parts.
5. Stops when the session reaches idle state.

Operational hint:

- You can keep a separate `opencode --attach` view open to see the full run context while `agentp` is used from shell scripts or editor buffers.

## License

MIT
