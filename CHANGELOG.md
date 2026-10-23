# Changelog

## 1.1.0

New name and easier installation. No change to the tools or to how the bridge talks to OpenCode.

- Renamed from `opencode-bridge` to **fernhop**. The state directory is now `~/.fernhop` and the
  variables `FERNHOP_DIR`, `FERNHOP_CONFIG`, `FERNHOP_NO_COPY`. Existing setups keep working: an
  existing `~/.opencode-bridge` is used until `~/.fernhop` exists, and the `OPENCODE_BRIDGE_*`
  names are still read.
- One-click install for Claude Desktop: `fernhop-<version>.mcpb` (MCP Bundle), built by
  `scripts/build-mcpb.mjs` and attached to each GitHub Release. Settings for the OpenCode
  executable, alias file and port.
- npm package `fernhop`: `claude mcp add --scope user opencode -- npx -y fernhop`.
- `bridge.mjs --version` and `--help`.
- Environment variables that are empty or hold an unfilled `${...}` placeholder are ignored.
- GitHub Actions: mock tests on Windows, macOS and Linux; tagged releases publish the bundle and the
  npm package.

## 1.0.0

First public release.

- MCP tools: `run`, `check` (with `waitSeconds`), `review_changes`, `session_list`, `interrupt`,
  `provider_models`, `status`.
- One shared `opencode serve` per machine, authenticated with a fixed secret; serves run detached
  and outlive the bridge instance that started them.
- Self-healing requests: connection refused / 401 → rediscover or start a serve, then retry.
- Ports held by other programs are skipped, never cleared.
- `run`/`check` block at most `OPENCODE_BLOCK_MS` (50 s) to stay under client tool-call timeouts.
- `core.mjs` is hot-reloaded by the `bridge.mjs` shell.
- Windows: the serve runs from a copy of `opencode.exe`; an OpenCode upgrade restarts the serve
  once no task is running.
- Model aliases in `config.json`, optionally tracking the newest matching model.
- Bounded file snapshots for change tracking in non-git directories.
