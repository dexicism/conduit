# 5. API specification

## 5.1 Conventions

| Topic | Convention |
|-------|-----------|
| Session API | `/api/*` uses the session cookie, is workspace-scoped through the `x-workspace-id` header or the user's default workspace, and needs CSRF protection on mutations |
| Public API | `/v1/*` uses `Authorization: Bearer <api_key>` (`/v1/workflows` list, create, delete) |
| Errors | `{ "error": "<code>", "message": "..." }`. Codes: `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `revision_conflict`, `insufficient_credits`, `rate_limited`, `validation_failed` |
| Pagination | `?limit=1..100 (default 20)&cursor=` returns `{ data, nextCursor }` [V] |
| Concurrency | Graph writes need `expectedRevision`. A mismatch returns `409 revision_conflict` with `{ currentRevision }` |

## 5.2 Auth

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/auth/*` | Auth.js: Google, GitHub, and the email OTP provider |
| POST | `/api/auth/otp/request` | `{email}` sends a code. Returns 202 whether or not the account exists, so emails can't be enumerated |
| POST | `/api/auth/otp/verify` | `{email, code}` creates a session. Locks out after 5 attempts |
| POST | `/api/auth/2fa/setup` | Returns an `otpauth://` URL and a QR code |
| POST | `/api/auth/2fa/verify` | `{code}` |
| POST | `/api/auth/2fa/disable` | `{code}` |

## 5.3 Workflows

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/workflows` | `?q&filter=active\|archived&limit&cursor`. Tag filtering comes later |
| POST | `/api/workflows` | `{name, description?, requestId?}` → 201 Workflow, or 200 with the original when the same `requestId` is replayed |
| POST | `/api/workflows/:id/duplicate` | → 201, the copy is named "<name> (copy)" |
| GET | `/api/workflows/:id` | Workflow with `draft`, `revision`, `status`, plus `setupActions` (missing connections) |
| PATCH | `/api/workflows/:id` | `{name?, description?, archived?}` (implemented). `settings` and `tags` come later |
| PUT | `/api/workflows/:id/draft` | `{expectedRevision, graph}`. The editor's auto-save (debounced, 800 ms). Returns `{revision}` |
| POST | `/api/workflows/:id/changes` | `{expectedRevision, changes:{nodes,updates,deleted}}`. Applies a change set (shared by the Builder and MCP) |
| POST | `/api/workflows/:id/validate` | `{changes}` → `{ok, issues[]}`. Read-only |
| POST | `/api/workflows/:id/publish` | `{note?}`: snapshot, (re)register triggers. Returns `{versionId, revision}` |
| POST | `/api/workflows/:id/unpublish` | Deactivates triggers |
| POST | `/api/workflows/:id/duplicate` | |
| DELETE | `/api/workflows/:id` | **Permanent delete → 204** (the UI confirms first). Reversible removal is done by archiving: `PATCH {archived:true}` |
| GET | `/api/workflows/:id/versions` | Version history |
| POST | `/api/workflows/:id/versions/:vid/restore` | Copies the snapshot into the draft |

## 5.4 Executions

> **Implemented.**
>
> - `POST /api/workflows/:id/test` `{triggerNodeId?, expectedRevision?}` → 202 `{executionId}`
> - `POST|GET|DELETE /api/workflows/:id/test/listen` → arm, poll or stop the one-shot test URL `/hook-test/:path` (lives 120 s)
> - `GET|POST|DELETE /api/workflows/:id/publish` → status, publish, unpublish.
>   - Publishing returns 400 with `issues` when the workflow is incomplete, and 409 on a webhook path clash.
> - `GET /api/executions?workflowId&status&mode&limit&cursor`
> - `GET /api/executions/:id`, `POST /api/executions/:id/cancel`, `POST /api/executions/:id/retry`
> - `GET /api/executions/:id/stream` (SSE `step` and `status` events)
> - `ANY /hook/:path` and `/hook-test/:path` → 202 `{executionId}`, the Respond step's response, 401 (header auth), 405 (wrong method) or 404
> - `GET /api/health`
>
> The original plan follows.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/workflows/:id/test` | `{startNodeId?, pinnedData?, triggerPayload?}` → `{executionId}`. Test mode (free except paid AI) |
| POST | `/api/workflows/:id/test/listen` | Arms the test webhook URL for 120 s → `{testUrl}` |
| GET | `/api/executions` | `?workflowId&status&mode&limit&cursor` |
| GET | `/api/executions/:id` | Execution plus step summaries |
| GET | `/api/executions/:id/steps/:nodeId` | Full output for one node |
| GET | `/api/executions/:id/stream` | **SSE** events: `step.started`, `step.finished`, `execution.finished` |
| POST | `/api/executions/:id/cancel` | |
| POST | `/api/executions/:id/retry` | `{from:'start'|'failedNode'}` |

## 5.5 Trigger ingress (public)

