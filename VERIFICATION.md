# 验证记录

## 0.3.0：本地等待与主聊天接续 / 2026-10-31

范围：`spawn` / `send` 新增可选 `completion`，按明确父聊天 UUID 登记后续工作；同步 Stop hook 等待本地 SQLite 任务状态，原子回执去重；提供保留其他 hook 的安装、备份及卸载工具。

代码审查状态：**已经过代码审查**。主代理直接自审新增源码、工具参数及任务生命周期，检查目标校验、每轮继承/替换/关闭、并发回执、进程清理后的终态通知、权限等待、桥接断线、等待上限、错误回路及 Windows 路径/UTF-8 处理。通知只取固定元数据与父代理说明，不将子模型输出、错误原文或 MCP 凭据提升为后续指令。未做独立复核。

隔离副本执行 `node --test --test-concurrency=1 test/bridge.test.mjs test/completion.test.mjs test/native-auto.test.mjs`：**38/38 通过**，0 失败/跳过，约 60.7 秒。新增 11 项覆盖独立 hook 子进程、并发去重、全部终态、进度期间静默、清理后交付、权限请求、每轮继承/替换/关闭、跨聊天隔离、断线/等待上限、真实 ACP 取消清理、安装器保留/备份/幂等/卸载、特殊路径和 UTF-8、故障不重复接续。既有 MCP 挂载与真实 DSH 原生 Auto 审批回归均通过；模型端点为本地确定性服务，无付费供应商请求。

正式仓库最终回归：**40/40 通过**，0 失败/跳过，约 62.7 秒。在上述基础上增加公开 MCP stdio 派发到独立完成 hook 的端到端测试，以及 Windows 目标文件短暂锁定/持续锁定的确定性回归。正式仓库首次回归暴露既有审查快照 `rename` 的偶发 `EPERM`：失败事件已写入，快照却留在 reviewing。已为原子替换增加至多 200 ms 的暂态重试，并让未收齐审查结果的任务不能被标为 completed；未更改原生审批策略或放宽测试断言。上述修复已经过代码审查，由主代理检查了重试范围、边界与完成状态保护。

首次受限沙箱回归中，既有原生 DSH 测试因无法写入用户 ACP profile 而失败（`EPERM ... cordis.yml`）；用户上下文重跑后全部通过。未以跳过测试或改弱断言处理该环境限制。

当前验收状态：本地等待、DSH 生命周期、Stop JSON 输出和当前桌面聊天的原生自动接续均已验证。用户完成 hook 信任后，原生 `hooks/list` 返回 `trustStatus=trusted`、`enabled=true`，errors / warnings 均为空。安装器未改写信任记录。CLI 队列未用于生产实现。

已在本机合并安装用户级 hook，原有 PostToolUse / SessionStart 保留并备份；原生 hooks 功能开关为启用。队列方案验收时创建的唯一测试消息已按确切消息 ID 清除，未保留在当前聊天队列。

真实桌面端到端测试任务：`7e238fa4-72b3-48f4-a289-0ce5bfbbba63`，桥接器 0.3.0，模型 `deepseek-official / deepseek-flash`，执行强度 `low`、审查强度 `inherit`。当前聊天仍缓存旧版工具 schema，因此通过已注册桥接器的新 stdio 连接，以公开 `tools/call` 传入 `completion` 并明确指向当前父聊天；未手工写入通知任务或回执。

主代理结束派发回合后，真实原生 hook `stop:2` 自动向同一聊天提交 completed 通知并接续模型，无需用户另发消息；随后主代理只读取一次最终状态。最终答案精确为 `DSH_NATIVE_STOP_HOOK_OK_20261031`，`state=completed`、`cleanup.confirmed=true`、`forced=false`、worker exit code 0；本地独立脚本读取到该轮原生回执后退出，MCP 连接正常关闭。Auto review 已激活；本次不调用工具，因此审查计数为 0，不将其表述为一次工具审批测试。真实桌面成功分支验收通过；其他异常分支以此前自动化回归为依据。

本次仅发送一次真实模型短请求，不读取或修改 Unity 文件，没有模型侧状态轮询。测试完成后核对 Unity 与桥接器工作区状态，临时测试脚本清理，正式任务记录保留。当前聊天常规工具调用仍需刷新 MCP schema 才能直接使用新增参数。

交付语义是本地至多一次通知，非跨崩溃可靠消息服务；记账后、stdout 交付前异常可能丢通知，可手动查询。关闭应用或 MCP 连接不会由本功能重新启动应用。

## 会话 MCP 配置传入 / 2026-10-31

范围：`deepseek_spawn` / `deepseek_send` 新增 `mcp_servers`，支持 HTTP/stdio 校验、ACP 挂载、本地持久恢复、继续时继承/替换/移除及旧任务兼容；工具状态仅返回连接摘要。

代码审查状态：**已经过代码审查**。本次由主代理直接自审当前差异及相关调用链，覆盖工具 schema、HTTP/stdio 规范化、启动前拒绝、任务持久化和恢复继承/覆盖/清空、旧记录兼容、连接摘要与现有审批/清理边界，未发现阻断问题；未做独立复核。关系图在该仓库为空，审查以实际源码和测试为准，未把图谱结果或自动化测试当作代码审查。

隔离副本已运行完整 `node --run test`，**27/27 通过**，0 失败/跳过，约 57.4 秒。新增测试覆盖配置拒绝、真实独立 ACP 进程传参、跨桥接连接恢复、调用方对象变更隔离、凭据摘要及公开 MCP stdio 入口；既有原生 Auto review 和进程回收回归一并通过。HTTP 与 stdio 的 ACP 传参均已验证；真实服务端端到端使用下述 Unity HTTP 服务。

