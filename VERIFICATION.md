# 验证记录

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
