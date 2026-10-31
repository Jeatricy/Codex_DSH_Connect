# Codex → DeepSeek Harness

在 Codex 桌面端通过 MCP 派发任务给本机 DSH。每个任务拥有独立的 ACP 进程与持久会话，可以指定模型、查询结果、继续会话、取消任务并核验进程清理。

当前已按用户要求默认启用 **DSH 原生 Auto review + Full access**。执行模型和审查请求的思考强度分别配置；任务提交前必须收到真实 Auto 激活确认。

当前实现针对 Windows 上的 DeepSeek Harness 0.2.1 验证。使用 Node.js 22.13+（本机为 24.22.1）和 PowerShell 7，无须安装第三方 Node 依赖。

## 安装与检查

在项目目录运行：

```powershell
node --run test
node scripts/doctor.mjs
.\scripts\install.ps1
```

安装脚本使用 Codex CLI 注册用户级 MCP 服务器 `deepseek_harness`，保留其他配置；发现同名且不同的配置时会停止，避免覆盖。Node 与项目路径均使用绝对路径。

注册后在 Codex 的 MCP 设置中重新载入服务器，或新建聊天以加载工具。CLI 可用 `codex mcp list` 检查配置。当前聊天不一定能即时获得新增工具。

如果不使用安装脚本，可手动注册：

```powershell
codex mcp add deepseek_harness -- <node.exe的绝对路径> 'D:\Program Project\Codex_DSH_Connect\server.mjs' --config 'D:\Program Project\Codex_DSH_Connect\bridge.config.json'
```

DSH 自动化 profile 初次运行会在 DSH 自己的配置目录中初始化。它复用 ACP profile 加载的凭据，桥接器不复制或打印密钥。模型目录可见不代表该供应商具备有效凭据或余额。

## 使用方式

可以直接对 Codex 说：

> 用 deepseek_harness 查看这个项目可用的 DSH 模型，然后使用 deepseek-official 供应商的 deepseek-flash，调查存档逻辑。只读分析，返回代码位置、问题证据和建议；任务时限 5 分钟。你收回结果后核对证据。

工具调用示例：

```json
{
  "cwd": "D:\\Program Project\\Codex_DSH_Connect",
  "task": "调查存档逻辑，返回代码位置、问题证据和建议。",
  "instructions": "只读分析，不修改文件。",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoning_effort": "high",
  "review_reasoning_effort": "high",
  "timeout_sec": 300
}
```

提交前先调用 `deepseek_list_models`。同一模型可能同时出现在 `deepseek-official` 与 `deepseek-account`，应指定 `provider`，或直接使用返回的完整 `selector`。桥接器以 ACP 返回的原始选项值设置模型，并核对 DSH 确认后的结果；不存在的模型、歧义名称或不受支持的推理档位会失败，不会提交任务或静默替换。

`reasoning_effort` 控制执行任务的模型，当前配置默认 `high`，也可用 `model-default` 采用模型默认值（包括没有推理开关的模型）。`review_reasoning_effort` 控制每次原生 Auto 审查请求，默认 `inherit`（跟随被审查代理当前思考强度）；也可选 `model-default` 或该模型公开的具体档位，如 `off`、`low`、`high`、`max`。不同模型的词汇可能不同，以发现结果为准。审查仍使用被审查代理的供应商与模型，两个强度相互独立；未知强度在提交任务前报错。

`deepseek_spawn` 立即返回任务 ID。用 `deepseek_status` 或最长等待 20 秒的 `deepseek_wait` 查询；Codex 可以在此期间处理其他独立工作。`completed` 表示 ACP 返回了非空答案，主代理仍须验证结论、文件改动与测试证据。协议本身并不能证明代码工作正确。

### 向 Harness 会话传入 MCP 服务

`deepseek_spawn` 和 `deepseek_send` 支持可选参数 `mcp_servers`。桥接器在 ACP `session/new` / `session/resume` 时挂载这些服务，发现的工具以 `mcp__<name>__<tool>` 出现在 Harness 模型的原生工具清单中。连接或工具发现失败时，本轮在提交模型任务前失败；不改用 Shell/CLI，也不安装 MCP 服务。

