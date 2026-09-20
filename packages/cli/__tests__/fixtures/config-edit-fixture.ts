/** Wrapped live-style config used by the config editing tests. */
export const FIXTURE = `# live config
agents:
  codex-coder: { plugin: codex, model: gpt-6-astra, reasoningEffort: xhigh, permissions: permissionless }
  codex-reviewer: { plugin: codex, sandbox: danger-full-access }
identities:
  neo: { githubUser: neo-automaton, tokenEnv: NEO_GITHUB_TOKEN, agent: codex-coder }
  trinity: { githubUser: trinity-automaton, tokenEnv: TRINITY_GITHUB_TOKEN, agent: codex-reviewer }
defaults:
  runtime: tmux
  agent: codex
  workspace: clone
  branchNameTemplate: "{issue}.{slug}"
  worker: { identity: neo }
  scm: { plugin: github, identity: neo }
  reviewer: { identity: trinity, enabled: false }
projects:
  app: # the first project
    name: App
    path: /repos/app
    repo: org/app
    defaultBranch: main
    sessionPrefix: app
`;
