# fernhop

[![npm](https://img.shields.io/npm/v/fernhop)](https://www.npmjs.com/package/fernhop)

**English** · [中文](README.zh-CN.md)

fernhop is an OpenCode bridge for Claude: an MCP server that lets Claude (Claude Desktop,
Claude Code, or any MCP client) hand tasks to
[OpenCode](https://opencode.ai). Claude plans, delegates and reviews; OpenCode does the hands-on
work with whatever model you point it at — often a much cheaper one.

```
Claude ──MCP (stdio)──> fernhop ──HTTP──> opencode serve ──> your model
```

Zero dependencies, one Node.js process, built to keep working without babysitting:

- **One shared serve, no password races.** A fixed secret is generated once; every bridge instance
  your client starts talks to the same `opencode serve`.
- **Self-healing.** If the serve dies or answers 401, the next call finds or starts a serve and
  retries. A failed start never leaves the bridge broken until a restart.
- **Never kills what it doesn't own.** A port held by another program is skipped, not cleared.
- **No tool-call timeouts.** Calls block at most ~50 s; long tasks return a session id and you keep
  waiting with `check`.
- **Hot reload.** All logic lives in `core.mjs`; edit it and the next call runs the new code.
- **Survives OpenCode upgrades.** On Windows the serve runs from a copy of the executable so the
  original can be upgraded; the serve is restarted on the new version once it is idle.
- **Model aliases that follow new releases.** `"pro"` can always mean "the newest model whose id
  matches `pro`" on a provider.

## Requirements

- Node.js 18 or newer (not needed for the Claude Desktop extension, which uses Claude's built-in Node.js)
- OpenCode 2.x with the `/api/*` HTTP API (developed and tested with 2.1.3). OpenCode 1.x is not supported.
- At least one model configured in OpenCode
- Windows, macOS or Linux (most of the testing so far was on Windows)

## Install

You need OpenCode 2.x with at least one model configured. Then pick one of these. fernhop is
published on npm as [`fernhop`](https://www.npmjs.com/package/fernhop); the `npx` commands below
fetch it from there, so there is nothing to install beforehand.

### Claude Desktop: one click

1. Download `fernhop-<version>.mcpb` from the [latest release](../../releases/latest).
2. Double-click it, or open *Settings → Extensions → Advanced settings → Install Extension…* in
   Claude Desktop and choose the file.
3. Click **Install**. The optional settings (OpenCode executable, alias file, port) are on the
   extension's page.

Claude Desktop runs the extension with its built-in Node.js, so nothing else needs installing.
Extensions installed from a file don't update by themselves: install the newer `.mcpb` to update.

### Claude Code: one command

```sh
claude mcp add --scope user opencode -- npx -y fernhop
```

Needs Node.js 18+. If the server does not connect on native Windows, wrap npx:
`claude mcp add --scope user opencode -- cmd /c npx -y fernhop`.
Recent npm versions check for a newer release each time the client starts it.

### Other MCP clients

Run `npx -y fernhop` as a stdio server:

```json
{ "mcpServers": { "opencode": { "command": "npx", "args": ["-y", "fernhop"] } } }
```

### Global install with npm

If you'd rather not go through npx on every start, install the package once:

```sh
npm install -g fernhop
```

This puts a `fernhop` command on your PATH. Use it in place of `npx -y fernhop` above, e.g.
`claude mcp add --scope user opencode -- fernhop`. A global install doesn't update by itself: run
`npm install -g fernhop@latest` to update.

### From source

Use this to change the code: edits to `core.mjs` take effect on the next call.

1. Clone or download this repository anywhere, e.g. `~/fernhop`. Nothing to install.
2. Register `bridge.mjs` by its absolute path.

   **Claude Desktop:** *Settings → Developer → Edit Config*, then add:

   ```json
   {
     "mcpServers": {
       "opencode": {
         "command": "node",
         "args": ["/absolute/path/to/fernhop/bridge.mjs"]
       }
     }
   }
   ```

   On Windows, escape backslashes (`"C:\\Users\\you\\fernhop\\bridge.mjs"`). If the app
   cannot find `node`, use the full path to `node.exe` as `command`. Restart Claude Desktop afterwards.

   **Claude Code:**

   ```sh
   claude mcp add --scope user opencode -- node /absolute/path/to/fernhop/bridge.mjs
   ```

3. (Optional) run the tests: `node test/run-tests.mjs` (mock server, no OpenCode needed, about a
   minute) or `node test/run-tests.mjs --live` (real OpenCode, a few tiny model calls).

### Try it

Ask Claude something like:
*"Use opencode to add a `--verbose` flag to the CLI in ~/projects/foo, then show me what changed."*

The first call starts `opencode serve` in the background (about a second). You don't need to start
OpenCode yourself. Register the bridge only once per client (for example not both as an extension
and in the config file), or every tool shows up twice.

## Tools

| Tool | What it does |
|---|---|
| `run` | Dispatch a task. Params: `prompt` (required), `directory`, `model`, `title`, `sessionId` (continue a session), `wait` (default `true`). Waits up to ~50 s, then returns either the result plus changed files, or a session id and progress. |
| `check` | Status and latest output of a session. `waitSeconds` (≤ 50) blocks until the task finishes or time is up. |
| `review_changes` | Files changed by a session, or `git status` of a `directory`. |
| `session_list` | Recent sessions with their outcome, model and directory. |
| `interrupt` | Stop a running session. |
| `provider_models` | Models grouped by provider, the default model, and your aliases with what they resolve to right now. |
| `status` | Health: versions, which serve is used (port, pid, version), config, running tasks, recent errors. `restartServe: true` restarts the serve (refused while tasks run unless `force: true`). |

**A long task looks like this:** `run` → "⏳ Still running … session_id: ses_…" → `check {sessionId, waitSeconds: 50}`
(repeat) → "✅ Done … files changed … result". Claude follows the hints in the replies on its own.

## Choosing models

`run.model` accepts:

- `provider/model`, e.g. `acme/model-pro-0918`
- a bare model id, if it exists under exactly one provider
- an **alias** from `config.json`
- nothing — OpenCode's default model

Aliases live in `~/.fernhop/config.json` (or the file named by `FERNHOP_CONFIG`).
A copy-ready example is in [`examples/config.json`](examples/config.json):

```json
{
  "aliases": {
    "pro":  { "provider": "acme", "match": "pro", "fallback": "acme/model-pro-0612", "label": "strongest model on the team key" },
    "fast": { "provider": "acme", "match": "fast|flash", "label": "cheap and quick" },
    "free": "opencode/some-free-model"
  },
  "providerLabels": { "acme": "team API", "opencode": "OpenCode free tier" }
}
```

- A string value is a fixed mapping.
- An object with `match` (a case-insensitive regex, tested against the model id and display name)
  picks the **newest** matching model of `provider` — highest version number (`v3.5` > `v3`),
  then the latest 4-digit date suffix (`0918` > `0612`). When a provider ships a new dated model,
  the alias follows it without any edits. `fallback` is used if nothing matches.
- `label` is shown to Claude in the `run` tool description, so you can write how *you* refer to
  the model ("the team's strong model") and Claude will map your words to the alias.
- `providerLabels` only change how `provider_models` lists providers.

Aliases are re-read on every call. The labels in the tool description refresh when the client
re-lists tools (restart the client, or touch `core.mjs`).

## Configuration

All optional, set as environment variables of the MCP server (e.g. the `"env"` block in the
Claude Desktop config). The Claude Desktop extension's settings fill in `OPENCODE_EXECUTABLE`,
`FERNHOP_CONFIG` and `OPENCODE_PORT`; settings left empty use the defaults.

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_PORT` | `4096` | First port to use for the serve |
| `OPENCODE_PORT_SPAN` | `10` | How many ports to try (`4096`–`4105`) |
| `OPENCODE_BLOCK_MS` | `50000` | Longest a `run`/`check` call blocks. Keep it under your client's tool-call timeout |
| `OPENCODE_EXECUTABLE` | auto-detected | Path to the `opencode` binary (not a `.cmd`/`.ps1` shim) |
| `FERNHOP_DIR` | `~/.fernhop` | State directory |
| `FERNHOP_CONFIG` | `<state dir>/config.json` | Alias config file |
| `OPENCODE_BASE_URL` + `OPENCODE_SERVER_PASSWORD` | — | Use an existing serve at this URL and never start one |
| `FERNHOP_NO_COPY` | — | Windows: run the serve from the original executable instead of a copy |
| `OPENCODE_UPGRADE_CHECK_MS` | `600000` | How often to compare the installed OpenCode version with the running serve |

fernhop was called `opencode-bridge` before 1.1.0. Existing setups keep working: an existing
`~/.opencode-bridge` stays the state directory until `~/.fernhop` exists, and `OPENCODE_BRIDGE_DIR`,
`OPENCODE_BRIDGE_CONFIG` and `OPENCODE_BRIDGE_NO_COPY` are still read.

## How it works

`bridge.mjs` is a small, stable shell: it speaks MCP over stdio and imports `core.mjs` again
whenever the file's modification time changes. Connection state lives in the shell, so a reload
loses nothing. Changing `bridge.mjs` itself needs a client restart; changing `core.mjs` doesn't.

On each call, `core.mjs` makes sure it has a working serve:

1. Probe the known port (and then the port range) with the secret. The first serve that answers
   is used — that is how several bridge instances end up sharing one serve.
2. Nothing answers → take a lock file, start `opencode serve --hostname=127.0.0.1 --port=<first free port>`
   detached, with `OPENCODE_SERVER_PASSWORD=<secret>`, and wait until it answers.
3. A port that answers 401 to every password we know belongs to someone else: it is skipped.
4. A request that hits "connection refused" or 401 drops the connection, rediscovers and retries.

Completion is detected from the session's messages: a task is done when a new `idle` message
appears after the prompt. Dispatched tasks are recorded in `pending.json`, which also tells the
upgrade logic whether it is safe to restart the serve.

### State directory (`~/.fernhop`)

| File | Contents |
|---|---|
| `secret` | The serve password (created once, mode 600 on macOS/Linux) |
| `config.json` | Your aliases (optional, you create it) |
| `state.json` | Port, pid and version of the serve last used |
| `pending.json` | Tasks dispatched and not yet finished |
| `last-session` | Default session for `check` / `interrupt` / `review_changes` |
| `bridge.log` | Bridge log (rotated at 2 MB) |
| `serve-<port>.log` | Output of the serve |
| `bin/` | Windows: the copy of `opencode.exe` the serve runs from (one per version; old ones are removed) |
| `tools-cache.json`, `spawn.lock`, `port-<port>.pw` | Internal |

## Updating

- **Claude Desktop extension:** install the newer `.mcpb`.
- **npx:** restart your client; recent npm versions fetch the newest release.
- **From source:** pull or copy the new files over the old ones. If only `core.mjs` changed (most
  updates), nothing else is needed: the next call uses it. If `bridge.mjs` changed, restart your
  MCP client.

`status` shows the running shell and core versions; `node bridge.mjs --version` prints the package
version.

## Troubleshooting

Start with the `status` tool. It shows which serve is used, the OpenCode version, and the recent
errors from `bridge.log`.

- **"opencode executable not found"** — set `OPENCODE_EXECUTABLE` to the real binary. On Windows,
  that is the `opencode.exe` inside the npm package folder, not the `opencode.cmd`/`.ps1` shim.
- **Every port is "taken by servers we cannot authenticate to"** — something else occupies the
  range. Set `OPENCODE_PORT` to another base port.
- **The serve does not start** — the error includes the tail of `serve-<port>.log`. Run
  `opencode serve --port=4199` yourself to see the full message.
- **Tool calls time out in your client** — lower `OPENCODE_BLOCK_MS` below the client's timeout.
- **A task looks stuck** — `check` shows the latest output and the tools used; `interrupt` stops it.
- **Start over** — `status {restartServe: true}`, or quit the client, end any `opencode serve`
  processes, and delete the state directory except `config.json`.
- **Logs** — `bridge.log` and `serve-<port>.log` in the state directory. Claude Desktop also keeps
  the server's stderr in its own MCP log (`mcp-server-<name>.log`).

## Security notes

- The serve listens on `127.0.0.1` only and requires the secret. Anyone who can read your state
  directory can use the serve, just as they could run OpenCode as you.
- The serve process has `OPENCODE_SERVER_PASSWORD` in its environment, so commands the agent runs
  can see it. It only grants access to that local serve.
- The bridge only ever terminates a serve that accepted its credentials and reported its pid.
- OpenCode runs tasks with your user's permissions. Review what you ask it to do, use `directory`
  to point it at the right project, and check `review_changes`.

## Uninstall

Remove the extension (*Settings → Extensions*) or the server entry from your client's config, end
any running `opencode serve`, and delete `~/.fernhop` (and the repository folder if you
installed from source). If you installed globally with npm, also run `npm uninstall -g fernhop`.

## Development

```sh
node test/run-tests.mjs           # or: npm test
node test/run-tests.mjs --live    # or: npm run test:live; FERNHOP_TEST_MODEL=provider/model picks the model
node scripts/build-mcpb.mjs       # or: npm run build:mcpb -> dist/fernhop-<version>.mcpb
```

Tests use temporary state directories and their own ports (4250+ mock, 4150+ live), so they do not
touch a serve you are using. `test/mock-opencode.mjs` implements just the API the bridge calls. The
mock tests also build the `.mcpb`, unpack it and start it the way Claude Desktop does.
`scripts/build-mcpb.mjs` has no dependencies; the official packer gives the same result
(`npx @anthropic-ai/mcpb validate manifest.json`, `npx @anthropic-ai/mcpb pack`).

OpenCode endpoints used: `GET /api/info`, `GET /api/model`, `GET /api/model/default`,
`POST|GET /api/session`, `POST /api/session/:id/prompt`, `GET /api/session/:id/message`,
`GET /api/session/:id/diff`, `POST /api/session/:id/interrupt`, `GET /api/vcs/status`.
OpenCode's HTTP API is not a stable public contract; if an upgrade changes it, `core.mjs` is the
only file to adapt.

### Releasing

1. Set the same version in `package.json` and `manifest.json` (the build refuses a mismatch) and
   add it to `CHANGELOG.md`.
2. Commit, then push a tag: `git tag v1.2.0 && git push origin v1.2.0`.

The *Release* workflow runs the tests, creates a GitHub Release with the `.mcpb` attached and, if
the repository has an `NPM_TOKEN` secret, publishes the npm package. The *CI* workflow runs the mock
tests on Windows, macOS and Linux for every push and pull request.

## License

[MIT](LICENSE)
