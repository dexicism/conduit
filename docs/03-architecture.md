# 3. Application architecture (Conduit)

The design decisions behind Conduit, and how each part was built.

## 3.1 System overview

```
                ┌──────────────────────────────────────────────┐
 Browser ──────▶│  apps/web  (Next.js 15 App Router, React 19) │
 (editor, dash) │  UI · Route Handlers (REST /api/*) · Auth    │
                └───────┬──────────────────────┬───────────────┘
                        │ MongoDB              │ enqueue jobs
                        ▼                      ▼
                 ┌────────────┐         ┌──────────────┐
                 │  MongoDB   │◀───────▶│    Redis     │ BullMQ queues, pub/sub,
                 │ (replica   │         │              │ rate limits, locks
                 │   set)     │         └──────┬───────┘
                 └────────────┘                │
                        ▲                      ▼
                        │            ┌─────────────────────┐   isolated-vm
                        └────────────│  apps/worker (Node) │── sandbox for Code /
                                     │  execution engine,  │   Node Builder JS
                                     │  scheduler, pollers │
                                     └─────────┬───────────┘
                                               │ HTTPS
                                 LLM gateway (OpenRouter / Anthropic / OpenAI),
                                 third-party APIs, object storage (S3/R2)

 apps/mcp  (Streamable HTTP MCP server + OAuth 2.1 AS endpoints; shares packages/core)
 apps/hooks (optional) public webhook ingress; can live inside apps/web at first
```

**Why a separate worker.** Workflows run for seconds to days (the Wait node), need concurrency caps per workspace, and must not run inside serverless request lifetimes. Next.js handles UI and API only. All execution runs in the long-lived worker.

## 3.2 Monorepo layout (pnpm + Turborepo)

```
apps/
  web/        Next.js: marketing, auth, dashboard, editor, REST API, webhook ingress
  worker/     BullMQ consumers: executions, schedules, pollers, trigger (un)subscribe
  mcp/        MCP server (Streamable HTTP) + OAuth authorization endpoints
packages/
  core/       Domain types (zod), workflow graph utils, change-set validator, expression engine
  nodes/      Node registry: one folder per node {definition.ts, schema (zod), execute.ts, sample.json}
  engine/     Graph executor (pure; host-agnostic; used by worker and by tests)
  sandbox/    isolated-vm wrapper: limits, allow-listed fetch, log capture, KV getValue/setValue
  db/         Mongoose models, indexes, migrations
  ai/         LLM provider abstraction, Builder agent loop, prompts (ours)
  crypto/     Envelope encryption for credentials
  ui/         shadcn/ui components, canvas node components, theme tokens
```

## 3.3 Technology choices

| Concern | Choice | Justification |
|---|---|---|
| Web | Next.js 15, React 19, TypeScript strict | Full-stack React with server routes in one app |
| Styling | Tailwind CSS v4, shadcn/ui (Radix), lucide icons | Accessible primitives, fast to style |
| Motion | Framer Motion | Panel transitions, node add/remove |
| Canvas | **@xyflow/react (React Flow 12)** | The mature open-source node editor. Handles, edges, minimap, zoom, and custom nodes come built in. Writing our own would add months |
| Auto-layout | elkjs | Layered graph layout for "tidy up" and Builder placement |
| Client state | Zustand plus zundo (undo/redo) | Canvas state outside React re-renders; built-in history |
| Server state | TanStack Query | Cache and optimistic updates for the dashboard |
| Forms | react-hook-form plus zod | One zod schema drives node config forms, the API, and Builder validation |
| Code editor | Monaco (`@monaco-editor/react`) | Code node and Node Builder; JS IntelliSense |
| DB | MongoDB 7 (replica set for transactions) with Mongoose | Fits a document-shaped workflow graph |
| Queue | BullMQ on Redis | Delayed jobs (Wait and Schedule), concurrency per group, retries |
| Sandbox | **isolated-vm** | A real V8 isolate with memory and time limits. `vm2` is deprecated or insecure, and Node `vm` is not a security boundary |
| Auth | Auth.js v5 (next-auth): Google, GitHub, Email (OTP via custom provider); otplib TOTP for 2FA | The standard choice |
| Email | Resend (or SMTP via Nodemailer) | OTP codes and invoices |
| LLM | Provider abstraction. Default **Anthropic Claude** (`claude-sonnet-5-5` for agents and Builder, `claude-haiku-5-5` for classify and sentiment), with OpenRouter as an optional multi-model gateway | Tool use quality matters for the Agent and Builder |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP) | The standard SDK |
| Files | S3-compatible (Cloudflare R2 or MinIO locally) | Generated images, audio, uploads |
| Realtime | Server-Sent Events from `/api/executions/:id/stream`, fed by Redis pub/sub | One-way live run output. Simpler than websockets on Vercel-like hosts |
| Observability | pino logs, OpenTelemetry traces, Sentry | |
| Tests | Vitest (unit), Playwright (E2E), testcontainers (Mongo and Redis) | |

