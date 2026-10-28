# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
  - Multiple ACP sessions can be live at once within a single client connection (one pi subprocess per `sessionId`). Opening or loading a different session no longer tears down siblings.
  - `session/load` reuses an in-memory session when the same `sessionId` is already active (no respawn, no history replay)
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- Model picker lists models under one heading per provider, so the button shows only the model's name. A context size in the name (Cursor's "Grok 4.7 (fast) @ 256k") is left out, since the Compaction button shows it, unless two models would then share a name
- Model picker respects pi's `enabledModels` setting
  - When `enabledModels` is set in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`), the ACP model picker is scoped to those models, matching pi's own resolution (exact ids, `provider/*` globs, and partial matches). Patterns that resolve to no model are ignored just like in pi — note these are model **ids** (e.g. `anthropic/claude-sonnet-4-6`), not display names (`Claude Sonnet 4.6`). The active model is always kept selectable.
- Thinking picker lists only the levels the current model supports (`off` to `max`), refreshed when the model changes. Needs pi 0.81 or newer; older pi gets a fixed `off`–`xhigh` list.
- Compaction selector: a `compact_at` config option, shown first, picks a context size (200k, 300k, 400k or 500k) at which a thread compacts as soon as a reply ends, so a long task is never paused midway
  - A message sent while it runs waits for it; Stop cancels it but keeps a summary written in the background, finished or not, for the next compaction. If an after-reply compaction fails, that thread stops retrying until a compaction succeeds or a size is picked again.
  - The last row, the model's own window (e.g. `1M`, or `Model limit` when pi doesn't know it), leaves compaction to pi, which compacts when the thread is nearly full, and follows the model when you switch.
  - Each thread keeps its own pick, saved in `~/.pi/pi-acp/session-map.json`. Zed saves your last pick and applies it to new threads. On Zed 1.26 and later a reopened thread keeps its own pick; earlier versions replace it with your last pick. While one is set the context ring fills toward it instead of the model's window. Sizes the current model's window can't reach are left out of that thread's menu, which then shows the model's own window without changing the pick.
  - A little before the picked size (12.5% below it, between 8k and 32k tokens), a second pi writes the summary from a copy of the thread while work continues, so the compaction at the end of the reply swaps it in at once. Messages written after the copy stay word for word. Once swapping it in would leave more than a quarter of the picked size, a second pi writes a newer summary, but only before the thread reaches the size; a reply that ends meanwhile uses the older one as long as it leaves under half. The same happens before pi's own compaction point (the model's window minus `compaction.reserveTokens` in pi's settings), so a thread on the last row or with a size its model can't reach doesn't pause mid-reply while pi summarizes.
  - The hand-over goes through a small extension pi-acp loads into each pi (`dist/compaction-extension.js`) and files in `~/.pi/pi-acp/compaction`. A summary that no longer fits the thread, after another compaction or a rewind, or once the thread has grown so much since the copy that the swap would save too little, is ignored and pi summarizes as usual; one that couldn't be written isn't retried until the next compaction or size pick.
  - The `/autocompact` command is gone. An earlier `/autocompact off` stays in pi's settings (`"compaction": { "enabled": false }` in `~/.pi/agent/settings.json`) until set back to `true` there. While it's off, the picked size still compacts after replies, but pi won't compact a thread that overflows the model's window.
- Plan usage selector: when `~/.pi/agent/plan-usage/<provider>.json` files exist (written by a pi extension, one per pi provider id, e.g. `anthropic.json`), a `plan_usage` config option lists each provider's subscription limits with how long until each resets, refreshed after each model step and once a minute. Each file is `{ updatedAt, windows: [{ label, utilization, resetsAt }] }` (utilization 0–1, ISO timestamps); a provider not updated for a week is hidden. Rows read `Provider / Label · percent`, and limits more than a day away also show the reset date. The button follows the current model's provider and shows its limit closest to running out (the `Automatic` row, without the provider name); picking a limit row shows that one instead while on that provider's models, until `Automatic` is picked again.
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). `quietStartup` also suppresses the outdated-pi “New version available” notice. To keep the prelude but skip only that nag, set `PI_SKIP_VERSION_CHECK=1` or `PI_ACP_SKIP_UPDATE_NOTICE=1` in the ACP process environment.
- (Zed) Compaction (automatic or `/compact`) shows as one collapsed entry with pi's summary inside: the client's own compaction entry when it advertises `session.compaction` (Zed 1.25.2 and newer), otherwise a collapsed tool card. Reopening a compacted thread shows the same entry where the earlier messages were summarized, since pi only returns the messages after it. Until the next reply reports the real size, the context ring shows pi's estimate of the compacted thread (characters / 4, typically about 30% under the real count), also when the thread is reopened.
- (Zed) Extension warnings and errors raised outside a reply (for example while a thread opens, or on a model switch), an extension that crashes there, and pi stopping while the thread is idle show as dismissible notices above the message box when the client advertises `session.notices` (Zed 1.25.2 and newer), and as reply text otherwise. Info messages outside a reply are not shown; inside a reply, notify text stays in the reply.
- (Zed) To-do list in the plan panel: a call to an extension tool named `update_plan` with `{ goal?: string, plan: [{ step, status: "pending" | "in_progress" | "completed" }] }` shows as the panel above the message box instead of a tool card. The goal becomes a first row, `Goal: …`, kept open so the panel doesn't read "All Done" while the thread is still about it. Each call replaces the whole list, an empty plan clears it, and reopening a thread shows its latest list again. Because pi only returns the messages after a compaction, the extension re-sends the list after each one as a custom message (`customType: "todo"`, the same shape in `details`), which counts too. pi-acp ships no such tool; an extension provides it (Ocean's adds it with `/todo`).
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` 0.80.4 or newer, installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Install this fork's release (`Mokto/pi-acp`)

This fork is distributed as a **GitHub release** (the `pi-acp` name on npm belongs to upstream). Install the latest release globally:

```bash
npm install -g https://github.com/Mokto/pi-acp/releases/latest/download/pi-acp.tgz
```

To pin a specific version instead:

```bash
npm install -g https://github.com/Mokto/pi-acp/releases/download/v0.0.28/pi-acp-0.0.28.tgz
```

Then point your ACP client (e.g. Zed) at the installed `pi-acp` binary:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

> Note: `npm i -g pi-acp` and `npx -y pi-acp` install the **upstream** npm package, not this fork. `npm i -g github:Mokto/pi-acp` is unreliable for global installs (npm symlinks the package into a transient cache dir), so use the release tarball above.

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.
- `PI_ACP_TURN_INACTIVITY_MS` — max idle time (ms) while waiting for pi events during a turn (default: `3600000` / 60 min).
- `PI_ACP_INFERENCE_STARTUP_MS` — max wait (ms) for the first model output after a prompt (default: `300000` / 5 min).
- `PI_ACP_DIR` — folder for pi-acp's own files (session map, background summaries, live sockets). Default: `~/.pi/pi-acp`.
- `PI_ACP_PREWARM=0` — don't keep a pi started ahead of the next new session. By default, after each new session or prompt pi-acp starts one spare pi for that folder, so the next `session/new` skips pi's startup (a second or more with many extensions). The spare is dropped after 10 idle minutes, and a new session starts its own pi when settings, `AGENTS.md`/`CLAUDE.md` or the extension folders changed since the spare started. It costs one idle pi process per active workspace.
- `PI_ACP_LIVE=1` — opt-in. Opens a per-process unix socket at `~/.pi/pi-acp/live/<pid>.sock` and a registry file `~/.pi/pi-acp/live/<pid>.json` so a local sidecar (e.g. Slack) can attach to live sessions, prompt, and receive the same `session/update` stream Zed sees. **Default off.** Unset / any other value: no socket, no files, no extra work. A failed listen is logged to stderr and never takes the ACP client down.

  Socket protocol is newline-delimited JSON, not ACP. Verbs: `list`, `attach`, `detach`, `prompt`, `cancel`. Updates are `{ "type": "update", "sessionId", "update" }` notifications. Mode `0600` on the socket and registry; live dir `0700`. Treat `live/*.json` as a hint — probe `kill(pid, 0)` before trusting a row.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set
- `/login [provider]` – OAuth login (Claude Pro/Max, ChatGPT, Copilot, …) from the chat; restarts the session's pi so new models show up
- `/logout [provider]` – remove credentials stored by `/login`

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

#### 4) Extension commands

- Slash commands contributed by pi extensions (from `pi`'s `get_commands`) are forwarded to the ACP client and run by sending the command to `pi`. Enabled by default; set `enableExtensionCommands: false` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`) to hide them.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

pi-acp also advertises browser-only OAuth methods (**Log in with Claude Pro/Max / ChatGPT Plus/Pro / OpenRouter**).
Zed shows them next to **Launch pi**; picking one opens the provider's login page and saves the credential to pi's `auth.json`.

Inside a thread, `/login [provider]` runs the same pi OAuth flow (needs pi >= 0.99, loaded from the `pi` on `PATH`).
Device-code providers (Copilot, xAI, …) print the code in chat. If the browser can't reach the machine running pi-acp,
stop the turn and send the final redirect URL (or the code the provider shows) as your next message.
API keys are deliberately not accepted in chat, since Zed keeps the thread history; use `pi` in a terminal or an env var.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
