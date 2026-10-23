# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps (one client connection can hold several live sessions, each with its own pi process):

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- No ACP client-side FS/terminal delegation. Pi already reads/writes and executes locally.
- `mcpServers` are accepted and stored in session state but not used.
- Assistant text streams as `agent_message_chunk`, thinking as `agent_thought_chunk`.
- Every pi that pi-acp starts loads `src/pi-rpc/compaction-extension.ts` (built to `dist/compaction-extension.js`, passed with `-e`). pi loads it on its own, so it must not import pi-acp code. It hands pi the summary `BackgroundCompaction` wrote in a second pi; that second pi (`summaryWriter: true`) starts without it, and without MCP servers, skills, prompt templates and context files, which a summary never reads. It keeps the other extensions, since some models (Cursor) come from one.
- Tool events map to ACP `tool_call` / `tool_call_update`, with structured diffs for `edit`/`write` and images for image reads where possible.
- **Requests to pi (`PiRpcProcess.request`) have no timeout.** On the path that completes a turn (between `agent_settled` and `completeTurn`), every awaited request is one a stuck pi can hang until the turn watchdog fires (5 min). `maybeEmitTokenStats` awaits `getSessionStats` there, wrapped in `withTimeout` (`src/acp/timeout.ts`, 2 s) with a fallback; don't add more. Fire-and-forget anything that isn't needed to finish the turn. Wrap a request in `withTimeout` only when it has a fallback: a limit on one that must succeed turns a slow pi into an error.

## Dev workflow

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Test: `npm run test`

`npm run test` runs every file in about 6 s. It clears `PI_ACP_LIVE`, which pi-acp running inside Zed may pass down to your shell; with it set, each test that creates the agent opens a real live socket in `~/.pi/pi-acp/live` and never exits. Run a single file the same way: `PI_ACP_LIVE= node --import tsx --test test/unit/<file>.test.ts`.

### Testing a change in Zed

- `npm run build && npm install -g .` links the global `pi-acp` to this checkout, so Zed runs it.
- Zed keeps a running pi-acp and reuses it for new threads, so a new thread is not enough after a rebuild. Pick **Reload Agent** in the Agent Panel's options menu (Zed 1.18+): it starts a fresh pi-acp for the open thread only, so use it in each thread you want on the new build, when no reply is running there. Other open threads stay on the old pi-acp (Zed's `retry_connection` replaces only that thread's connection), and new threads join the fresh one. Quitting and reopening Zed moves every thread to the new build.
- The Ocean team's auto-sync reinstalls the pinned release whenever its version differs from the installed one, which replaces the link. Undo it yourself with `npm install -g https://github.com/Mokto/pi-acp/releases/download/vX.Y.Z/pi-acp-X.Y.Z.tgz`.

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bash
# Send initialize request via stdin (exact fields depend on ACP SDK version)
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!
- When working from a personal fork, `origin` is the fork, `upstream` is `Mokto/pi-acp`, and PRs target `upstream`'s `main`. Branch from `upstream/main`, not the fork's `main`, which falls behind.
- When merging `main` into a branch, conflicts are usually only in `dist/`. Resolve them by rebuilding (`npm run build`) rather than hand-merging the generated files.

## Releasing (this fork: `Mokto/pi-acp`)

This fork ships as a **GitHub release with a prebuilt tarball asset**, not on npm — the `pi-acp` npm name belongs to upstream (`deepstereo`/svkozak). Users install with `npm i -g <release-asset-url>` (see the README "Install this fork's release" section).

Releases are automated: every push to `main` runs `.github/workflows/release.yml`, which runs the gate, bumps the **patch** version, rebuilds `dist/`, commits `release: vX.Y.Z`, tags, pushes, creates the GitHub release with both tarballs, and verifies the install. Do not bump the version or commit `release:` commits by hand. For a minor/major bump, run `npm version <minor|major> --no-git-tag-version` in your PR; the workflow then publishes `X.Y.1` / `X.0.1` on merge.

Manual fallback (if the workflow is broken), for version `X.Y.Z`:

1. Clean working tree on `main`. Run the gate: `npm run typecheck && npm run lint && npm run test` — all must pass.
2. Bump the version without a git tag: `npm version <patch|minor|major> --no-git-tag-version`.
3. Rebuild and commit the built output:
   ```bash
   npm run build
   git add package.json package-lock.json dist
   git commit -m "release: vX.Y.Z"
   ```
