# AO CLI Reference

The `ao` CLI is the control interface for Agent Orchestrator. Most commands are used by the **orchestrator agent itself** to manage sessions, not by humans directly. Humans typically only need `ao start` and the web dashboard.

## Commands humans use

```bash
ao start                               # Auto-detect, generate config, start dashboard + orchestrator
ao start <url>                         # Clone repo, auto-configure, and start
ao start ~/other-repo                  # Add a new project and start
ao stop                                # Stop everything (dashboard, orchestrator, lifecycle worker)
ao status                              # Overview of all sessions
ao status --watch                      # Live-updating terminal status view
ao dashboard                           # Open web dashboard in browser
ao setup dashboard                     # Configure dashboard notification retention/routing
ao setup desktop                       # Install/configure native macOS desktop notifications
ao notify test --to desktop            # Send a manual notifier test without starting AO
ao completion zsh                      # Print the zsh completion script
```

## Commands the orchestrator agent uses

These are primarily invoked by the orchestrator agent running inside a runtime session (a tmux window on macOS/Linux; a ConPTY pty-host on Windows). You can use them manually if needed, but the orchestrator handles this automatically.

```bash
ao spawn [issue]                       # Spawn an agent (project auto-detected from cwd)
ao spawn 123 --agent codex             # Override agent for this session
ao batch-spawn 101 102 103             # Spawn agents for multiple issues at once
ao send <session> "Fix the tests"      # Send instructions to a running agent
ao session ls                          # List active sessions (terminated hidden)
ao session ls --include-terminated     # Include killed/done/merged/errored/cleanup sessions
ao session ls --json                   # Machine-readable session inventory (see note below)
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
```

> **JSON output:** `ao session ls --json` and `ao status --json` emit
> `{ "data": [...], "meta": { "hiddenTerminatedCount": N } }`. Terminated sessions
> (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) are filtered from
> `data` by default; `meta.hiddenTerminatedCount` reports how many were dropped.
> Pass `--include-terminated` to include them and reset the count to `0`.

## Review an existing PR

```bash
ao review 123                          # Auto-detect project; track an existing PR
ao review https://github.com/acme/app/pull/123 --project my-app
ao review 123 -p my-app --json          # Output { "session": ... }
ao review list my-app                  # List native/local review runs
```

Start AO first with `ao start` (use `--no-orchestrator` if you only need polling
and the dashboard). The running instance must supervise the project. Enable its
native reviewer in `agent-orchestrator.yaml`:

```yaml
projects:
  my-app:
    # Existing path, repo, SCM and other project settings...
    reviewer:
      enabled: true
      githubUser: review-bot
```

`--project` takes precedence; otherwise the command uses `ao spawn` project
detection (a single configured project, `AO_PROJECT_ID`, or the current directory).
The command rejects a disabled or misconfigured native reviewer.

AO registers a **review-only** session and checks the PR through lifecycle polling.
It creates no coding worker or worker worktree. Native reviews use the configured
reviewer and appear on the PR and review board. Review-only sessions appear in
`ao session ls` as `[review-only]` (JSON `role: "review-only"`) and in the dashboard
with PR details. Worker terminal, send, restore and claim-PR actions are unavailable.
Kill or clean up the session using the existing session commands.

The existing `ao review run <session>`, `execute`, `list`, `send`, and `cancel`
subcommands continue to manage reviewer runs attached to coding workers.

## Maintenance commands

```bash
ao doctor                              # Check install, runtime, and stale temp issues
ao doctor --fix                        # Apply safe fixes automatically
ao setup openclaw                      # Connect AO notifications to OpenClaw
ao update                              # Update local AO install (source installs only)
ao config-help                         # Show full config schema reference
```

## Zsh completion

```bash
mkdir -p ~/.zsh/completions
ao completion zsh > ~/.zsh/completions/_ao
```

Add the directory to `fpath` before running `compinit`:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit
compinit
```

With Oh My Zsh, write the generated file to `${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/ao/_ao`
and add `ao` to the `plugins=(...)` list in `~/.zshrc`.

`ao doctor` checks PATH and launcher resolution, required binaries, configured plugin resolution, terminal-runtime health (tmux on Unix; PowerShell / `runtime-process` on Windows), GitHub CLI health, config support directories, stale AO temp files, and core build/runtime sanity. Runs and is supported on macOS, Linux, and Windows.

`ao update` fast-forwards the local install on `main`, reinstalls dependencies, clean-rebuilds core packages, refreshes the launcher, and runs smoke tests. Works on macOS, Linux, and Windows (Windows uses the bundled `ao-update.ps1` script automatically). Use `ao update --skip-smoke` to stop after rebuild, or `ao update --smoke-only` to rerun just the smoke checks.

## Multi-Project Rollout

Portfolio mode is enabled by default. Users do not need to set `AO_ENABLE_PORTFOLIO` unless they explicitly want to disable portfolio/project-management flows.
