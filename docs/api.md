# API

Two kinds of API:

- **The app's own API** (`/api/*`), used by the frontend. It authenticates with your session cookie.
- **The public API** (`/api/v1/*`), for scripts and other apps. It takes `Authorization: Bearer <api key>`. Make keys under Settings. Scopes: `workflows:read`, `workflows:write` (used by the MCP server), `executions:read`, `executions:run`.

Errors always look like `{ "error": "not_found", "message": "Workflow not found" }`. The codes are `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `revision_conflict`, `rate_limited` and `validation_failed`.

## Public API (v1)

| | | Scope |
|---|---|---|
| `GET /api/v1/workflows` | list workflows | `workflows:read` |
| `GET /api/v1/workflows/:id` | one workflow, with its graph | `workflows:read` |
| `POST /api/v1/workflows/:id/run` | run the published version with `{ input }`. Returns `202 { executionId }`, or 409 if it isn't published | `executions:run` |
| `GET /api/v1/executions`, `/api/v1/executions/:id` | run history and details | `executions:read` |

## App API

**Workflows**
- `GET/POST /api/workflows`, then `GET/PATCH/DELETE /api/workflows/:id`
- `PUT /api/workflows/:id/draft`: save the graph. Send `expectedRevision`; you get a 409 if someone saved in between
- `POST /api/workflows/:id/duplicate`
- `GET /api/workflows/:id/versions`: every published version. `POST /api/workflows/:id/versions/:versionId/restore` copies one back into the draft (what's live doesn't change until you publish)
- `GET /api/workflows/:id/export`: the workflow as a `.conduit.json` file, with picked accounts cleared. `POST /api/workflows/import` creates a workflow from one
- `POST` / `DELETE /api/workflows/:id/publish`: go live / stop. `GET` lists the live triggers and their URLs
- `POST /api/workflows/:id/test`: test run from a trigger
- `POST/GET/DELETE /api/workflows/:id/test/listen`: arm, check or cancel a one-shot test webhook URL
- `POST /api/workflows/:id/builder`: send the AI builder a message; the change is saved as a new draft revision. `GET` returns the chat so far, `DELETE` clears it

**Runs**
- `GET /api/overview`: the home page numbers (live runs per day for a week, busiest workflows, latest failures)
- `GET /api/executions`, `GET /api/executions/:id`
- `GET /api/executions/:id/stream`: live updates while a run is going (server-sent events)
- `POST /api/executions/:id/cancel`, `POST /api/executions/:id/retry`

**Connected apps**
- `GET/POST /api/credentials`, `GET/PATCH/DELETE /api/credentials/:id`. Deleting an account a live workflow uses asks for confirmation
- `PUT /api/credentials/:id`: new keys for a key-based account. Empty fields keep what's saved, and it's checked before saving
- `POST /api/credentials/:id/test`: check an account still works
- `GET /api/credentials/oauth/:app/start`: start a Google sign-in (`?reconnect=<id>` to renew an existing one), which comes back to `/api/credentials/oauth/callback`
- `POST /api/nodes/options`: dropdown options that come from an app (Slack channels, sheet tabs)

**Workspace and team**
- `GET/PATCH /api/workspace` (rename), `GET/POST /api/workspaces`, `POST /api/workspaces/switch`
- `GET /api/workspace/members`, `PATCH/DELETE /api/workspace/members/:userId`
- `POST /api/workspace/invitations`, `DELETE /api/workspace/invitations/:id`, `POST /api/invitations/accept`
- `GET/POST /api/workspace/api-keys`, `DELETE /api/workspace/api-keys/:id`
- `GET/POST /api/workspace/variables`, `PATCH/DELETE /api/workspace/variables/:id`: workspace variables. Secret values are never returned
- `GET/POST /api/workspace/webhooks`, `DELETE /api/workspace/webhooks/:id`, `POST /api/workspace/webhooks/:id/test`

**Account**
- `/api/auth/*`: Better Auth (email codes, Google/GitHub sign-in)
- `/api/account/2fa/*`: set up, enable, verify and turn off two-step sign-in

## Public endpoints (no sign-in)

- `/hook/:path`: live webhooks. `/hook-test/:path` is the editor's one-shot test URL
- `/hook/telegram/:path`: Telegram updates in webhook mode. It checks Telegram's secret header
- `/hook/whatsapp/:connectionId`: WhatsApp Cloud API webhooks. `GET` is Meta's verify handshake (checks the connection's verify token); `POST` needs a valid `X-Hub-Signature-256` made with the app secret. Each message id starts at most one run
- `POST /api/forms/:path`: hosted form submissions
- `POST /api/chat/:path` sends a chat message (`{ sessionId, message }` gives `{ runId }`). `GET /api/chat/:path?run=&session=` gets the reply
- `GET /api/health`

## MCP server

`/api/mcp` speaks MCP over HTTP, so assistants like Claude Desktop can work with your workflows. Auth is OAuth 2.1 (discovery at `/.well-known/oauth-authorization-server`, dynamic client registration, PKCE, rotating refresh tokens), and you approve each assistant on a consent page.

Tools: `list_workflows`, `get_workflow`, `find_steps`, `describe_step`, `create_workflow`, `apply_changes` (draft only), `test_workflow` and `get_execution`. It can't publish anything. The assistant does its own thinking, and the server does no AI calls itself.
