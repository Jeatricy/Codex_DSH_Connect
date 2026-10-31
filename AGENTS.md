# Codex DSH bridge

This project exposes external DeepSeek Harness agents through a local MCP server.
Use Node.js 22 or later. It has no third-party dependencies. Run `node --run test`.

For user requests to delegate to DSH:

- Use the `deepseek_harness` MCP tools. Discover the actual model selectors before choosing a model.
- Specify task scope, acceptance criteria and an explicit model. Model selection must be confirmed before prompt submission.
- The configured bridge uses DSH native Auto review with Full access. Verify the returned auto_review activation. Set reasoning_effort for execution and review_reasoning_effort for the reviewer; the latter defaults to inherit.
- Spawn returns a task ID. With the installed and trusted completion Stop hook, pass completion with the explicit current parent CODEX_THREAD_ID and a short parent-authored follow_up, then finish the dispatch turn instead of polling. On continuation read the result once and review/test actual changes. Never guess another chat ID or place child output in follow_up. Without a trusted hook, use bounded wait/status.
- Forward real permission requests and make only decisions already authorized by the user. Instructions do not create a DSH filesystem sandbox.
- Validate returned claims and file changes. Completion means ACP returned an answer, not that the work passed tests.
- Confirm worker cleanup before retrying or changing models after failure. Review partial changes first.
- Use separate workspaces/worktrees for parallel tasks; overlapping directories are serialized.
- Do not silently retry or substitute a model. Never target the user's already-running DSH GUI for termination.

These instructions concern external DSH sessions, not spawning native Codex subagents for development of this project.
