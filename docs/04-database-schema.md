# 4. Database schema (MongoDB)

All `_id` values are ObjectIds. All tenant data carries `workspaceId`. Timestamps (`createdAt`, `updatedAt`) are on every collection.

## users
```ts
{ _id, email (unique, lowercased), name, image,
  emailVerified: Date | null,
  authProviders: [{ provider: 'google'|'github'|'email', providerAccountId }],
  twoFactor: { enabled: boolean, secretEnc?: EncBlob, recoveryCodesHash?: string[] },
  locale: 'en'|'id'|'zh'|'es'|'pt'|..., layoutPref: 'horizontal'|'vertical',  //  layout toggle
  defaultWorkspaceId }
```
Index: `email` unique.

## accounts / sessions / verification_tokens
These follow the Auth.js MongoDB adapter shape. `verification_tokens` holds the hashed email OTP, its expiry, and an attempt counter.

## workspaces (teams )
```ts
{ _id, name, ownerId, personal }
```

## memberships
```ts
{ _id, workspaceId, userId, role: 'owner'|'admin'|'editor'|'viewer', invitedBy, status: 'active'|'invited' }
```
Indexes: `{workspaceId, userId}` unique.

## invitations
```ts
{ _id, workspaceId, email, role, tokenHash, expiresAt, acceptedAt }
```

## workflows 
```ts
{ _id, workspaceId, name (1..150), description?,
  status: 'draft'|'published'|'archived',              //  openapi enum
  revision: number,                                     //  optimistic concurrency (expectedRevision)
  draft: WorkflowGraph,                                 // auto-saved editor state
  publishedVersionId?: ObjectId, publishedAt?,
  settings: { timezone, errorWorkflowId?, executionTimeoutSec, saveSuccessfulRuns: boolean },
  tags: string[], folderId?, createdBy, updatedBy }
```
Indexes:
- `{workspaceId, updatedAt:-1}`
- `{workspaceId, status}`
- text index on `name`

```ts
type WorkflowGraph = {
  nodes: Array<{
    id: string,                 //  stable, e.g. 'node-send-reply'; distinct from label
    type: string,               //  namespaced, e.g. 'trigger.webhook', 'flow.if', 'ai.agent'
    typeVersion: number,
    label: string,
    parameters: Record<string, unknown>,   // expressions stored as strings
    credentialId?: ObjectId,
    position: { x: number, y: number },
    connections: Record<string /*sourceHandle*/, Array<{ targetId: string, targetHandle?: string }>>, // 
    disabled?: boolean, onError?: 'stop'|'continue'|'errorOutput',
    notes?: string
  }>,
  stickyNotes: Array<{ id, text, position, size, color }>,
  viewport: { x, y, zoom }
}
```

## workflow_versions
Immutable published snapshots.
```ts
{ _id, workflowId, workspaceId, revision, graph: WorkflowGraph, publishedBy, publishedAt, note? }
```
Index: `{workflowId, publishedAt:-1}`.

## workflow_history
Draft revisions, for undo across sessions and Builder diffs.
```ts
{ _id, workflowId, revision, source: 'editor'|'builder'|'mcp'|'api', changeSet, actorId, createdAt }
```
A TTL index keeps 30 days.

## triggers_registry
The active trigger bindings.
```ts
{ _id, workspaceId, workflowId, versionId, nodeId, kind: 'webhook'|'schedule'|'poll'|'app',
  webhook?: { pathKey (unique), method, authMode },
  schedule?: { cron, timezone, jobKey },
  poll?: { intervalSec, state: Record<string, unknown> },   // getValue/setValue KV
  app?: { appType, externalSubscriptionId, credentialId },
  active: boolean }
```
Indexes:
- `webhook.pathKey` unique sparse
- `{workflowId}`

## executions 
```ts
{ _id, workspaceId, workflowId, versionId?, mode: 'test'|'production'|'subworkflow'|'error',
  trigger: { nodeId, type, receivedAt },
  status: 'queued'|'running'|'waiting'|'success'|'failed'|'canceled',
  startedAt, finishedAt?, durationMs?,                    //  webhook payload fields
  error?: { nodeId, message, stack? },
  parentExecutionId?,
  resumeAt?, engineState?: Binary,                        // for Wait / resumable runs
  expiresAt: Date }                                       //  log retention (EXECUTION_RETENTION_DAYS, 7 by default)
```
Indexes:
- `{workspaceId, startedAt:-1}`
- `{workflowId, startedAt:-1}`
- TTL on `expiresAt`

## execution_steps
Kept separate so execution documents stay small.
```ts
{ _id, executionId, workspaceId, nodeId, attempt, status, startedAt, durationMs,
  inputPreview, output: { [handle]: Item[] } | { ref: 's3://...' },   // large outputs offloaded
  logs: string[], error? }
```
Indexes:
- `{executionId, startedAt}`
- TTL on `expiresAt`

## credentials 
```ts
{ _id, workspaceId, appType, label, authType: 'oauth2'|'apiKey'|'basic'|'custom'|'session',
  dataEnc: EncBlob,             // AES-256-GCM ciphertext, wrapped DEK, iv, tag
  oauth?: { scopes, expiresAt, refreshable: boolean },
  status: 'connected'|'expired'|'error', lastCheckedAt, createdBy }
```
The API and MCP responses only ever include `{_id, appType, label, status}`.

## custom_nodes (Node Builder )
```ts
{ _id, workspaceId, slug, name, description, icon, category, visibility: 'private'|'workspace'|'public',
  draft: CustomNodeSpec, publishedVersion?: number }
```

## custom_node_versions
```ts
{ _id, customNodeId, version, spec: CustomNodeSpec, publishedAt }
```

```ts
type CustomNodeSpec = {
  auth: Array<{ label, description, type: 'form'|'oauth2',
    fields?: Array<{ name, label, type, required }>,
    oauth2?: { authUrl, tokenUrl, refreshUrl, scopes, extraParams, pkce: boolean, userSuppliedClient: boolean } }>,
  triggers: Array<{ key, label, description, type: 'webhook'|'polling', parameters: ParamDef[],
    subscribeJs?, unsubscribeJs?, handlerJs?, pollerJs?, pollIntervalSec?, sampleOutput: unknown }>,
  actions: Array<{ key, label, enabled, parameters: ParamDef[], executeJs: string, sampleOutput: unknown }>
}
```


## api_keys
```ts
{ _id, workspaceId, name, prefix, hash (argon2), scopes, lastUsedAt, revokedAt }
```

## outbound_webhooks 
```ts
{ _id, workspaceId, url, secretEnc, events: ['workflow.execution.completed'], active }
```

## mcp_oauth_clients / mcp_oauth_grants 
```ts
clients: { _id, clientId, clientName, redirectUris[], createdAt }                 // dynamic registration
grants:  { _id, clientId, userId, workspaceId, scopes[], codeHash, codeChallenge, expiresAt,
           accessTokenHash, refreshTokenHash, revokedAt }
```

## builder_conversations
```ts
{ _id, workflowId, workspaceId, messages: [{ role, content, changeSetId?, createdAt }] }
```

## agent_memory
Per AI Agent session memory.
```ts
{ _id, workspaceId, workflowId, nodeId, sessionKey, messages: [...], updatedAt }
```
TTL is configurable.

## forms / chat_sessions
For the Form and Chat triggers.
```ts
forms: { _id, workflowId, nodeId, slug, fields: [...], theme }
chat_sessions: { _id, workflowId, sessionKey, messages, createdAt }
```

## notifications
```ts
{ _id, userId, workspaceId, type, payload, readAt }
```