### 3.3.1 Decisions that changed while building

| Planned | Actual | Why |
|---|---|---|
| Next.js 15 | **Next.js 16.4** (React 19.3, Turbopack default, `proxy.ts` instead of `middleware.ts`) | It is the current stable release. Read the bundled docs in `node_modules/next/dist/docs/` before changing framework code |
| pnpm + Turborepo | **npm workspaces** (Turborepo can be added later) | pnpm is not installed on the dev machine. npm workspaces need no extra tooling |
| Auth.js v5 | **Better Auth 1.7** (email-OTP plugin, Google/GitHub, MongoDB adapter; TOTP plugin for two-step sign-in) | Auth.js v5 is still in beta. Better Auth covers passwordless OTP, account linking and 2FA natively |
| Mongoose | **Native MongoDB driver 7 + zod** | Better Auth needs the raw driver anyway, so this shares one client pool. zod schemas in `@conduit/core` are the single source of truth for validation |
| shadcn/ui on Radix | **shadcn/ui 4 on Base UI** (`@base-ui/react`) | It is the shadcn 4 default. Triggers use the `render` prop instead of `asChild` |
| Docker-compose Mongo | **`npm run db`**: a single-node replica set via the official `mongod` binary (mongodb-memory-server), data kept in `.data/mongo` | The Docker engine is not running on the dev machine. A replica set is still required for transactions |

### 3.3.2 Editor implementation

- **`packages/nodes`**: declarative node definitions, one per step type, 22 in total:
  - 5 triggers
  - 6 flow nodes
  - 5 core nodes
  - 6 transforms

  Each definition holds:
  - picker metadata
  - field specs (string, number, boolean, select, JSON, code, key/value, conditions, switch cases, assignments, workflow picker)
  - `showIf` visibility rules
  - static or computed output handles
  - loop-back inputs
  - an example output that feeds the variable picker before real runs exist

  The same package validates parameters (non-blocking) and graphs (blocking on save). Graph validation rejects unknown types, bad handles, edges into triggers, and cycles that don't close into a Loop.
- **`packages/core/expression`**:
  - References are `${['$input']['a']}` and `${['node-id']['a']}`, with `{{ a.b }}` accepted as a legacy alias.
  - Parsing, building, deep resolution and reference collection are covered by unit tests.
  - JavaScript evaluation is deliberately left to the Code step's sandbox.
- **Editor state:**
  - A Zustand vanilla store per open workflow holds the canonical `WorkflowGraph`.
  - Undo/redo history has 100 snapshots. Typing coalesces per field within 1.2 s, and a drag counts as one history entry.
  - React Flow 13 is fully controlled. `onNodesChange` receives a `NodeChangeset`, and only position, dimension and selection changes are applied. Deletions go through `onDelete` as a single undo step.