正式仓库于 2026-10-31 再次执行完整 `node --run test`：27/27 通过，0 失败/跳过，约 55.8 秒。原生 Harness/审批测试使用本机确定性模型端点；本次未派发新的付费供应商任务。此次新生成的 7 个 .tmp 测试目录已清理，既有任务持久记录保留。

写回正式仓库后，从新的 `server.mjs` stdio 进程通过公开 MCP `tools/list` / `tools/call` 验证新参数，无 worker 注入或私自绕过工具参数：

- `deepseek_spawn(mcp_servers=[{type:"http",name:"UnityMCP",url:"http://127.0.0.1:8080/mcp"}])`：真实 `deepseek-official / deepseek-v4-flash` 执行 3 次原生调用，包含 `mcp__UnityMCP__manage_editor(action="telemetry_status")` 和实例/项目信息资源读取。
- `deepseek_send` 省略 `mcp_servers`：同一 DSH 会话恢复，继承连接配置，执行 2 次原生调用，再次读到项目根目录 `E:/Unity Project/AnonPrismPiano`、Unity `6000.3.15f1`、平台 `StandaloneWindows64`。新建和恢复均保持 Auto review，审查失败数为 0，进程正常回收。
- 故障连接 `http://127.0.0.1:1/mcp`：任务为 `failed`，`prompt_submitted=false`、工具调用 0 次、`cleanup.confirmed=true`，未回退到 Shell/CLI。

真实通过任务 ID：`8c4ab9d9-81e8-4e2e-8a3f-d5b17985cb7d`；故障测试任务 ID：`b71d4bb2-cd1f-4e0a-b868-765f2be08f69`。测试期间没有修改 Unity 项目资源或长期 MCP 配置。当前客户端需重新载入桥接器或新建聊天以刷新缓存的工具参数定义；这不影响上述新进程公开接口验证结果。

验证日期：2026-10-30（Asia/Shanghai）。环境为 Windows、Node.js 24.22.1、DeepSeek Harness 0.2.1（包版本 0.2.1-rc.5）。

## 0.2.0：Full access + 原生 Auto review

默认启用 DSH 原生 Auto review。真实会话状态为：

```text
permission/preset = auto
sandbox/mode      = danger-full-access
approval/policy   = ask
```

审查请求使用被审查代理当前的供应商和模型。执行 `reasoning_effort` 与审查 `review_reasoning_effort` 独立控制，默认分别为 `high` 与 `inherit`。

## 自动化测试

运行：

```powershell
node --run test
```

测试集共 25 项。发布前全量运行 **25/25 通过**，约 85.8 秒，包含以下验证：

- 拆分 UTF-8 JSON-RPC 帧及连接断开时的挂起请求释放。
- 精确模型选择、歧义名称与不存在的模型拒绝。
- 不支持推理控制的模型采用 `model-default`，不支持的显式强度报错。
- 异步派发、分段读取、持久会话继续及明确更换模型。
- 静默任务的后台总超时、工具循环预算和日志配额。
- 实际权限请求、一次性授权、权限等待时取消。
- 跨 MCP 连接的重叠目录占用和取消命令。
- 取消或关闭失效时回收专属进程树，同时保留无关进程。
- 根进程提前退出、桥接器被强制结束时回收后代。
- 停止未确认时保留目录占用，恢复时核验守护进程。
- MCP 初始化、11 个工具的发现及工具错误格式。
- 缺少原生 Auto 激活确认时不提交模型任务。
- 原生审查允许后创建指定的工作区外测试文件。
- 原始模型请求中执行强度 `low`、审查强度 `high` 分别生效。
- 原生审查拒绝后进入单次权限请求；拒绝授权后不执行动作。
- 原生审查输出错误时不执行文件操作并记录任务失败。
- 原生审查卡住时触发任务总超时和进程回收。
- 不支持的审查强度在模型任务提交前失败。
- `inherit` 跟随执行强度，恢复 Auto 会话后沿用本轮新强度。

其中原生 Auto 测试使用真实打包 DSH、原生审查策略和解析器、真实文件工具，以及本机确定性模型端点，不消耗模型供应商额度。测试生成的文件和本地任务记录均被 Git 忽略。

## 真实模型端到端验证

另外执行了不属于上述自动化测试的真实模型检查：

1. ACP 初始化、读取供应商及模型目录、创建并关闭会话。
2. 明确选择供应商与模型，返回指定验证标记；确认任务进程正常退出。
3. 从 Codex 注册的 MCP 配置启动服务器，发现全部 11 个工具，并恢复同一 DSH 会话。
4. 明确设置执行强度 `low`、审查强度 `high`，使用 `deepseek-official / deepseek-flash` 进行一次新文件写入。

第 4 项仅授权在新建测试目录内创建指定文件，该文件位于任务分配的工作区之外。原生审查实际调用模型并允许 `write`，记录结果为：

```text
reviews_started   = 1
reviews_completed = 1
reviews_failed    = 0
decision          = allow
cleanup.confirmed = true
process exit code = 0
```

该任务约 11 秒完成，无人工放行。文件内容及最终答案均匹配预设验证标记。从已注册 MCP 入口读取任务状态时，也确认了版本 0.2.0、两个思考强度参数和真实审查记录。

这些检查验证通信、模型选择、原生审查与清理链路。实际编程任务的结论、文件改动与测试证据仍由主代理核验。模型目录可见不代表凭据、额度和推理接口均可用。

原生 Auto 的覆盖范围仍以 DSH 实现为准；适配层没有改写其固定审查策略，不声称 PTC 程序中所有直接 Node 副作用都经过 inner-tool review。具体边界见 [README.md](README.md)。