例如，让 Harness 直接读取当前 Unity 项目信息：

```json
{
  "cwd": "E:\\Unity Project\\AnonPrismPiano",
  "model": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
  "task": "只使用原生 Unity MCP 工具与资源，读取实例列表和项目根目录，确认目标为 AnonPrismPiano；不修改项目。",
  "mcp_servers": [
    { "type": "http", "name": "UnityMCP", "url": "http://127.0.0.1:8080/mcp" }
  ]
}
```

支持 ACP 的两种传输格式：

- HTTP：`{ "type": "http", "name": "service", "url": "https://host/mcp", "headers": [{ "name": "Authorization", "value": "Bearer ..." }] }`，`headers` 可省略。
- stdio：`{ "type": "stdio", "name": "service", "command": "C:\\absolute\\server.exe", "args": ["--mcp"], "env": [{ "name": "TOKEN", "value": "..." }] }`。`type`、`args`、`env` 可省略；命令必须是绝对路径，不经 Shell 拼接。

`name` 为 1–32 位字母、数字、下划线或连字符，同一会话中不得重复。最多 32 个服务，整个配置的 UTF-8 JSON 不超过 128000 字节。不支持 SSE 或 ACP 作为 MCP 传输。项目的 `.mcp.json` 不会自动导入，服务需显式传入。

新建任务省略 `mcp_servers` 等价于 `[]`。继续会话时省略则继承上一轮的配置；传入数组会整体替换，传入 `[]` 会移除全部挂载。旧任务没有该字段时按空数组恢复。配置先校验再创建任务/占用工作目录，调用者事后修改传入对象不会改变已接受的配置。

恢复会话需要完整连接信息，因此认证 headers、环境变量和参数会保存在私有 `.bridge-data` 任务记录中，按凭据文件保管。工具状态响应中的 `mcp_servers` 和历史轮次仅返回服务名、传输及地址/命令摘要，隐藏 headers、env、args 和 URL 认证信息/查询值；MCP 返回的内容与进程错误仍可能进入任务日志。传入服务即授权该端点连接或 stdio 命令启动，模型的后续工具调用继续走现有原生 Auto review。

更新桥接器代码后需在 Codex 中重新载入该 MCP 服务器，或新建聊天以刷新工具参数定义。

### 等待与主聊天唤醒

`mcp_servers` 负责给 DSH 挂载原生工具。当前版本提供 `deepseek_status` / `deepseek_wait` 查询和等待结果，不会主动唤醒已经结束回合的 Codex 主聊天；标准 MCP/ACP 进度通知也不代表主模型会自动续跑。需要全自动接续时，还需接入主应用实际支持的完成事件/唤醒机制，本版本未实现该功能。

为减少主代理上下文，可在确有必要的状态查询中使用 `max_chars: 0`，完成后再读取一次最终答案和相关差异。任务在桥接器连接存活时后台执行；整个 MCP 连接断开会按现有取消策略清理任务，因此不能用关闭桥接器代替等待。

## 工具

| 工具 | 用途 |
| --- | --- |
| `deepseek_list_models` | 读取当前 ACP profile 的真实模型选项；传入模型后可查看对应推理档位。不提交推理任务。 |
| `deepseek_spawn` | 指定模型并派发独立任务，返回 `task_id`（响应中的 `id`）。 |
| `deepseek_status` | 查询进度、真实选择、最近输出、待处理权限及清理结果。 |
| `deepseek_list_tasks` | 列出本地持久化任务，包含其他 MCP 连接创建的任务。 |
| `deepseek_wait` | 等待完成或权限请求，最长 20 秒。等待结束不取消后台任务。 |
| `deepseek_read_output` | 按字符偏移分段读取答案，单次最多 24000 字符。 |
| `deepseek_send` | 原任务结束且清理确认后，恢复同一 DSH 会话发送下一轮，可明确换模型。 |
| `deepseek_cancel` | 启动有界取消，随后查询状态确认停止。 |
| `deepseek_close` | 取消必要活动并禁止后续继续，保留记录。 |
| `deepseek_respond_permission` | 处理 DSH 实际发出的单次权限请求，不提供永久允许选项。 |
| `deepseek_recover` | 检查桥接器退出后的孤立任务；仅在 Windows 任务守护进程已确认退出时解除占用。 |