4. Tag and push: `git tag -a vX.Y.Z -m "pi-acp vX.Y.Z" && git push origin main vX.Y.Z`.
5. Build the install tarballs and create the release (attach **both** the versioned tarball and a stable-named `pi-acp.tgz` so `releases/latest/download/pi-acp.tgz` keeps resolving):
   ```bash
   npm pack                       # -> pi-acp-X.Y.Z.tgz
   cp pi-acp-X.Y.Z.tgz pi-acp.tgz
   gh release create vX.Y.Z --repo Mokto/pi-acp --title "vX.Y.Z" --generate-notes \
     pi-acp-X.Y.Z.tgz pi-acp.tgz
   rm -f pi-acp-X.Y.Z.tgz pi-acp.tgz
   ```
6. Verify the published install in an isolated prefix (expect a JSON-RPC result reporting the new version):
   ```bash
   PFX=$(mktemp -d)
   npm i -g --prefix "$PFX" https://github.com/Mokto/pi-acp/releases/latest/download/pi-acp.tgz
   printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n' \
     | node "$PFX/bin/pi-acp"
   ```

### Release gotchas (why it works this way)

- **Do NOT advertise `npm i -g github:Mokto/pi-acp#vX.Y.Z`** — it is broken. npm symlinks global git-dependency installs into a transient `_cacache/tmp` clone that is then deleted, leaving the `bin` dangling with no `dist`. The release-asset tarball avoids this.
- **`dist/` is committed on purpose** (tracked in git, but excluded from prettier/lint) so the repo is self-contained and `npm pack` always ships a current build. There is intentionally **no `prepack`/`prepare` script**: those run a build during git/pack/install flows where devDependencies are unavailable (`tsup: command not found`) and break installs. `prepublishOnly` still builds before any future `npm publish`.
- **Always `npm run build` before committing/packing** so committed `dist/` never drifts from `src/`. The release workflow rebuilds `dist/` in CI, so PRs don't strictly need to commit it.
- **The release workflow can't loop**: its own push uses `GITHUB_TOKEN`, which never triggers workflows, and it also skips `release:` head commits. It pushes directly to `main`, so adding branch protection to `main` will break it unless the bot is allowed to bypass. `npm-publish.yml` targets the npm path and would 403 on this fork (the npm name isn't ours).

## Client information

- Current ACP client is Zed.
- **Config options are how an agent adds controls to Zed's composer bar** (they replace the older `modes`/`models` fields). Zed draws every `select` config option as a dropdown and every `boolean` one as a switch (`crates/agent_ui/src/config_options.rs` in the Zed repo). For a dropdown:
  - The button shows the selected option's `name`, so that text doubles as the label.
  - The only non-clickable text in the menu is group headings (`SessionConfigSelectGroup.name` in the SDK), and a heading only appears above at least one option.
  - Hovering an option shows its `description`; Zed also adds a "favorite" star to every row.
  - Zed saves a picked value to its settings (`default_config_options`) and replays it into new sessions via `session/set_config_option`, so handlers must accept stale or unknown values without throwing.
- **Zed holds messages sent mid-turn in its own queue** for external agents and only sends them when the turn ends (or cancels the turn first, with "Send Now"), so pi-acp never sees them early. Steering can't be built here until ACP adds it (RFD `session/inject`).
- Extension `ctx.ui.notify` warnings and errors that arrive outside a reply become Zed notices, split at the first ". " or line break into title and description (`src/acp/translate/notice.ts`). Ocean's `extensions` repo writes its notify text as "Title. Detail." for that split; change both sides together.
- `update_plan` tool calls become Zed's plan panel (`src/acp/translate/plan.ts`). The tool and its argument shape (`goal`, `plan: [{ step, status }]`) live in the `todo` extension in Ocean's extensions repo, so change both sides together. A v1 plan loses its completed rows at each new user message (Zed's `clear_completed_plan_entries`); the tool re-sends the whole list on every update. After each compaction the extension re-sends the list as a custom message (`customType: "todo"`, tool arguments in `details`), since pi drops the summarized tool call from what it returns.
- The `plan_usage` option reads `~/.pi/agent/plan-usage/<provider>.json`, written by the `plan-usage` extension in Ocean's `ocean-extensions` repo. That file format is a contract between the two repos (see the README); change both sides together.

## References

- ACP protocol documentation and specs: https://agentclientprotocol.com and https://github.com/agentclientprotocol/agent-client-protocol
- Zed (ACP client source, `crates/agent_ui`, `crates/acp_thread`): https://github.com/zed-industries/zed