- **Autosave:** `PUT /api/workflows/:id/draft` with `expectedRevision`, 700 ms after edits settle, one request in flight at a time.
  - On a 409 autosave stops, and a banner offers "Load latest version" or "Keep my version".
  - When offline it retries every 4 s.
- **Copy/paste** uses the system clipboard events (`copy`, `cut`, `paste`) with a `conduit/nodes` JSON payload. No clipboard permission prompt is needed.
- **Auto-layout** uses ELK (layered), loaded lazily. Switching orientation re-lays out the graph in the new direction.
- **Known gap:** the Code step uses a monospace textarea with Tab indentation for now. Monaco could replace it later.

### 3.3.3 Execution engine as built

| Planned | Actual | Why |
|---|---|---|
| BullMQ on Redis | **MongoDB-backed job queue** (`jobs` collection) | No Redis or Docker on the dev machine, and it keeps the stack to one database |
| Monaco for the Code step | **CodeMirror 6** (`@uiw/react-codemirror`) | Bundled locally (Monaco's React wrapper loads from a CDN by default) and much lighter |
| Redis pub/sub for live output | **SSE that polls MongoDB every 300 ms** | Simple and robust at this scale |

How the MongoDB job queue works:
- Jobs are claimed atomically with `findOneAndUpdate` and a 5-minute lease.
- Delayed jobs (`runAt`) handle Wait and resume.
- Workspace concurrency is capped (default 4). An over-limit job is released and retried a second later.
- It can be swapped for BullMQ later without touching the engine.

Packages:
- **`packages/engine`**: pure and unit-tested.
  - It holds the item model, executors for all 22 step types, and the queue-driven runner.
  - The runner handles Loop (with and without a loop-back edge), Merge (with a flush when a branch never arrives), durable Wait (state serialised to JSON), disabled steps, stop/continue on error, and a 10,000-step guard.
  - It includes a cron calculator that understands time zones.
  - Side effects (HTTP, code, sub-workflows, clock) are injected.
- **`packages/runtime`**: the Node side.
  - `isolated-vm` sandbox: a fresh V8 isolate per run, 64 MB, 10 s, no Node APIs or network, data in and out as JSON.
  - SSRF-guarded HTTP through undici. Every DNS answer is validated at connect time, which closes DNS rebinding. Redirects are re-checked on every hop. Responses are capped at 5 MB.
  - It also holds the job queue and worker, execution persistence (steps capped at 20 items and 200 KB each), the schedule ticker, publish and trigger registration (inside a transaction, with unique webhook paths), sub-workflow calls (depth limit 5), and error workflows.
- **Where the worker runs:**
  - In development it runs inside the Next.js server through `instrumentation.ts`.
  - In production it runs as `apps/worker` (`npm start -w worker`), scaled horizontally.
- **Test vs live:**
  - Test runs use the saved draft. Sub-workflows they call may also be drafts.
  - Live runs use the published version snapshot.
  - Retries reuse the original graph and trigger data.

Known limitations:
- A job whose lease expires mid-run (a run longer than 5 minutes of continuous work) is marked failed rather than replayed, to avoid repeating side effects.
- A called workflow can't use Wait while the caller waits for its result.

### 3.3.4 AI as built

**Provider**
- Claude goes through the official `@anthropic-ai/sdk` on the beta Messages endpoint.
- The default model is `claude-opus-5-5`. Each step can choose Sonnet 5.5 or Haiku 5.5 instead.
- Opus 5.5 and Sonnet 5.5 send `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a refused request is re-run on Anthropic's recommended fallback model. Haiku has no server-side fallback, so refusals there fail the step with a clear message.
- **Thinking** is left at the model's adaptive default, since Opus 5.5 can't disable it. Effort is the cost lever: low for classifiers, and per-step for agents.
- **Tools** use `strict: true` with `tool_choice: auto`, because forced tool choice returns a 400 on these models.
- **Structured outputs** use `output_config.format` (`json_schema`).
- **Thinking blocks** go back unchanged across the tool loop, as opaque blocks.

**Without a model**
- The planned OpenRouter adapter was dropped. Claude is called only through the official SDK.
- With no key configured, AI steps and the Builder are hidden. Publishing a workflow that contains AI steps is refused.

**Test model**
- `AI_PROVIDER=fake` is a deterministic, rule-based model used for automated tests and keyless local development. It refuses to start in production.

**Agent loop**
- The engine's own loop (`packages/engine/src/executors/ai.ts`) runs over provider-neutral blocks.
- Tool calls in one round run in parallel. All their results go back in a single user message.
- Tool errors are returned to the model as `is_error` results, so it can recover.
- The round cap defaults to 10 and can be raised to 25.
- Optional memory keeps the last N turns per conversation ID (`agent_memory`, 30-day TTL).

**Tools**
- Tool steps hang off the agent's `tool` port and never run in the main flow.
- Parameters marked `={{AI('key', \`desc\`, 'type')}}` become the tool's input schema. References are resolved first and the model's arguments filled in after, so model output is never interpreted as a reference.
- Six tool types: HTTP request, Calculator (a safe parser, no `eval`), Think, Run workflow, Code (sandboxed), and Sub-agent.

**Builder**
- Lives in `packages/runtime/src/builder.ts`, with a system prompt written for this product.
- It has three tools: `find_steps`, `describe_step` (exact fields, options, value shapes and sample output), and `save_changes`.
- `save_changes` validates the change set with zod, `applyChangeSet`, structural checks and registry checks, and sends errors back for the model to fix.
- The API saves the result as a new draft revision guarded by `expectedRevision`.
- The editor adopts the result as one undo step and highlights the added and changed steps.
- Conversations are kept in `builder_conversations` (last 40 messages).

**Not built yet**
- Image generation, video generation and audio transcription need a non-Claude provider. They're not built yet.

### 3.3.5 Connected apps as built

**Vault** (`packages/runtime/src/vault.ts`)
- Each credential has its own random data key. The data key encrypts the values with AES-256-GCM, and a master key from `CONDUIT_ENCRYPTION_KEY` wraps the data key.
- Both layers use `workspaceId:credentialId` as associated data, so a ciphertext copied to another row or workspace won't decrypt.
- `keyVersion` is stored with each credential. To rotate, set `v1:<old>,v2:<new>`: new secrets use v2, and old ones still open.
- Production refuses to start without the key. Development generates one in `.data/encryption.key`, shared by the web app and the worker.

**Secrets stay inside the run**
- Steps read values through `services.integrations.credential(id, app)`. It looks the credential up by id and the run's workspace together, so another workspace's id fails.
- Every secret opened during a run is collected. Step input, output, logs, errors and the final state are masked (`[hidden]`, including URL-encoded copies) before they're stored.
- The API returns only labels, a non-secret account summary and the status.
- The HTTP client drops `Authorization`, `Cookie` and any header marked sensitive when a redirect leaves the original origin.

**Drivers outside HTTP** (PostgreSQL, SMTP)
- The host is resolved and every address checked against the private-network guard. The driver then connects to that exact IP; TLS still verifies the original hostname.

**OAuth2** (`oauth.ts`, Google only for now)
- Authorization-code flow with PKCE S256. State is single use, expires after 10 minutes, and is bound to the signed-in user.
- Google is offered only when `CONNECT_GOOGLE_CLIENT_ID`/`_SECRET` are set (or the sign-in `GOOGLE_*` pair is).
- Refresh happens when a token is within 60 seconds of expiry. One caller takes a lock with a compare-and-set on `version`; the others wait for its result.
- A revoked refresh token marks the account "Needs attention".

**Apps and steps**
- `packages/nodes/src/apps.ts` defines the apps; `definitions/apps.ts` defines the steps.
- Executors live in `packages/engine/src/executors/apps.ts`.
- Every action step also has a generated tool version (`tool.<type>`) whose text fields accept AI-fill placeholders.
- The Telegram trigger sets the bot's webhook at publish, with a random path and secret, and allows one live workflow per bot. Unpublishing deletes the webhook.

**Testing**
- `packages/runtime/src/testing/fake-apis.ts` stands in for Telegram, Slack, Google OAuth, Gmail and Sheets, reached through `CONDUIT_FAKE_APIS_URL`. That variable is refused in production.
- PostgreSQL tests use PGlite (PostgreSQL compiled to WebAssembly) over the wire protocol with the real `pg` driver. SMTP tests use a local `smtp-server`.
- None of this proves behavior against the real services. That needs real accounts.

**Deferred to 5b:** WhatsApp Cloud API, Google Calendar and Drive, MySQL, S3/R2. Each needs either a sandbox account or more driver work.

### 3.3.6 Teams as built

Everything is free: there are no plans, credits or usage limits. Run logs are kept for `EXECUTION_RETENTION_DAYS` (7 by default) and each workspace runs up to `WORKSPACE_CONCURRENCY` workflows at once (4 by default).

**Teams**
- The current workspace is the `conduit_ws` cookie. Membership is re-checked on every page and API request, and the call falls back to the user's first workspace if the check fails.
- Invitations store a SHA-256 hash of a random token, expire after 7 days, are single use, and require the signed-in email to match.
- Roles:
  - owner: everything
  - admin: members; can't create owners
  - editor: build, run, publish
  - viewer: read only
- A workspace always keeps at least one owner. There's no member limit.


### 3.3.7 Platform and security as built

**API keys** look like `cdt_<prefix>_<secret>`:
- Only a SHA-256 hash is stored, with a unique prefix for lookup.
- Keys have scopes and authenticate only `/api/v1/*` and `/api/mcp`. Session routes don't accept them, so they never reach members or credentials.

**Outbound webhooks** (`packages/runtime/src/outbound.ts`):
- Deliveries are queued in Mongo and claimed with a lease.
- They're signed with the endpoint's encrypted secret, sent through the SSRF-guarded client, and retried with backoff.

**Form trigger:**
- Published like a webhook, as trigger kind `form`.
- The public page and submissions are validated against the published version's questions.

**MCP** (`lib/mcp-server.ts`, `lib/mcp-oauth.ts`):
- JSON-RPC over Streamable HTTP, answering with plain JSON (no SSE stream).
- Writes go through the Builder's shared `createBuilderSession`, so MCP edits and AI Builder edits are validated the same way, and only drafts change.
- OAuth 2.1:
  - DCR, public clients and PKCE S256
  - authorization codes that last 60 s and work once
  - 1 h access tokens and 30-day rotating refresh tokens; reuse detection revokes the grant
  - only hashes stored
- Membership and role are re-checked on every call.

**Two-step verification** (`lib/two-factor.ts`):
- Better Auth's plugin only gates password sign-ins, and all sign-ins here are passwordless, so it's enforced per session. `requirePageUser` and `requireApiContext` refuse a session until it passes, and so do the OAuth consent page and its POST.
- RFC 6238 TOTP (SHA-1, 30 s, ±1 step). The secret is encrypted with the vault.
- Each time step is accepted once, recovery codes are hashed and single use, and 10 failures lock it for 15 minutes.

## 3.4 Execution engine design

**Model.** A workflow is a DAG of nodes, with loops expressed as Loop nodes rather than back edges. Each node receives `items: Item[]` (an `Item` is `{ json, binary? }`) and returns output per handle: `{ main: Item[] }`, `{ true: Item[], false: Item[] }`, or `{ loop, done }`.

**Algorithm (queue-driven, resumable):**
1. The trigger produces the initial items, and an Execution document is created (`status=running`).
2. A ready-queue of `(nodeId, inputHandle, items)` is kept. Nodes with multiple inputs (Merge) wait until every connected input has arrived or its branch was skipped.
3. Each node step:
   - resolves its parameters per item (expression engine)
   - runs the node's `execute()`
   - persists a `StepRun` (input sample, output, error, timings)
   - publishes a progress event to Redis
4. **Wait:** the engine persists its state, schedules a delayed BullMQ job, and releases the worker slot. Long waits cost nothing while idle.
5. **Errors:** each node has a setting, `stop` (default), `continue`, or `continue (error output)`. When an execution fails, any workflow with an Error trigger linked to it is enqueued.
6. **Respond node:** resolves the pending HTTP response of a synchronous webhook (via Redis correlation ID and a timeout).
7. **Execute Node:** runs a child execution and awaits its result (with a depth limit to prevent recursion bombs).
8. **Concurrency:** a BullMQ group per workspace, sized to the workspace concurrency limit.

**Expression engine (`packages/core/expr`):**
- **Parser** recognizes `${[...path]}` bracket paths, `={{ AI(...) }}` agent-fill placeholders, and `{{ ... }}` (a legacy alias).
- **Path resolution** is pure: `$input` is the current item, and `nodeId` is that node's output for the paired item.
- **JS fragments** (e.g. `.toLowerCase()`, `Math.round`) are evaluated in an isolated-vm context. That context holds frozen data and a curated helper library (date via dayjs, crypto hashes). It has no I/O and a 50 ms timeout.

**Trigger lifecycle (on publish):**
- **Webhook:** register a route key → `POST /hook/:workflowId/:path` (test URL `/hook-test/...` is active only while the editor is listening).
- **Schedule:** a BullMQ repeatable job with a cron expression.
- **App triggers:** run the node's `subscribe()` (provider webhook) or schedule a poller with per-trigger KV state (Node Builder's `getValue`/`setValue`).
- **Unpublish or republish:** `unsubscribe()` then `subscribe()` again.

## 3.5 AI subsystems

- **AI Agent node:**
  - A tool-use loop with max iterations, a token budget, and streamed steps logged as sub-steps.
  - Tools come from nodes connected to its `tool` handle. Each tool node exposes a JSON schema derived from its zod schema, and `AI(...)` placeholders become model-filled arguments.
  - Memory options: window (last N turns, keyed by a session expression such as a chat ID), plus a vector store.
- **Builder (our Magic Builder equivalent):**
  - An agent loop with the tools `search_nodes`, `describe_node`, `validate_changes` and `apply_changes`.
  - It never calls run or publish.
  - Output is a change set (`nodes`, `updates`, `deleted`) applied atomically with `expectedRevision`. The editor shows a diff overlay and one-click undo.
  - The system prompt is written by us from first principles.
- **MCP server:** exposes the same Builder tools to external chats (the external model does the inference). OAuth scopes are `workflows:read`, `workflows:write` and `workflows:create`.

## 3.6 Security

- **Credentials:** envelope encryption. Each record gets a data key (AES-256-GCM), wrapped by a KMS or master key from the environment. Credentials are never returned to the client, only `{id, app, label, status}`.
- **Sandbox:** isolate memory 64 to 128 MB, CPU timeout 10 s (Code node) or 30 s (Node Builder action). `fetch` is proxied: it blocks private IP ranges (SSRF guard) and caps response size.
- **HTTP Request node:** has the same SSRF guard.
- **Webhooks:**
  - Unguessable path segment (random 24 bytes).
  - Optional header or basic auth.
  - Per-endpoint rate limits.
- **Prompt injection:** workflow content, sample data, and fetched pages go to the LLM as delimited data. Builder tools can only write drafts.
- **Multi-tenancy:** every query is scoped by `workspaceId`, enforced in a repository layer and checked in tests.
- **Auth hardening:** OTP rate limits and lockout, CSRF via Auth.js, and optional TOTP 2FA.

## 3.7 Deployment

- **Local:** `docker compose` brings up Mongo (single-node replica set), Redis and MinIO. `pnpm dev` starts web, worker and mcp.
- **Production:**
  - web on Vercel or a container
  - worker and mcp as containers (Fly, Railway, ECS)
  - MongoDB Atlas, Upstash or Elasticache Redis, R2