多个 MCP 连接共享 SQLite 任务记录与目录占用。取消、关闭和权限响应可以转交仍在运行的原连接处理。每个活动任务只接受一轮提示词，`deepseek_send` 等上一轮结束后再调用。

## 模型不返回时

计时器由桥接器执行，不依赖 GPT 是否轮询状态。默认策略：

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| `auto_review` | `true` | 加载原生审查器、切换根会话到 Auto，并在发任务前核验实际权限。 |
| `default_reasoning_effort` | `high` | 执行模型默认思考强度，必须受所选模型支持。 |
| `default_review_reasoning_effort` | `inherit` | 审查请求默认跟随执行强度，可单独指定。 |
| `default_timeout_sec` | 600 秒 | 包括进程启动、模型选择及任务执行的总时限；进度不会重置计时。 |
| `startup_timeout_sec` | 45 秒 | 控制面请求上限；模型发现流程也有这个总时限。 |
| `idle_warning_sec` | 180 秒 | 没有语义进度时提示 `slow`，不据此直接断言模型卡死。 |
| `cancel_grace_sec` | 15 秒 | 发送 `session/cancel` 后等待当前提示词收尾。 |
| `close_grace_sec` | 5 秒 | 会话关闭请求、随后进程退出各自的等待窗口。 |
| `kill_grace_sec` | 5 秒 | 强制停止专属进程后的确认窗口。 |
| `max_tool_calls` | 100 次 | 超过顶层 ACP 工具调用更新预算时取消；总时限也约束隐藏在工具内部的循环。 |
| `max_concurrent_tasks` | 3 | 不同目录中的活动任务数量上限。 |
| `max_log_bytes` | 32 MiB | 每任务事件日志配额；超限取消。 |

达到任务时限后先进入 `cancelling`，取消与清理仍需要上述有界窗口。任务最终为 `timed_out`、`cancelled`、`failed` 或 `completed`，附带 `cleanup.confirmed`。无法确认停止时标记为 `stop_unconfirmed`，继续占用工作目录。

每个任务的 DSH 根进程先以挂起状态创建，加入专属 Windows Job Object 后才开始执行。守护进程是该 Job 句柄的唯一所有者；强制关闭守护进程会回收整个 Job 中的进程，包括父进程已退出的后代。MCP 进程断开后，守护进程收到 stdin EOF，给 DSH 至多 3 秒退出窗口后回收 Job。现有 DSH 桌面窗口从不加入任务 Job，也不会按名称批量结束 DSH 进程。

同一目录及其祖先、后代目录中的活动任务串行执行。并行任务使用独立目录或 Git worktree。目录通过 `realpath` 规范化，检查覆盖正常的目录链接和路径大小写。

停止进程不能撤销已经写入的文件或已完成的外部操作。失败后继续已提交的任务，需要先检查部分输出和改动，再设置 `reviewed_partial_work: true`。没有自动重试或自动备用模型切换。

## 权限与会话

桥接任务默认以 DSH 的 `auto` 预设运行：`sandbox= danger-full-access`、`approval=ask`。工具调用由原生 `@deepseek-ai/dsh-experimental-auto-review` 审查，获准后以 Full access 执行；拒绝可以进入单次权限请求流程，审查失败不执行工具。没有保留工作区文件沙箱。项目内任务串行占用检查用于协调任务，不是文件权限隔离。

每个执行进程使用一次性的 `--patch` 加载项目中的 `dsh/auto-review.mjs`，不改写桌面 profile。适配层复用 DSH 自带的固定审查策略、判定解析器与执行前检查，只补充 ACP 外部父代理的任务授权来源、独立思考强度以及审查统计。父指令在子进程开始前由控制面捕获；不会把模型自身输出或工具返回值提升为授权。