| Method | Path | Notes |
|---|---|---|
| ANY | `/hook/:pathKey` | Production webhook. Returns 202 `{executionId}`, or the Respond node's payload if the workflow responds synchronously (timeout 30 s) |
| ANY | `/hook-test/:pathKey` | Active only while the editor is listening |
| GET/POST | `/f/:formSlug` | Hosted form page and its submission |
| POST | `/c/:workflowId/messages` | Chat trigger endpoint, SSE stream reply |
| POST | `/apps/:appType/events` | Provider callbacks (Telegram, WABA, and others) routed to triggers |

## 5.6 Nodes catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/api/nodes?q=&category=` | Search the registry (built-in plus workspace custom nodes) |
| GET | `/api/nodes/:type?action=` | Full descriptor: param zod→JSON schema, defaults, conditional display rules, handles, sample output, credit cost, and the expression syntax for this node |
| POST | `/api/nodes/:type/options` | Dynamic dropdowns (e.g. list a spreadsheet's tabs) using a credential |

## 5.7 Credentials (Connected Apps)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/credentials?appType=` | `{_id, appType, label, status}` only |
| POST | `/api/credentials` | `{appType, label, data}` for API-key or form auth |
| GET | `/api/credentials/oauth/:appType/start` | → redirect. `?returnTo=` returns to the editor or chat |
| GET | `/api/credentials/oauth/:appType/callback` | |
| POST | `/api/credentials/:id/test` | Health check |
| DELETE | `/api/credentials/:id` | Blocked (409) if a published workflow uses it, unless `?force=1` |

As built:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/credentials?app=` | `{credentials: [{id, app, label, account, status, lastError, testedAt, createdAt}], apps}`. `apps` lists only the apps this server can connect. Secrets are never returned |
| POST | `/api/credentials` | `{app, label, values}`. Checks the account against the app first (400 `Couldn't connect: …`) and only saves it if that works |
| GET | `/api/credentials/:id` | One account plus `usage: {workflows, published}` |
| PATCH | `/api/credentials/:id` | `{label}` |
| DELETE | `/api/credentials/:id` | 409 `in_use` when a published workflow uses it; `?force=1` removes it anyway |
| POST | `/api/credentials/:id/test` | Runs the health check and records `status` and `lastError` |
| GET | `/api/credentials/oauth/:app/start?label=` | Saves the state and PKCE verifier for the signed-in user (10 min, single use), then redirects to the provider |
| GET | `/api/credentials/oauth/callback` | Exchanges the code, saves the account, and redirects to `/app/connections/done` |
| POST | `/api/nodes/options` | `{source: "slack.channels" \| "google.sheets", credentialId, params}` → `{options}` |
| POST | `/hook/telegram/:path` | Telegram updates. Requires the `X-Telegram-Bot-Api-Secret-Token` set at publish (otherwise 401) |

## 5.7b Workspaces, teams and billing

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspaces` | `{current, workspaces: [{id, name, role, plan}]}` |
| POST | `/api/workspaces` | `{name}` creates a team (caller is owner) and makes it current |
| POST | `/api/workspaces/switch` | `{workspaceId}`; 403 if not a member. Sets the `conduit_ws` cookie |
| GET / PATCH | `/api/workspace` | Current workspace; PATCH `{name}` (owner/admin) |
| GET | `/api/workspace/members` | `{members, invitations}` (invitations for owner/admin only) |
| PATCH / DELETE | `/api/workspace/members/:userId` | `{role}`; DELETE removes, or leaves when it's you. The last owner can't be removed or demoted |
| POST | `/api/workspace/invitations` | `{email, role}`; emails a single-use link. Limited by the plan's member count |
| DELETE | `/api/workspace/invitations/:id` | Cancels a pending invitation |
| POST | `/api/invitations/accept` | `{token}`; the signed-in email must match. Joins and switches to the workspace |
| GET | `/api/billing` | Plan, plans, balances, credit history, invoices (owner/admin), `billingEnabled` |
| POST | `/api/billing/checkout` | `{plan}` → `{url}` (Stripe Checkout). The plan changes when the webhook arrives |
| POST | `/api/billing/portal` | → `{url}` (Stripe customer portal) |
| POST | `/api/billing/webhook` | Stripe events; signature required |

## 5.7c Public API, webhooks, forms and MCP

**Public API v1.** Authenticate with `Authorization: Bearer cdt_…` (workspace API key). Browser sessions aren't accepted here, and API keys aren't accepted anywhere else.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/api/v1/workflows` | workflows:read | Same query and response as `/api/workflows` |
| GET | `/api/v1/workflows/:id` | workflows:read | Includes the draft |
| POST | `/api/v1/workflows/:id/run` | executions:run | `{input}` → 202 `{executionId}`. Runs the published version from its Manual trigger (or first trigger); 409 if unpublished. Uses credits |
| GET | `/api/v1/executions` | executions:read | |
| GET | `/api/v1/executions/:id` | executions:read | Steps with input and output |

**Management** (session; owner or admin):
- `GET/POST /api/workspace/api-keys`, `DELETE /api/workspace/api-keys/:id`. The full key is returned once.
- `GET/POST /api/workspace/webhooks`, `DELETE /api/workspace/webhooks/:id`, `POST /api/workspace/webhooks/:id/test`. The signing secret is returned once.

**Outbound events.** `execution.completed` and `execution.failed` are sent for live runs, with these headers:
- `Conduit-Event`
- `Conduit-Delivery`
- `Conduit-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`

Failed deliveries are retried after 1m, 5m, 30m, 2h and 12h.

**Forms.** A published Form trigger serves `GET /form/:path` (a public page). Submissions go to `POST /api/forms/:path` as `{values}`, which returns 400 with `fields` errors when validation fails, and otherwise starts a live run.

**MCP.** `POST /api/mcp` takes JSON-RPC 2.0 over Streamable HTTP, protocol 2025-06-18.
- **Auth:** an OAuth access token or an API key. Without one, the server answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
- **Tools:** `list_workflows`, `get_workflow`, `find_steps`, `describe_step`, `create_workflow`, `apply_changes` (draft only, `expectedRevision` required), `test_workflow`, `get_execution`. Each is filtered by scope.

**OAuth 2.1** (for MCP clients):
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
- `POST /api/oauth/register` (RFC 7591; https, or http on localhost)
- `GET /oauth/authorize`: a consent page where the user picks the workspace. Code + S256 PKCE are required.
- `POST /api/oauth/token`: `authorization_code` or `refresh_token`. Refresh tokens rotate, and reusing one revokes the grant.
- `POST /api/oauth/revoke`

Scopes: `workflows:read`, `workflows:write`, `executions:read` and `executions:run`. Viewers get only the read scopes.

## 5.8 Builder (AI)

| Method | Path | Notes |
|---|---|---|
As built (replaces the earlier plan of SSE and a server-side undo endpoint):

| Method | Path | Notes |
|---|---|---|
| POST | `/api/workflows/:id/builder` | `{message, expectedRevision}` → `{message, steps, applied: {graph, summary, revision} \| null}`. Saves the result as a new draft revision. 400 on an empty message or when no AI provider is configured, 403 for viewers, 409 on a stale revision |
| GET | `/api/workflows/:id/builder` | Conversation history (last 40 messages) |
| DELETE | `/api/workflows/:id/builder` | Clears the conversation |

Undo happens in the editor: the applied change is one undo step, and auto-save persists the reverted draft.

## 5.9 Node Builder

| Method | Path |
|---|---|
| GET, POST | `/api/custom-nodes` |
| GET, PUT, DELETE | `/api/custom-nodes/:id` (draft spec) |
| POST | `/api/custom-nodes/:id/test/action/:key` → `{output, logs, error}` |
| POST | `/api/custom-nodes/:id/test/trigger/:key` (poll once, or `listen` for a webhook) |
| POST | `/api/custom-nodes/:id/publish` → version |

## 5.10 Workspace, team, billing

| Method | Path |
|---|---|
| GET, PATCH | `/api/workspaces/:id` |
| GET, POST, DELETE | `/api/workspaces/:id/members`, `/invitations` |
| GET | `/api/billing/usage` → balances per pool, concurrency, retention |
| GET | `/api/billing/plans` |
| POST | `/api/billing/checkout` `{plan, interval}` → provider URL |
| POST | `/api/billing/webhook/:provider` |
| GET | `/api/billing/invoices` (downloadable) |
| GET, POST, DELETE | `/api/api-keys` |
| GET, POST, DELETE | `/api/outbound-webhooks` |

## 5.11 Public API v1

- `GET /v1/workflows?limit&cursor` → `{data: Workflow[], nextCursor}`
- `POST /v1/workflows` `{name, description?, isActive?=false}` → 201
- `DELETE /v1/workflows/{workflowId}` → 204
- Ours on top: `GET /v1/workflows/{id}`, `POST /v1/workflows/{id}/run`, `GET /v1/executions/{id}`
- Outbound event `workflow.execution.completed`:
  - Payload: `{event, executionId, workflowId, status: success|failed, durationMs, timestamp}`
  - Signed with `X-Conduit-Signature: sha256=<hmac>`

## 5.12 MCP server (`apps/mcp`)

**Transport.** Streamable HTTP at `/`.

**OAuth discovery:**
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- Endpoints: `authorize`, `token`, `register` (dynamic), `revoke`
- PKCE S256, public clients, refresh tokens
- Scopes `workflows:read`, `workflows:write`, `workflows:create`

| Tool | Scope | Behavior |
|---|---|---|
| `list_workflows` | read | Search and offset. Has a picker UI resource |
| `get_workflow` | read | Draft with credentials redacted, revision, and setup actions |
| `show_workflow` | read | UI resource preview with Connect buttons |
| `create_workflow` | create | `{name, requestId}`, idempotent |
| `find_nodes` / `get_node_schema` | none beyond auth | Catalog |
| `check_changes` | read | Validates only |
| `save_changes` | write | Validates and saves the **draft only**. Never runs or publishes |
| `connection_status` | read | Which apps are connected, as booleans only |

The server does no inference of its own and charges no credits.
