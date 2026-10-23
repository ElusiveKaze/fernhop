# fernhop

[![npm](https://img.shields.io/npm/v/fernhop)](https://www.npmjs.com/package/fernhop)

[English](README.md) · **中文**

fernhop 是给 Claude 用的 OpenCode 桥：一个 MCP 服务器，让 Claude（Claude 桌面版、Claude Code 或任何 MCP 客户端）把任务交给
[OpenCode](https://opencode.ai) 去做。Claude 负责规划、派活和检查；OpenCode 用你指定的模型动手干活，
这个模型往往便宜得多。

```
Claude ──MCP（stdio）──> fernhop ──HTTP──> opencode serve ──> 你的模型
```

零依赖，只有一个 Node.js 进程，目标是装好之后不用操心：

- **共用一个 serve，不会抢密码。** 固定密码只生成一次，客户端拉起的每个桥实例都连同一个 `opencode serve`。
- **自愈。** serve 挂了或返回 401，下一次调用会自动找到或重新启动 serve 再重试。启动失败也不会让桥一直坏到重启。
- **不碰别人的进程。** 端口被别的程序占了就跳过，不会去清端口。
- **不会被工具调用超时卡住。** 每次调用最多阻塞约 50 秒；长任务先返回会话编号，再用 `check` 接着等。
- **热更新。** 逻辑都在 `core.mjs` 里，改完下一次调用就生效。
- **跟得上 OpenCode 升级。** Windows 上 serve 跑的是可执行文件的副本，原文件可以正常升级；serve 空闲时会自动换到新版本。
- **模型别名自动跟新。** 例如 `"pro"` 可以一直指向某个服务商里名字匹配 `pro` 的最新模型。

## 环境要求

- Node.js 18 或更新（Claude 桌面版扩展不需要，它用 Claude 自带的 Node.js）
- OpenCode 2.x（带 `/api/*` HTTP 接口；开发和测试用的是 2.1.3）。不支持 OpenCode 1.x。
- OpenCode 里至少配置好一个模型
- Windows、macOS 或 Linux（目前主要在 Windows 上测试过）

## 安装

先装好 OpenCode 2.x，并在里面配置好至少一个模型。然后任选一种方式。fernhop 已发布到 npm，包名就是
[`fernhop`](https://www.npmjs.com/package/fernhop)；下面的 `npx` 命令会直接从 npm 拉取，不用事先安装。

### Claude 桌面版：一键安装

1. 从[最新发布页](../../releases/latest)下载 `fernhop-<版本号>.mcpb`。
2. 双击这个文件；或者在 Claude 桌面版里打开 *设置 → 扩展（Extensions）→ 高级设置（Advanced settings）→
   安装扩展（Install Extension…）*，选中它。
3. 点 **安装（Install）**。可选设置（OpenCode 可执行文件、别名文件、端口）在扩展的页面里。

Claude 桌面版用自带的 Node.js 运行扩展，不需要另外安装任何东西。从文件安装的扩展不会自动更新：
要更新就安装新版的 `.mcpb`。

### Claude Code：一行命令

```sh
claude mcp add --scope user opencode -- npx -y fernhop
```

需要 Node.js 18 或更新。在原生 Windows 上如果连不上，给 npx 套一层 cmd：
`claude mcp add --scope user opencode -- cmd /c npx -y fernhop`。
较新的 npm 每次客户端启动它时都会检查有没有新版本。

### 其他 MCP 客户端

把 `npx -y fernhop` 作为 stdio 服务器运行：

```json
{ "mcpServers": { "opencode": { "command": "npx", "args": ["-y", "fernhop"] } } }
```

### 用 npm 全局安装

不想每次启动都经过 npx 的话，可以先装一次：

```sh
npm install -g fernhop
```

装好后 PATH 里会多一个 `fernhop` 命令，把上面的 `npx -y fernhop` 换成它就行，例如
`claude mcp add --scope user opencode -- fernhop`。全局安装不会自动更新：要更新就运行
`npm install -g fernhop@latest`。

### 从源码安装

想改代码时用这种方式：改了 `core.mjs`，下一次调用就生效。

1. 把这个仓库克隆或下载到任意位置，例如 `~/fernhop`。不需要安装任何东西。
2. 用绝对路径注册 `bridge.mjs`。

   **Claude 桌面版**：*设置 → 开发者 → 编辑配置（Edit Config）*，加入：

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

   Windows 上反斜杠要写两遍（`"C:\\Users\\you\\fernhop\\bridge.mjs"`）。如果应用找不到 `node`，
   把 `command` 改成 `node.exe` 的完整路径。改完重启 Claude 桌面版。

   **Claude Code**：

   ```sh
   claude mcp add --scope user opencode -- node /absolute/path/to/fernhop/bridge.mjs
   ```

3. （可选）跑测试：`node test/run-tests.mjs`（模拟服务器，不需要 OpenCode，约一分钟），
   或 `node test/run-tests.mjs --live`（真实 OpenCode，会调用几次模型，都是很小的任务）。

### 试一下

对 Claude 说：
*"让 opencode 给 ~/projects/foo 的命令行加一个 `--verbose` 参数，然后告诉我改了哪些文件。"*

第一次调用会在后台启动 `opencode serve`（大约一秒），不需要你自己先开 OpenCode。
同一个客户端里只注册一次（例如不要既装扩展又写配置文件），否则每个工具都会出现两遍。

## 工具

| 工具 | 作用 |
|---|---|
| `run` | 派活。参数：`prompt`（必填）、`directory`、`model`、`title`、`sessionId`（继续某个会话）、`wait`（默认 `true`）。最多等约 50 秒，返回结果和改动的文件，或者返回会话编号和当前进度。 |
| `check` | 查看会话状态和最新输出。带 `waitSeconds`（≤ 50）会一直等到任务完成或时间到。 |
| `review_changes` | 某个会话改了哪些文件，或某个 `directory` 的 `git status`。 |
| `session_list` | 最近的会话，带结果、模型和目录。 |
| `interrupt` | 停止正在跑的会话。 |
| `provider_models` | 按服务商列出模型、默认模型，以及你的别名当前指向哪个模型。 |
| `status` | 健康状况：版本、正在用的 serve（端口、pid、版本）、配置、进行中的任务、最近的错误。`restartServe: true` 重启 serve（有任务在跑时会拒绝，除非加 `force: true`）。 |

**长任务的流程**：`run` → "⏳ Still running … session_id: ses_…" → `check {sessionId, waitSeconds: 50}`（可重复）→
"✅ Done … files changed … result"。返回内容里有提示，Claude 会自己接着查。

## 选模型

`run.model` 可以填：

- `服务商/模型`，例如 `acme/model-pro-0918`
- 只在一个服务商下出现的模型 id
- `config.json` 里定义的**别名**
- 不填：用 OpenCode 的默认模型

别名写在 `~/.fernhop/config.json`（或 `FERNHOP_CONFIG` 指定的文件）里。
可以直接参考 [`examples/config.json`](examples/config.json)：

```json
{
  "aliases": {
    "pro":  { "provider": "acme", "match": "pro", "fallback": "acme/model-pro-0612", "label": "团队 key 上最强的模型" },
    "fast": { "provider": "acme", "match": "fast|flash", "label": "便宜又快" },
    "free": "opencode/some-free-model"
  },
  "providerLabels": { "acme": "团队 API", "opencode": "OpenCode 免费模型" }
}
```

- 值是字符串：固定指向这个模型。
- 值是带 `match` 的对象（不区分大小写的正则，同时匹配模型 id 和显示名）：在 `provider` 里挑**最新**的匹配模型。
  先比版本号（`v3.5` > `v3`），再比结尾的 4 位日期（`0918` > `0612`）。服务商发布了带新日期的模型，别名会自动跟过去，
  不用改配置。一个都匹配不上时用 `fallback`。
- `label` 会写进 `run` 工具的说明里给 Claude 看。你可以写自己平时的叫法（比如"团队的强模型"），Claude 会把你的话对应到别名上。
- `providerLabels` 只影响 `provider_models` 里服务商的显示名。

每次调用都会重新读取别名。工具说明里的 label 要等客户端重新拉取工具列表才会更新（重启客户端，或者改一下 `core.mjs` 的修改时间）。

## 配置项

都是可选的，作为 MCP 服务器的环境变量设置（例如 Claude 桌面版配置里的 `"env"`）。Claude 桌面版扩展的设置项对应
`OPENCODE_EXECUTABLE`、`FERNHOP_CONFIG` 和 `OPENCODE_PORT`；留空就用默认值。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `OPENCODE_PORT` | `4096` | serve 使用的起始端口 |
| `OPENCODE_PORT_SPAN` | `10` | 尝试多少个端口（`4096`–`4105`） |
| `OPENCODE_BLOCK_MS` | `50000` | `run`/`check` 最长阻塞时间，要比客户端的工具调用超时短 |
| `OPENCODE_EXECUTABLE` | 自动查找 | `opencode` 可执行文件路径（不要填 `.cmd`/`.ps1` 包装脚本） |
| `FERNHOP_DIR` | `~/.fernhop` | 状态目录 |
| `FERNHOP_CONFIG` | `<状态目录>/config.json` | 别名配置文件 |
| `OPENCODE_BASE_URL` + `OPENCODE_SERVER_PASSWORD` | — | 只连这个地址上已有的 serve，自己不启动 |
| `FERNHOP_NO_COPY` | — | Windows：直接用原可执行文件跑 serve，不用副本 |
| `OPENCODE_UPGRADE_CHECK_MS` | `600000` | 多久比较一次已安装的 OpenCode 版本和正在运行的 serve 版本 |

fernhop 在 1.1.0 之前叫 `opencode-bridge`。旧的安装照常能用：只要 `~/.fernhop` 还不存在，已有的
`~/.opencode-bridge` 就继续当状态目录；`OPENCODE_BRIDGE_DIR`、`OPENCODE_BRIDGE_CONFIG`、
`OPENCODE_BRIDGE_NO_COPY` 这几个旧变量名也仍然有效。

## 工作原理

`bridge.mjs` 是一个很小、基本不改的外壳：用 stdio 讲 MCP 协议，`core.mjs` 的修改时间一变就重新加载它。
连接状态存在外壳里，重新加载不会丢。改 `bridge.mjs` 本身需要重启客户端，改 `core.mjs` 不需要。

每次调用时，`core.mjs` 先确保手上有一个能用的 serve：

1. 用固定密码探测上次用的端口，再探测整个端口范围，第一个应答的 serve 就用它。多个桥实例就是这样共用同一个 serve 的。
2. 没有应答 → 拿一个锁文件，用 `OPENCODE_SERVER_PASSWORD=<密码>` 在第一个空闲端口后台启动
   `opencode serve --hostname=127.0.0.1 --port=<端口>`，等它应答。
3. 对所有已知密码都回 401 的端口属于别的程序：跳过。
4. 请求遇到"连接被拒绝"或 401 时，丢掉当前连接，重新探测，再重试。

任务是否完成看会话消息：派活之后出现新的 `idle` 消息就算完成。派出去的任务记录在 `pending.json` 里，
升级逻辑也靠它判断现在重启 serve 是否安全。

### 状态目录（`~/.fernhop`）

| 文件 | 内容 |
|---|---|
| `secret` | serve 的密码（只生成一次；macOS/Linux 上权限为 600） |
| `config.json` | 你的别名（可选，自己创建） |
| `state.json` | 上次使用的 serve 的端口、pid、版本 |
| `pending.json` | 已派出、尚未完成的任务 |
| `last-session` | `check` / `interrupt` / `review_changes` 默认使用的会话 |
| `bridge.log` | 桥的日志（超过 2 MB 轮换） |
| `serve-<端口>.log` | serve 的输出 |
| `bin/` | Windows：serve 实际运行的 `opencode.exe` 副本（每个版本一份，旧的会自动删除） |
| `tools-cache.json`、`spawn.lock`、`port-<端口>.pw` | 内部使用 |

## 更新

- **Claude 桌面版扩展**：安装新版的 `.mcpb`。
- **npx**：重启客户端；较新的 npm 会自动拿最新版本。
- **源码安装**：用新文件覆盖旧文件。只改了 `core.mjs`（大多数更新）就什么都不用做，下一次调用就用新代码；
  改了 `bridge.mjs` 要重启 MCP 客户端。

`status` 会显示正在运行的外壳和 core 版本；`node bridge.mjs --version` 显示包的版本。

## 排错

先调用 `status` 工具。它会显示正在用哪个 serve、OpenCode 版本，以及 `bridge.log` 里最近的错误。

- **"opencode executable not found"**：把 `OPENCODE_EXECUTABLE` 设成真正的可执行文件。Windows 上是 npm 包目录里的
  `opencode.exe`，不是 `opencode.cmd`/`.ps1` 包装脚本。
- **所有端口都 "taken by servers we cannot authenticate to"**：这段端口被别的程序占了。把 `OPENCODE_PORT` 换成别的起始端口。
- **serve 起不来**：报错里带有 `serve-<端口>.log` 的末尾内容。自己运行 `opencode serve --port=4199` 可以看到完整报错。
- **客户端里工具调用超时**：把 `OPENCODE_BLOCK_MS` 调到比客户端超时更短。
- **任务看起来卡住了**：`check` 会显示最新输出和用过的工具；`interrupt` 可以停掉它。
- **从头再来**：`status {restartServe: true}`；或者退出客户端，结束所有 `opencode serve` 进程，删掉状态目录（`config.json` 可以留着）。
- **日志**：状态目录里的 `bridge.log` 和 `serve-<端口>.log`。Claude 桌面版自己的 MCP 日志（`mcp-server-<名称>.log`）里也有桥的 stderr 输出。

## 安全说明

- serve 只监听 `127.0.0.1`，并且需要密码。能读你状态目录的人就能用这个 serve，这和他能以你的身份运行 OpenCode 是一样的。
- serve 进程的环境变量里有 `OPENCODE_SERVER_PASSWORD`，所以 agent 执行的命令能看到它。它只能用来访问这个本机 serve。
- 桥只会结束"接受了我们的密码并报出自己 pid"的 serve。
- OpenCode 以你的用户权限执行任务。注意你让它做什么，用 `directory` 指定正确的项目，并用 `review_changes` 检查改动。

## 卸载

删除扩展（*设置 → 扩展*）或客户端配置里的这个服务器，结束正在运行的 `opencode serve`，再删除
`~/.fernhop`（源码安装的话把仓库文件夹也删掉）。用 npm 全局安装的，再运行 `npm uninstall -g fernhop`。

## 开发

```sh
node test/run-tests.mjs           # 或 npm test
node test/run-tests.mjs --live    # 或 npm run test:live；用 FERNHOP_TEST_MODEL=服务商/模型 指定模型
node scripts/build-mcpb.mjs       # 或 npm run build:mcpb，生成 dist/fernhop-<版本号>.mcpb
```

测试使用临时状态目录和独立端口（模拟 4250 起，真实 4150 起），不会影响你正在用的 serve。
`test/mock-opencode.mjs` 只实现了桥用到的接口。模拟测试还会打包 `.mcpb`、解压，并按 Claude 桌面版的方式启动它。
`scripts/build-mcpb.mjs` 没有依赖；用官方打包工具结果一样
（`npx @anthropic-ai/mcpb validate manifest.json`、`npx @anthropic-ai/mcpb pack`）。

用到的 OpenCode 接口：`GET /api/info`、`GET /api/model`、`GET /api/model/default`、`POST|GET /api/session`、
`POST /api/session/:id/prompt`、`GET /api/session/:id/message`、`GET /api/session/:id/diff`、
`POST /api/session/:id/interrupt`、`GET /api/vcs/status`。OpenCode 的 HTTP 接口不是稳定的公开约定；
如果升级后接口变了，只需要改 `core.mjs`。

### 发布新版本

1. 在 `package.json` 和 `manifest.json` 里写同一个版本号（不一致时打包会报错），并写进 `CHANGELOG.md`。
2. 提交，然后推一个标签：`git tag v1.2.0 && git push origin v1.2.0`。

*Release* 工作流会跑测试、创建 GitHub Release 并附上 `.mcpb`；如果仓库设置了 `NPM_TOKEN` 密钥，
还会发布 npm 包。*CI* 工作流在每次推送和 PR 时，在 Windows、macOS、Linux 上跑模拟测试。

## 许可证

[MIT](LICENSE)
