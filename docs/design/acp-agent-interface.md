# ACP Agent Interface — Design Proposal

## Status

**Proposal. Not implemented.** Tracking issue: [#15](https://github.com/automatons-lab/agent-orchestrator/issues/15).

The [open questions](#open-questions) at the end need decisions before implementation starts. Each one has a proposed default.

Facts about external tools were checked on 2026-10-12 against:

- `@agentclientprotocol/claude-agent-acp` 0.89.1
- `@agentclientprotocol/codex-acp` 2.2.2
- `@agentclientprotocol/sdk` 1.8.0
- Claude Code 2.1.295
- Codex CLI 0.161.0

---

## Problem

AO drives Claude Code and Codex by typing into their terminal UIs.

| Step         | How it works today                                                                                                                                                                                                                                                                                                                    | Where                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Launch       | runtime-tmux runs the agent CLI in `tmux new-session`. The task prompt is a positional argument and the system prompt is passed as `--append-system-prompt` or `developer_instructions`. `RuntimeCreateConfig` carries only a `launchCommand` string plus env.                                                                        | `packages/core/src/types.ts` (`RuntimeCreateConfig`), `packages/plugins/runtime-tmux/src/index.ts` (`create`)  |
| Follow-ups   | Every follow-up ends in `Runtime.sendMessage`: `ao send`, CI-failure and review-comment reactions, the dashboard message box. For tmux this means `C-u`, then `send-keys -l` or `paste-buffer`, a fixed 2 s wait, then `Enter`. 1.5 s later `capture-pane` looks for Codex's "tab to queue message" footer and answers it with `Tab`. | `runtime-tmux` `sendMessage`                                                                                   |
| Readiness    | Before the first send, AO waits for stable `capture-pane` output and for `pane_current_command` to equal `agent.processName`.                                                                                                                                                                                                         | `packages/core/src/session-manager.ts` (`waitForInteractiveReadiness`)                                         |
| Confirmation | `sendWithConfirmation` diffs 20 lines of pane output for up to 3 s. If nothing changes, the send is a **soft success**.                                                                                                                                                                                                               | `session-manager.ts` (`sendWithConfirmation`)                                                                  |
| Activity     | Claude: the transcript JSONL plus hooks that append to `.ao/activity.jsonl`. Codex: the rollout JSONL plus terminal regexes (`recordActivity`).                                                                                                                                                                                       | `agent-claude-code/src/activity-detection.ts`, `agent-codex/src/index.ts`, `packages/core/src/activity-log.ts` |
| Viewing      | The dashboard mux server runs `tmux attach-session` through node-pty. The terminal is read-write.                                                                                                                                                                                                                                     | `packages/web/server/mux-websocket.ts`                                                                         |

What this costs:

- **Delivery is timing-based.** A message can be lost, duplicated, or land in the wrong place, such as an approval menu or a queued draft. Confirmation by output diff cannot tell these cases apart.
- **Every agent CLI UI change can break it.** The `Tab` workaround was written for codex-cli 0.154.0.
- **There are no turn boundaries and no queue.** A message typed mid-turn becomes an interruption or a queued draft, depending on the agent and its version.
- **Permission prompts are visible only as screen text or hook events.**

## Goals

- Deliver prompts with an explicit acknowledgement and explicit turn boundaries.
- Derive activity from protocol events instead of screen text.
- Keep one tmux pane per session that the dashboard shows and that survives AO restarts.
- Make ACP opt-in per agent profile and leave TUI sessions unchanged.
- Keep resume on the agent's native conversation id, as `claude --resume` and `codex resume` do today.

## Non-goals (for this proposal)

- A chat view in the dashboard. It can be built later on the same events; see [option D](#d-chat-view-in-the-dashboard).
- Replacing tmux.
- Changing the headless reviewer (`executeNativeReview`). It already runs non-interactively.
- Running the native TUI and ACP on the same conversation at the same time. See [Live view options](#live-view-options).

---

## Background

### Agent Client Protocol

[ACP](https://agentclientprotocol.com) is JSON-RPC 2.0 over stdio. The client spawns the agent process.

- **Client → agent:** `initialize`, `session/new` (`cwd`, `mcpServers`, `_meta`), `session/load`, `session/resume`, `session/prompt` and `session/cancel`. `session/prompt` resolves with a `stopReason` when the turn ends.
- **Agent → client:**
  - the `session/update` notification, carrying message and thought chunks, `tool_call` and `tool_call_update` with diffs, `plan`, mode and usage updates;
  - the `session/request_permission` request.
- **Optional client capabilities:** `fs/*` and `terminal/*`. AO would not advertise them, so the agent keeps using its own file and shell tools.

The TypeScript SDK is `@agentclientprotocol/sdk`.

### Adapters

| Agent       | Surface                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `@agentclientprotocol/claude-agent-acp`                                   | Formerly `@zed-industries/claude-code-acp`, built on the Claude Agent SDK. Requires Node ≥ 22; AO's own engine floor is 20.18.3. See the facts below the table.                                                                                                                                                                                                                      |
| Codex       | `codex app-server` (native JSON-RPC), or `@agentclientprotocol/codex-acp` | app-server provides `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt` and approval requests, and codex-acp wraps it. agent-codex already ships an unused client for it, `CodexAppServerClient` (`packages/plugins/agent-codex/src/app-server-client.ts`). Codex 0.161 can also run a shared app-server daemon and attach its TUI to it with `codex --remote unix://…`. |
| OpenCode    | `opencode acp`                                                            | Native.                                                                                                                                                                                                                                                                                                                                                                              |
| Gemini CLI  | `gemini --acp`                                                            | Native.                                                                                                                                                                                                                                                                                                                                                                              |

Facts about the Claude adapter, read in its code:

- `CLAUDE_CODE_EXECUTABLE` points it at the installed `claude`.
- It supports `loadSession` and `resumeSession`.
- `session/new` accepts `_meta.systemPrompt`. An object form forwards preset options, including `append`. That replaces `--append-system-prompt`.
- Claude Code's permission modes are exposed as session modes: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` and `auto`. `bypassPermissions` is refused when running as root unless `IS_SANDBOX` is set.
- It loads settings from `user`, `project` and `local` sources.
- It releases almost daily.

Claude sessions opened over ACP are ordinary Claude Code sessions with a transcript under `~/.claude/projects`. The same UUID therefore works for `claude --resume <uuid>` and ACP `session/load`. Orchestrator.inc relies on this; we confirm it in the spike.

---

## Prior art

### Orchestrator.inc (the Go rewrite of our former upstream)

Our fork is detached from it, so this is read as a reference only. Its code is Apache-2.0. This proposal reuses ideas, not code. Any code copied later must keep that license's notice.

- **Chat or TUI, never both.** Each worker runs in exactly one of two interfaces: Chat (ACP) or the native TUI.
- **Switching is a durable sequence.** Block new input, then drain or interrupt, stop the source, commit the new mode atomically, and start the target through native resume:
  - Claude: `claude --resume <uuid>`, or ACP `session/load`;
  - Codex: `codex resume <thread>`, or `thread/resume`.

  A failed switch rolls back. Messages that arrive mid-switch go to an outbox.

- **ACP runs in a detached host.** Each session has its own host process, started with `setsid`, and the daemon attaches to it over authenticated loopback TCP. The host:
  - buffers output while no daemon is attached;
  - journals in-flight prompts;
  - keeps pending permission requests;
  - requires an acknowledgement of each prompt result before accepting the next prompt.
- **Codex is driven through `codex app-server`, not codex-acp.**
- **Chat activity comes from typed events.** A started turn means active; a requested approval means waiting for input; a completed turn means idle.
- **Its documented pitfalls are listed under [Risks](#risks-and-known-pitfalls).**

### OpenHands Agent Canvas

A web control centre that runs OpenHands' own agent, or any ACP agent (Claude Code, Codex, Gemini, OpenCode), on local, Docker, VM or cloud backends. The UI renders the event stream; there is no terminal view of the agent. It isolates work by running each conversation in its own Docker container.

---

## Proposed design

### Overview

```
tmux session <tmuxName>              unchanged runtime-tmux; the dashboard attaches to it
└── ao acp-host --session <sid>      new: owns the adapter, renders the pane, serves AO
      ├── stdio JSON-RPC ──> claude-agent-acp ──> claude   (CLAUDE_CODE_EXECUTABLE)
      ├── stdout ──────────> the pane: messages, tool calls, permission requests
      ├── appends ─────────> <workspace>/.ao/activity.jsonl   (source: "acp")
      └── unix socket <───── AO: prompt / ack / status / cancel / shutdown
```

tmux keeps doing two jobs: it keeps the host and the agent alive when AO restarts, and it is the window the dashboard already knows how to show. The detached host and descriptor files Orchestrator.inc needed are replaced by the tmux session we already have.

### `ao acp-host`

This is a new CLI subcommand in `packages/cli`: a long-lived Node process started as the pane's command. It does the following.

1. **Starts the agent.** It spawns the adapter with stdio pipes and calls `initialize` without the `fs` or `terminal` capabilities.
2. **Opens the conversation.**
   - On spawn: `session/new` with `cwd` set to the workspace and `_meta.systemPrompt = { append: <worker prompt file contents> }`. It sets the session mode from the role's `permissions`, then sends the task prompt as the first `session/prompt`.
   - On restore: `session/load <id>`.

   Prompts are passed by file path, never inline in the shell command.

3. **Persists the conversation id** to the session metadata. For Claude this is `claudeSessionUuid`, the same field `getRestoreCommand` uses.
4. **Serves AO** on a unix socket next to the session metadata file, with mode `0600` and no TCP. The protocol is below.
5. **Renders events into the pane**, with streaming text, collapsed tool calls and file-level diff summaries:

   ```
   ── turn 3 · prompt from ao (ci-failed) ─────────────────────────
   > CI failed on 4f2c1e0: test/unit/session.test.ts …
   ● Read  packages/core/src/session-manager.ts
   ● Bash  pnpm --filter @aoagents/ao-core test session  ✓ 0:41
   ● Edit  packages/core/src/session-manager.ts  (+12 −3)
   The flaky assertion depended on …
   ── turn 3 ended: end_turn · 2m10s ───────────────────────────────
   ```

6. **Writes activity entries.** See [Activity and liveness](#activity-and-liveness).
7. **Handles permission requests.** See [Permissions](#permissions).
8. **Exits on `shutdown`, or when the adapter dies.** runtime-tmux's keep-alive shell keeps the pane, so the last output stays visible, as it does today.

#### Host socket protocol (sketch)

Messages are newline-delimited JSON, one request per line.

| Request (AO → host)                                             | Response                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"op":"prompt","id":"<uuid>","text":"…","origin":"ci-failed"}` | `{"op":"ack","id":"…","state":"accepted"\|"sent"\|"done"\|"interrupted","duplicate":false,"position":0}`                                    |
| `{"op":"delivery","id":"<uuid>"}`                               | `{"op":"delivery","id":"…","state":"unknown"\|"accepted"\|"sent"\|"done"\|"interrupted"}`                                                   |
| `{"op":"status"}`                                               | `{"op":"status","state":"starting\|active\|waiting_input\|ready\|blocked\|exited","conversationId":"…","queue":0,"pendingPermission":null}` |
| `{"op":"cancel"}`                                               | `{"op":"ok"}`, after `session/cancel`                                                                                                       |
| `{"op":"permission","requestId":"…","optionId":"…"}`            | `{"op":"ok"}`                                                                                                                               |
| `{"op":"shutdown"}`                                             | `{"op":"ok"}`, then the host exits                                                                                                          |

- Prompts are queued and sent one turn at a time. A prompt that arrives mid-turn waits for the turn to end; see [question 7](#open-questions).
- The host can later add a `subscribe` op that streams events for a dashboard chat view ([option D](#d-chat-view-in-the-dashboard)).

#### Delivery ledger and deduplication

A prompt's `id` is one **logical delivery id**. AO creates it once per message and reuses it for every retry ([Message delivery](#message-delivery)). The host keeps a durable record of every id it has accepted, so even a replacement host never runs the same prompt twice.

- **The ledger** is an append-only file, `<sid>.acp-deliveries.jsonl`, next to the session metadata and the socket. It lives as long as the session and is removed with it. Each id moves through these states, and each state is appended and flushed (`fsync`) before the step that depends on it:

  | State         | Written when                                                                                                                                                        |
  | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `accepted`    | Before the host replies `ack`. A prompt the host has acknowledged is therefore always on disk.                                                                      |
  | `sent`        | Before the host calls `session/prompt` with it.                                                                                                                     |
  | `done`        | When `session/prompt` resolves, with its `stopReason`.                                                                                                              |
  | `interrupted` | When a host starts and finds `sent` without `done`: the previous host or agent died mid-turn. The agent may already have acted on the prompt, so it is not re-sent. |

- **A `prompt` with an id already in the ledger** is answered with that id's current state and `"duplicate": true`. Nothing is delivered again.
- **On start**, including a restore with `--load`, the host reads the ledger before it opens the socket:
  - ids that are `accepted` but not `sent` are queued again, in their original order, and delivered once;
  - ids that are `sent` but not `done` are marked `interrupted`, printed in the pane and left to [question 9](#open-questions).
- **The guarantee:** an id is accepted at most once and sent to the agent at most once. A prompt the host acknowledged is never lost by a host restart before it is sent.

### Agent plugins

- **A new agent profile key: `interface: tui | acp`.** The default is `tui`. It flows into `agentConfig` like `model` and `reasoningEffort`. The schemas pass unknown keys through already, but the key gets explicit validation and documentation.

  ```yaml
  agents:
    claude-acp:
      plugin: claude-code
      model: opus
      interface: acp
  ```

- **agent-claude-code with `interface: acp`:**
  - `getLaunchCommand` returns `ao acp-host --session <sid> --agent claude-code --prompt-file … --system-prompt-file …`.
  - `getRestoreCommand` returns the same command with `--load <claudeSessionUuid>`.
  - `processName` and `isProcessRunning` recognise the host. Today they look for `claude` among the pane's processes.
- **Identity env is unchanged.** `GH_TOKEN` and the git author and committer variables still flow through tmux `-e` into the host, the adapter and `claude`.
- **The adapter is pinned to an exact version** as a dependency of agent-claude-code and run with AO's Node. This raises the Node floor to 22 for ACP sessions only; the host checks it at start. See [question 6](#open-questions).

### Message delivery

- **A new optional agent method, `Agent.deliverMessage?(session, message)`.** When an agent implements it, `SessionManager.send` uses it instead of `Runtime.sendMessage`, readiness waiting and `sendWithConfirmation`.
  - This keeps `SessionManager` agent-agnostic.
  - The Codex app-server path can use the same hook.
- **For ACP sessions**, `SessionManager.send` creates the delivery id once, before the first attempt. Every retry of that message reuses it ([Delivery ledger and deduplication](#delivery-ledger-and-deduplication)). Delivery connects to the socket, sends `prompt` and waits for `ack` with a 10 s timeout. There are three outcomes:

  | Outcome                                                                                    | What AO does                                                                                                                                                                                                                                                                                                                                                                     |
  | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | An `ack` arrives, including a duplicate ack                                                | Delivered.                                                                                                                                                                                                                                                                                                                                                                       |
  | No connection: the socket is missing or refuses it, so the request was never written       | Not delivered. Restore the host if it is dead, then send again with **the same id**.                                                                                                                                                                                                                                                                                             |
  | Ambiguous: the request was written, then the connection dropped or the ack timeout expired | **No blind resend.** Reconnect (restoring the host if it is dead, since a new host reads the same ledger) and ask `delivery` for the id. Any state other than `unknown` means delivered. `unknown` means the host never recorded the prompt, so AO sends it again with the same id. If the host cannot be reached, the send fails with "delivery unknown" and nothing is resent. |
  - No ack is never a soft success.
  - The existing "forced restore, then one resend" retry in `SessionManager.send` does not apply to ACP sessions; this procedure replaces it.

- **Readiness** is the host reporting a state other than `starting`.
- **`ao send` must not use the raw tmux fallback for ACP sessions.** It goes through `sessionManager.send`, or refuses, following the same pattern as the review-only guard in `packages/cli/src/commands/send.ts`.

### Activity and liveness

The host appends entries with `source: "acp"`. `checkActivityLogState` already turns `waiting_input` and `blocked` entries into session state.

| ACP event                                                      | Activity entry                                           |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| A `session/prompt` is sent (the turn starts)                   | `active`                                                 |
| A `session/update` arrives during a turn (throttled)           | `active`                                                 |
| A `session/request_permission` is pending                      | `waiting_input`                                          |
| A prompt resolves with `end_turn`, `max_tokens` or `cancelled` | `ready`                                                  |
| The adapter fails to start, reports an auth error, or exits    | `blocked` (the host exits, then liveness reports exited) |

- **Claude's transcript reader keeps working.** The transcript is the same file, so it stays a second source.
- **The workspace hooks should keep firing,** because the adapter loads `project` settings. Whether they do is checked in the spike. ACP sessions do not depend on them.

### Permissions

1. **The session mode follows the role's `permissions`:**
   - `permissionless` → `bypassPermissions`;
   - `auto-edit` → `acceptEdits`;
   - `default` and `suggest` → `default`.

   Under `bypassPermissions`, permission requests should be rare.

2. **A request that still arrives** is resolved according to [question 3](#open-questions). The proposed default: the session shows `needs_input`, the request is printed in the pane, and `ao permission <session> allow|deny` answers it. A dashboard action can follow.
3. **The `bypassPermissions` root restriction:** the adapter silently falls back to `default` when it runs as root without `IS_SANDBOX`. The host checks the effective uid and reports a clear error instead.

### Lifecycle

| Event                      | Behaviour                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn                      | `runtime.create` with the host command, otherwise unchanged. The host reports `starting` until the first `session/prompt` is accepted.                                                                                                                      |
| AO restarts                | tmux keeps the host and the agent running. AO reconnects to the socket at the path in the session metadata. A turn in flight continues and keeps writing to the pane and the activity log. The MVP keeps no chat history in AO, so nothing needs replaying. |
| `ao stop`, then `ao start` | `ao stop` kills the tmux session; the host gets `SIGHUP`, sends `session/cancel` and exits. `ao start` restores the session, the host comes back with `--load <id>`, and it replays the delivery ledger before accepting new prompts.                       |
| The agent crashes          | The host prints the error in the pane and records `blocked`, and liveness reports exited. Restore follows the same path as above: queued prompts are delivered once, and a prompt that was mid-turn is marked `interrupted`.                                |
| `ao session kill`          | As today: `runtime.destroy`.                                                                                                                                                                                                                                |

### What does not change

- runtime-tmux, the mux server and the dashboard terminal;
- the workspace plugins and identities;
- the reviewer;
- the lifecycle state machine;
- every session without `interface: acp`.

---

## Live view options

### A. Event stream in the pane (proposed for the MVP)

The host renders the conversation into the tmux pane.

- **For:**
  - no dashboard change;
  - the host survives AO restarts through tmux;
  - one implementation serves every ACP agent.
- **Against:**
  - the pane shows our rendering, not the agent's native UI;
  - keystrokes in the pane need a decision ([question 2](#open-questions)).

### B. Switch to the native TUI (take-over)

This is the Orchestrator.inc model, added on top of A. A "take over" action:

1. drains or cancels the current turn;
2. shuts the host down;
3. runs `claude --resume <uuid>` in the same tmux session.

"Hand back" reverses it with `session/load`.

It requires:

- never running two writers on one conversation;
- a check that the transcript exists before resuming;
- an outbox for messages that arrive during the switch.

### C. Codex native TUI on a shared app-server

AO drives the Codex thread through a shared app-server daemon, while the pane runs `codex --remote unix://<socket> resume <thread>`. That would show the native TUI and keep programmatic control **at the same time**.

This depends on an experimental Codex feature and is unverified: we don't yet know whether the TUI renders turns that another client started. It is a spike, not a plan.

### D. Chat view in the dashboard

The dashboard renders messages, tool calls, diffs, plans and permission cards from the host's event stream through a `subscribe` op. This is a later phase on top of A.

---

## Codex

Proposed: the host gets a `--agent codex` mode that uses `CodexAppServerClient` over `codex app-server` instead of the `codex-acp` adapter.

- **It removes a third-party layer.** codex-acp wraps app-server anyway.
- **The thread id is already persisted** as `codexThreadId`, and `codex resume <thread>` keeps working for take-over.
- **It matches Orchestrator.inc's choice.**
- **Developer instructions are passed when the thread starts.**
- **One known pitfall:** `codex resume` in a terminal forks the thread under a new id, so the id has to be followed after a take-over.

---

## Risks and known pitfalls

- **Adapter churn.** claude-agent-acp is still 0.x and releases almost daily. Pin an exact version, upgrade deliberately, and keep contract tests against a fake ACP agent.
- **Empty conversations.** Claude writes no transcript until the first prompt, so `session/load` or `--resume` on a reserved id fails with "No conversation found" (-32002).
  - Check that the transcript exists before loading.
  - Start a fresh session only with proof that the conversation never started.
- **Long `session/load` replays** have overflowed SDK notification queues. The host must consume a replay without blocking and should not render all of it.
- **`session/load` can fail with -32603.** Back off and classify the error instead of starting a new conversation.
- **Codex resume forks threads.** See [Codex](#codex).
- **Double writers.** Never run `claude --resume <uuid>` while a host holds the same conversation. This matters for option B and for manual debugging.
- **Ambiguous delivery.** A lost ack must never turn into a second delivery. One delivery id per message, the durable ledger, and a `delivery` lookup before any resend ensure this ([Delivery ledger and deduplication](#delivery-ledger-and-deduplication)). The cost is that a prompt interrupted mid-turn by a crash is not repeated automatically ([question 9](#open-questions)).
- **Process-tree assumptions.** `isProcessRunning` and readiness look for the agent binary in the pane. ACP sessions need their own checks.
- **Node floor.** The adapter needs Node ≥ 22, while AO supports ≥ 20.18.3.
- **Socket exposure.** The socket lives in the user-owned data directory with mode `0600`; no TCP listener.

## Rollout

0. **Spike.** Validate:
   - claude-agent-acp running against the installed `claude`;
   - `_meta.systemPrompt.append`;
   - session modes;
   - `session/load` after killing the host;
   - whether workspace hooks fire;
   - whether the conversation file matches `claude --resume`;
   - Codex `--remote` (option C).
1. **MVP for Claude Code:** the host in tmux, socket delivery, activity entries, restore. Acceptance criteria are in #15.
2. **Codex through app-server.**
3. **Take-over** (option B).
4. **Dashboard chat view** (option D), if wanted.

Each phase updates `docs/ARCHITECTURE.md`, `AGENTS.md` and `agent-orchestrator.yaml.example` in the same PR as its code.

## Open questions

| #   | Question                                                                                        | Proposed default                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Live view: a rendered event stream instead of the native TUI, switch-only, or Codex `--remote`? | A for the MVP, B as phase 3, C as a spike.                                                                                                                              |
| 2   | Keystrokes typed into the pane: ignored, or sent as prompts?                                    | Read-only for the MVP: the host ignores stdin and its banner points to `ao send` and the dashboard message box. One input path keeps queueing and deduplication simple. |
| 3   | Permission requests that still arrive: auto-resolve or ask a human?                             | Ask: the session shows `needs_input` and `ao permission` answers it. `permissionless` roles rarely see one under `bypassPermissions`.                                   |
| 4   | Codex transport: app-server or codex-acp?                                                       | app-server, through `CodexAppServerClient`.                                                                                                                             |
| 5   | Scope: workers only, or the orchestrator too?                                                   | Workers only. The orchestrator is the session humans type into, so it stays a TUI. The reviewer stays headless.                                                         |
| 6   | Adapter distribution: an AO dependency or a user install?                                       | A pinned AO dependency, run with AO's Node, with `CLAUDE_CODE_EXECUTABLE` pointing at the user's `claude`.                                                              |
| 7   | Messages that arrive mid-turn: queue or interrupt?                                              | Queue until the turn ends. Add an explicit `--interrupt` later if needed.                                                                                               |
| 8   | Take-over in the MVP?                                                                           | No; phase 3.                                                                                                                                                            |
| 9   | A prompt left `interrupted` by a host or agent crash mid-turn: resend it, or ask a human?       | Ask. The agent may already have acted on it. The pane and `ao session ls` show the interrupted prompt, and resending it is an explicit action.                          |

## References

- **Today's delivery path:**
  - `packages/core/src/session-manager.ts`: `send`, `sendWithConfirmation`, `waitForInteractiveReadiness`;
  - `packages/plugins/runtime-tmux/src/index.ts`: `sendMessage`;
  - `packages/cli/src/commands/send.ts`.
- **Activity:** `packages/core/src/activity-log.ts` (`checkActivityLogState`) and `packages/plugins/agent-claude-code/src/activity-detection.ts`.
- **Dashboard terminal:** `packages/web/server/mux-websocket.ts`.
- **Restore:** `getRestoreCommand` in agent-claude-code and agent-codex; `claudeSessionUuid` and `codexThreadId` in `packages/core/src/types.ts`.
- **Codex client:** `packages/plugins/agent-codex/src/app-server-client.ts`.
- **ACP:** <https://agentclientprotocol.com>, `@agentclientprotocol/sdk`, `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`.
- **Orchestrator.inc** (Apache-2.0): ADR "persistent chat provider host" and the research notes on persistent ACP chat hosts and interface handoff, in its `docs/`.
- **OpenHands Agent Canvas:** <https://github.com/OpenHands/OpenHands>.
