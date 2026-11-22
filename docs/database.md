# Database

MongoDB, running as a replica set (publishing uses transactions). Everything that belongs to a workspace has a `workspaceId`, and every query is scoped by it.

## Accounts and teams

| Collection | What's in it |
|---|---|
| `user`, `session`, `account`, `verification` | Better Auth's own tables: users, sign-in sessions, linked Google/GitHub logins, email codes |
| `user_two_factor`, `session_two_factor` | TOTP secrets and recovery codes, and which sessions have passed the second step |
| `workspaces` | `name`, `ownerId`, `personal` (everyone gets a personal one on first sign-in) |
| `memberships` | who's in which workspace, with a role: owner, admin, editor or viewer |
| `invitations` | pending invites. Only a SHA-256 hash of the link token is stored. Single use, expires after 7 days |

## Workflows and runs

| Collection | What's in it |
|---|---|
| `workflows` | name, the `draft` graph, `revision` (bumped on every save, used to catch two tabs editing at once), `publishedVersionId` |
| `workflow_versions` | frozen copies of the graph, one per publish. Live runs always use one of these |
| `triggers` | one row per live trigger: webhook/form/chat path, Telegram bot and secret, WhatsApp connection, next schedule time. Also short-lived rows for the editor's "listen for a test request" |
| `executions` | one per run: status, mode (test or live), the graph it ran, engine state, the webhook response if any, error, timings. Expires after `EXECUTION_RETENTION_DAYS` |
| `execution_steps` | one per step that ran: input, output (capped at 200 KB), logs, error, timing. Secrets are masked before saving. Expires with the run |
| `jobs` | the work queue: `runAt`, `status`, `lockedUntil` (the lease), `attempts` |
| `builder_conversations` | chat history with the AI builder, per workflow |
| `agent_memory` | the last N turns per agent step and conversation id |
| `seen_items` | what each "Only new items" step has already let through (hashed keys). Only live runs add to it; entries expire after 180 days. Incoming WhatsApp message ids go here too, so Meta's retries don't start a second run |
| `variables` | workspace variables (`${['$vars']['NAME']}`). Secret values are encrypted the same way as saved accounts |

## Connected apps

| Collection | What's in it |
|---|---|
| `credentials` | saved accounts. The secret part is encrypted (AES-256-GCM, see [how it works](how-it-works.md#connected-apps)). Plain fields: app, label, account email, status, token expiry |
| `oauth_states` | in-progress Google sign-ins: state, PKCE verifier, and which account to update when reconnecting. Gone after 10 minutes |

## Platform

| Collection | What's in it |
|---|---|
| `api_keys` | hashed keys with a short visible prefix, scopes, last-used time |
| `outbound_webhooks`, `webhook_deliveries` | your webhook endpoints (signing secret encrypted) and the delivery attempts, with retries |
| `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_grants` | the MCP server's OAuth: registered AI assistants, short-lived codes, and grants with rotating refresh tokens |

Indexes get created on startup (`ensure*Indexes` in each module), so a fresh database just works.
