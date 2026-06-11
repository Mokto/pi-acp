# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps:

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- Do **not** implement ACP client-side FS/terminal delegation in MVP. Pi already reads/writes and executes locally.
- Ignore `mcpServers` for MVP (accept in params, store in session state).
- Stream all pi assistant output as ACP `agent_message_chunk` initially.
- Tool events: map pi tool execution events to ACP `tool_call` / `tool_call_update` (as text content).

## Dev workflow (to be filled once scaffold exists)

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Test: `npm run test`

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bashN
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

## Releasing (this fork: `Mokto/pi-acp`)

This fork ships as a **GitHub release with a prebuilt tarball asset**, not on npm — the `pi-acp` npm name belongs to upstream (`deepstereo`/svkozak). Users install with `npm i -g <release-asset-url>` (see the README "Install this fork's release" section).

To cut a release for version `X.Y.Z`:

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
- **Always `npm run build` before committing/packing** so committed `dist/` never drifts from `src/`.
- **`github-release.yml` does not auto-run on a freshly forked repo** until Actions is enabled once via the GitHub UI (repo → Actions tab → enable). Until then, create releases manually with `gh release create` as above. `npm-publish.yml` targets the npm path and would 403 on this fork (the npm name isn't ours).

## Client information

- Current ACP client is Zed

## References

- Local ACP repo with protocol documentation and specs: `~/Dev/learning/agent-client-protocol`
- Local Zed repo `~/Dev/learning/zed/zed`