发任务前必须核对原生 `auto`、`danger-full-access`、`ask` 均已生效。缺少插件、激活确认不匹配或思考强度不受支持会直接失败，不回退到未经审查的 Full access。运行中的工具检查同样核对 Auto 状态。原生审查器是实验功能，保留其覆盖边界：PTC 外层 transport 和 PTC 程序中的直接 Node 副作用不经过 inner-tool review，因此不是所有主机副作用的确定性隔离边界。

DSH 使用自己的执行权限、工具和 profile，Codex 沙箱不会自动成为 DSH 的沙箱。任务说明中的“只读”或工作范围属于模型指令。

DSH 真正提出权限请求时，任务进入 `waiting_permission`，状态返回请求和单次选项。主代理应只批准用户已授权范围内的操作，必要时向用户转交；桥接器不会自动批准全部请求。权限等待仍受总任务时限约束。

状态中的 `auto_review` 返回实际模式、已开始/完成/失败的审查次数，以及最近一次审查的供应商、模型、强度和决策。每轮 `runs/<nonce>/` 下另有 `auto-review.json` 与 `auto-review-events.jsonl`，不保存审查模型的思考或原始响应。若审查发生技术失败，即使执行模型最终返回了文字，本轮也会标记失败并保留部分输出。

每轮任务结束后都关闭 ACP 会话并结束专属进程。DSH 的持久化会话仍保留，`deepseek_send` 使用 `session/resume` 恢复。它不会接管已经在桌面窗口运行的会话。DSH 内部自行创建的后代模型策略由 DSH 管理；桥接器确认的是自己派发的根会话模型。

Auto 会话若由其他 DSH 前端恢复，该运行时也必须加载原生 Auto 集成。通过本桥接器的 `deepseek_send` 恢复时会自动加载并核验。

若整个 MCP 连接消失，桥接器会取消其任务。操作系统强制结束桥接器时，由 Windows 守护进程兜底回收。重新连接后可用 `deepseek_list_tasks` 查看记录，再通过 `deepseek_recover` 核验孤立任务。对未知、仍存活或可能复用的 PID，恢复逻辑保持保守，不结束任意外部进程。

## 真实验证

读取目录、不发送模型任务：

```powershell
node scripts/doctor.mjs
```

使用明确模型做一次只回验证标记的任务（会实际调用 DSH 模型）：

```powershell
node scripts/doctor.mjs --smoke --provider deepseek-official --model deepseek-flash
```

任务要求只回复 `DSH_BRIDGE_OK`，不调用工具或修改文件，并使用 90 秒任务时限。实际验证情况记录在 [VERIFICATION.md](VERIFICATION.md)。

仅核验真实 Auto 激活，不调用模型：`node scripts/check-auto.mjs`。

验证真实模型审查与 Full access 工具写入：`node scripts/check-auto-live.mjs`。使用已验证的 `deepseek-official / deepseek-flash`，执行强度 `low`、审查强度 `high`，只在 `.tmp` 新建的测试目录中创建一份明确授权的验证文件。

## 本地记录与维护

配置位于 `bridge.config.json`。可用 `dsh_install_dir` 指定另一安装目录；`executable` 与 `args` 用于测试或显式自定义运行时，均通过无 shell 的参数数组启动。`powershell` 可指定 PowerShell 7 的绝对路径。

`.bridge-data/bridge.sqlite` 保存任务与跨连接控制记录。每个任务在 `.bridge-data/tasks/<id>/` 下保留 `task.json`、`answer.txt`、`events.jsonl`、`stderr.log`（有对应输出时才生成）。日志可能含项目内容和工具输出，属于本地私有数据；不写入 Git，不自动上传。思考更新只记录活动长度，不保存思考文本。答案跨轮追加，读取偏移也是累计字符偏移。

守护进程只保障其 Windows Job 范围内的本地进程回收；它不能撤销远端请求的计费或已经完成的远端操作。当前测试针对 Windows；POSIX 的进程组停止代码不提供同等的桥接器崩溃回收保证。

卸载 MCP 注册：

```powershell
codex mcp remove deepseek_harness
```

这会删除连接配置，项目代码和任务记录仍保留。

## 协议参考

- [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- DSH ACP 的实现依据来自本机 0.2.1 安装包随附的 `@deepseek-ai/dsh-acp`、`dsh-acp-app` 中文说明及代码。
