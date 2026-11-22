# How it works

A tour of the moving parts, roughly in the order a workflow goes through them.

## The big picture

```
browser ──► Next.js app (apps/web) ──► MongoDB ◄── worker (in-process in dev, apps/worker in prod)
               │  pages, API, MCP          │             │
               │                           │             ├─ engine: runs the graph step by step
               └─ public endpoints:        │             ├─ sandbox: Code steps (isolated-vm)
                  /hook, /form, /chat,     │             ├─ apps: Telegram, Google, Slack, ...
                  /hook/telegram           │             └─ AI: Ollama or Claude
```

Everything lives in MongoDB, including the job queue, so there's no Redis or anything else to run. MongoDB has to be a replica set, because publishing uses transactions. `npm run db` starts a one-node replica set for you.

## Packages

- **core:** zod schemas for the workflow graph, graph validation, the data reference syntax, error codes. No dependencies on anything else in the repo.
- **nodes:** one definition per step type: its fields, inputs/outputs, sample output, and the rules for what can connect to what. The editor's settings panel is generated from these, so adding a field means touching one file.
- **engine:** takes a graph and some state and runs it. It doesn't talk to the database or the network itself. Everything goes through a `services` object, which is why most of it is tested with plain unit tests.
- **runtime:** the part that does touch the world: storing runs, the job queue and worker, triggers, the code sandbox, SSRF-safe HTTP, the credential vault, app integrations and the AI providers.

## A workflow, start to finish

1. **Editing.** The editor holds the graph in a zustand store and auto-saves the draft. Every save sends the revision number it started from, so if another tab saved in between you get a "this changed, reload" error instead of silently losing work.
2. **Publishing.** This snapshots the draft into `workflow_versions` and writes one row per live trigger into `triggers` (webhook path, form/chat path, next schedule time, Telegram bot). That happens in a transaction, so a half-published workflow can't exist.
3. **Something triggers it.** A webhook request, a form submit, a chat message, a Telegram message or the scheduler creates an execution and a job.
4. **The worker picks it up.** Jobs are claimed with a 5-minute lease. If a worker dies mid-run, the lease runs out and another worker takes the job. Each workspace runs at most `WORKSPACE_CONCURRENCY` executions at once; extra jobs wait their turn.
5. **The engine runs the steps.** It keeps a queue of steps that are ready, runs each one, and passes its output items to whatever's connected. If-steps and switches pick an output, loops feed back in, and merge waits for both sides.
6. **Every step is recorded** in `execution_steps`: input, output, logs, error, timing. Big outputs get cut at 200 KB, and anything that came out of a saved account (tokens, passwords) is replaced with `[hidden]` before it's stored.
7. **Waits.** A Wait step parks the execution (status `waiting`) and schedules a job for later, so nothing sits in memory for hours.

Test runs from the editor go through the same path, just marked as tests. Live runs only ever use the published version, never the draft.

## Data references

Step settings can pull in data from earlier steps:

```
${['$input']['email']}            the item coming into this step
${['node-id']['customer']['id']}  output of a specific earlier step
```

If a field is exactly one reference, you get the real value back (object, number, whatever). Otherwise it's pasted into the text. Paths are always quoted strings, which makes them boring to parse and hard to break.

## Triggers

- **Webhook:** `/hook/<path>`. It can check a header secret, and can wait for a Respond step to send a custom response (30 s max). The editor has a separate one-shot test URL under `/hook-test/<path>`.
- **Schedule:** interval or cron, with time zones. The worker checks every 10 seconds for schedules that are due.
- **Form:** a hosted page at `/form/<path>`. Answers are validated on the server, and a hidden honeypot field catches dumb bots.
- **Chat:** a hosted chat page at `/chat/<path>`. Each visitor gets a random session id stored in their browser, which you can use as the agent's conversation id. The page polls for the reply. Replies are plain text only, a visitor can only read their own replies, and messages are capped and rate limited.
- **Telegram:** two modes. With a public URL the app registers a webhook with a secret. On localhost it polls `getUpdates` instead, so it works on a laptop. Telegram only allows one of those per bot, so a bot can drive one live workflow at a time.

## AI

There's one small interface (`LlmService.chat`) with three implementations:

- **Ollama** (`llm-ollama.ts`): local and free. It uses Ollama's native `/api/chat` with tools and JSON-schema output. Ollama doesn't give tool calls ids, so the adapter makes them up. It also strips `<think>` blocks and raises the context window, because the default one silently cut off the builder's long prompt.
- **Anthropic** (`llm-anthropic.ts`): Claude, if you have a key.
- **Fake:** rule-based, for tests and for poking around without a model.

`AI_PROVIDER` picks one. The **agent** step loops: call the model, run whatever tools it asked for, feed the results back, until it answers or hits the round limit. Tools can be built-ins (HTTP, calculator, code, sub-agent, "think"), another workflow, or any app step. For app steps you mark which fields the model fills in, and only those end up in the tool's schema. Memory is the last N turns per conversation id, stored in `agent_memory`.

The **builder** gives the model tools to search the step catalog, read step details and propose a change set. The change is validated against the real step definitions before it touches your draft, and the panel shows what actually changed, because local models sometimes claim more than they did.

## Connected apps

Credentials are encrypted with AES-256-GCM, each with its own data key, which is wrapped by a master key. The workspace and credential ids are bound in as associated data, so a ciphertext copied to another record won't decrypt. Master keys are versioned, so rotating means adding a new version.

Google uses OAuth with PKCE. Tokens refresh just before they expire, and only one worker refreshes at a time (a lock on the credential row). **Reconnect** reruns the sign-in and puts the new tokens on the same saved account, so workflows don't need re-linking.

App calls go through one HTTP helper. Tests point it at a local fake of each service.

## Security bits

- **Code steps** run in `isolated-vm`: no Node APIs, no network, 10 s and 64 MB by default.
- **HTTP steps** resolve DNS first and refuse private and internal addresses (stops SSRF), and they check again after redirects.
- **Sign-in** is by email code via Better Auth, with optional TOTP two-step and single-use recovery codes.
- **API keys** are stored as SHA-256 hashes, have scopes, and only work on `/api/v1/*` and `/api/mcp`. They can't touch members or credentials.
- **The MCP server** uses OAuth 2.1 with dynamic client registration and PKCE. AI assistants can read workflows and edit drafts, but can't publish.
- **Outgoing webhooks** are signed: `Conduit-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`.
- **Teams:** every page and API call re-checks your membership in the current workspace.

## Things that aren't great yet

- The builder on a small local model is hit and miss for anything over 3 steps.
- No image, audio or video AI steps. Ollama's small models can't do them well.
- The Code step editor is a plain textarea with Tab support. Monaco would be nicer.
- The chat page is a hosted page only. There's no embeddable widget yet.
- Drive can only see files Conduit created (that's the `drive.file` permission, on purpose).
