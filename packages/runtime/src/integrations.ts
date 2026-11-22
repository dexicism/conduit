import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkDiscordWebhook, mailchimpAuth, mailchimpBase, ntfyServer, StepError, type HttpRequest, type HttpResponse, type IntegrationServices, type MailMessage, type SqlResult } from "@conduit/engine";
import { getApp, secretFieldNames, type AppDefinition, type DynamicOptionsSource, type OAuthProviderId } from "@conduit/nodes";
import { ObjectId, type Db } from "mongodb";
import nodemailer from "nodemailer";
import pg from "pg";
import { isPrivateAddress } from "./net";
import { fetchAccountEmail, refreshTokens, type OAuthClient, type TokenSet } from "./oauth";
import type { SealedSecret, Vault } from "./vault";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface CredentialDoc {
  _id: ObjectId;
  workspaceId: ObjectId;
  app: string;
  label: string;
  /** Non-secret description shown in lists, e.g. the account email or host. */
  account: string | null;
  secret: SealedSecret;
  status: "ok" | "error";
  lastError: string | null;
  testedAt: Date | null;
  /** OAuth access-token expiry. */
  expiresAt: Date | null;
  /** Bumped on every secret change (refresh compare-and-set). */
  version: number;
  refreshLockUntil: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CredentialView {
  id: string;
  app: string;
  label: string;
  account: string | null;
  status: "ok" | "error";
  lastError: string | null;
  testedAt: string | null;
  createdAt: string;
}

export interface OAuthStateDoc {
  _id: string;
  userId: string;
  workspaceId: ObjectId;
  app: string;
  label: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: Date;
  /** Reconnecting: the saved account to give the new tokens to (keeps workflows pointing at it). */
  reconnectId?: string;
}

export function credentialCollections(db: Db) {
  return {
    credentials: db.collection<CredentialDoc>("credentials"),
    oauthStates: db.collection<OAuthStateDoc>("oauth_states"),
  };
}

export async function ensureCredentialIndexes(db: Db) {
  const c = credentialCollections(db);
  await Promise.all([
    c.credentials.createIndex({ workspaceId: 1, app: 1, createdAt: -1 }),
    c.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

export function toCredentialView(d: CredentialDoc): CredentialView {
  return {
    id: d._id.toHexString(),
    app: d.app,
    label: d.label,
    account: d.account,
    status: d.status,
    lastError: d.lastError,
    testedAt: d.testedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Non-secret summary of a fields-auth credential. */
function accountSummary(app: AppDefinition, values: Record<string, string>): string | null {
  switch (app.id) {
    case "postgres":
      return `${values.user}@${values.host}/${values.database}`;
    case "smtp":
      return values.from ?? values.host ?? null;
    case "httpHeader":
      return values.headerName ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Network guard for drivers (databases, SMTP) that don't go through `http`
// ---------------------------------------------------------------------------

/** Resolves a host and returns an address that's safe to connect to (checked once, then connected to directly). */
export async function resolveSafeHost(host: string, allowPrivate: boolean): Promise<string> {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (!h) throw new StepError("Host is empty");
  const addresses = isIP(h) ? [h] : (await lookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new StepError(`Couldn't find the host ${h}`);
  if (!allowPrivate) {
    const bad = addresses.find((a) => isPrivateAddress(a));
    if (bad) throw new StepError(`Blocked connection to a private network address (${h})`);
  }
  return addresses[0]!;
}

function toJsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJsonSafe(x)]));
  return v;
}

const MAX_SQL_ROWS = 10_000;

export async function runPostgres(
  cfg: Record<string, string>,
  sql: string,
  values: unknown[],
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<SqlResult> {
  const host = cfg.host ?? "";
  const address = await resolveSafeHost(host, allowPrivate);
  const ssl =
    cfg.ssl === "disable" ? false : cfg.ssl === "no-verify" ? { rejectUnauthorized: false } : { rejectUnauthorized: true, servername: isIP(host) ? undefined : host };
  const client = new pg.Client({
    host: address,
    port: Number(cfg.port || 5432),
    database: cfg.database,
    user: cfg.user,
    password: cfg.password ?? "",
    ssl,
    connectionTimeoutMillis: Math.min(timeoutMs, 15_000),
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs + 1000,
    application_name: "conduit",
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const res = await client.query({ text: sql, values: values as unknown[] });
    const rows = (res.rows ?? []) as Record<string, unknown>[];
    if (rows.length > MAX_SQL_ROWS) throw new StepError(`The query returned more than ${MAX_SQL_ROWS} rows. Add a LIMIT.`);
    return { rows: rows.map((r) => toJsonSafe(r) as Record<string, unknown>), rowCount: res.rowCount ?? rows.length, command: res.command };
  } catch (err) {
    if (err instanceof StepError) throw err;
    const e = err as Error & { code?: string };
    throw new StepError(`PostgreSQL: ${e.message}${e.code ? ` (${e.code})` : ""}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function sendSmtp(cfg: Record<string, string>, msg: MailMessage | null, allowPrivate: boolean) {
  const host = cfg.host ?? "";
  const address = await resolveSafeHost(host, allowPrivate);
  const security = cfg.security ?? "starttls";
  const transport = nodemailer.createTransport({
    host: address,
    port: Number(cfg.port || (security === "tls" ? 465 : 587)),
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    tls: { servername: isIP(host) ? undefined : host },
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    if (!msg) {
      await transport.verify();
      return null;
    }
    const info = await transport.sendMail({ from: cfg.from, ...msg });
    const list = (v: unknown) => (Array.isArray(v) ? v.map((a) => (typeof a === "string" ? a : String((a as { address?: string }).address))) : []);
    return { messageId: String(info.messageId), accepted: list(info.accepted), rejected: list(info.rejected) };
  } catch (err) {
    throw new StepError(`Email: ${(err as Error).message}`);
  } finally {
    transport.close();
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Http = (req: HttpRequest) => Promise<HttpResponse>;

export interface IntegrationsConfig {
  vault: Vault;
  http: Http;
  allowPrivateNetwork: boolean;
  /** Development and tests only: send every app API call to this server instead (`<base>/<host><path>`). */
  apiBaseOverride?: string;
  oauthClients: Partial<Record<OAuthProviderId, OAuthClient>>;
}

/** Refresh an access token this long before it expires. */
const REFRESH_SKEW_MS = 60_000;

export function createIntegrations(db: Db, cfg: IntegrationsConfig) {
  const c = credentialCollections(db);

  const apiUrl = (url: string) => {
    if (!cfg.apiBaseOverride) return url;
    const u = new URL(url);
    return `${cfg.apiBaseOverride.replace(/\/$/, "")}/${u.host}${u.pathname}${u.search}`;
  };

  /** Apps that can be connected on this server. OAuth apps need client credentials. */
  function availableApps(): string[] {
    const ids = ["telegram", "slack", "whatsapp", "google", "notion", "airtable", "discord", "github", "trello", "todoist", "mailchimp", "ntfy", "postgres", "smtp", "httpHeader"];
    return ids.filter((id) => {
      const app = getApp(id)!;
      return app.auth.kind === "fields" || Boolean(cfg.oauthClients[app.auth.provider]);
    });
  }

  function secretsOf(app: AppDefinition, values: Record<string, string>): string[] {
    const names = app.auth.kind === "oauth2" ? ["accessToken", "refreshToken"] : secretFieldNames(app);
    return names.map((n) => values[n]).filter((v): v is string => typeof v === "string" && v.length >= 4);
  }

  async function create(input: {
    workspaceId: ObjectId;
    userId: string;
    app: string;
    label: string;
    values: Record<string, string>;
    account?: string | null;
    expiresAt?: Date | null;
  }): Promise<CredentialDoc> {
    const app = getApp(input.app);
    if (!app) throw new Error(`Unknown app ${input.app}`);
    const now = new Date();
    const _id = new ObjectId();
    const doc: CredentialDoc = {
      _id,
      workspaceId: input.workspaceId,
      app: app.id,
      label: input.label,
      account: input.account ?? accountSummary(app, input.values),
      secret: cfg.vault.seal(input.workspaceId, _id, input.values),
      status: "ok",
      lastError: null,
      testedAt: null,
      expiresAt: input.expiresAt ?? null,
      version: 1,
      refreshLockUntil: null,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    };
    await c.credentials.insertOne(doc);
    return doc;
  }

  function find(workspaceId: ObjectId, id: string) {
    if (!ObjectId.isValid(id)) return Promise.resolve(null);
    return c.credentials.findOne({ _id: new ObjectId(id), workspaceId });
  }

  async function list(workspaceId: ObjectId, app?: string): Promise<CredentialView[]> {
    const docs = await c.credentials.find({ workspaceId, ...(app ? { app } : {}) }, { sort: { createdAt: -1 }, limit: 500 }).toArray();
    return docs.map(toCredentialView);
  }

  /** Reconnecting an OAuth account: new tokens (and permissions) for the same saved account. */
  async function replaceTokens(workspaceId: ObjectId, id: string, input: { values: Record<string, string>; account: string | null; expiresAt: Date | null }) {
    const doc = await find(workspaceId, id);
    if (!doc) return null;
    await c.credentials.updateOne(
      { _id: doc._id },
      {
        $set: {
          secret: cfg.vault.seal(doc.workspaceId, doc._id, input.values),
          account: input.account ?? doc.account ?? null,
          expiresAt: input.expiresAt,
          refreshLockUntil: null,
          status: "ok",
          lastError: null,
          testedAt: new Date(),
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
    );
    return find(workspaceId, id);
  }

  async function storeTokens(doc: CredentialDoc, tokens: TokenSet, prev: Record<string, string>) {
    const values = { ...prev, accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
    await c.credentials.updateOne(
      { _id: doc._id, version: doc.version },
      {
        $set: {
          secret: cfg.vault.seal(doc.workspaceId, doc._id, values),
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
          refreshLockUntil: null,
          status: "ok",
          lastError: null,
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
    );
    return values;
  }

  /** Decrypts a credential, refreshing its OAuth token first when it's about to expire. One refresher wins; others wait for it. */
  async function resolve(workspaceId: ObjectId, id: string, appId: string): Promise<{ app: AppDefinition; values: Record<string, string> }> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const doc = await find(workspaceId, id);
      if (!doc) throw new StepError("The connected account for this step doesn't exist in this workspace. Choose another one.");
      if (doc.app !== appId) throw new StepError(`This step needs a ${getApp(appId)?.name ?? appId} account`);
      const app = getApp(doc.app)!;
      const values = cfg.vault.open(doc.workspaceId, doc._id, doc.secret);
      const needsRefresh = app.auth.kind === "oauth2" && doc.expiresAt && doc.expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
      if (!needsRefresh || app.auth.kind !== "oauth2") return { app, values };

      const now = new Date();
      const locked = await c.credentials.findOneAndUpdate(
        { _id: doc._id, version: doc.version, $or: [{ refreshLockUntil: null }, { refreshLockUntil: { $lt: now } }] },
        { $set: { refreshLockUntil: new Date(now.getTime() + 30_000) } },
        { returnDocument: "after" },
      );
      if (!locked) {
        await new Promise((r) => setTimeout(r, 250)); // someone else is refreshing
        continue;
      }
      const client = cfg.oauthClients[app.auth.provider];
      try {
        if (!client) throw new StepError(`${app.name} sign-in isn't configured on this server`);
        if (!values.refreshToken) throw new StepError(`The ${app.name} sign-in expired. Reconnect the account.`);
        const tokens = await refreshTokens(cfg.http, apiUrl, app.auth.provider, client, values.refreshToken);
        return { app, values: await storeTokens(locked, tokens, values) };
      } catch (err) {
        const message = (err as Error).message;
        await c.credentials.updateOne({ _id: doc._id }, { $set: { refreshLockUntil: null, status: "error", lastError: message } });
        throw err instanceof StepError ? err : new StepError(message);
      }
    }
    throw new StepError("Timed out waiting for the account's sign-in to refresh");
  }

  /** Services for one execution. Every secret it opens is added to `secrets` so the runtime can redact it. */
  function servicesFor(workspaceId: ObjectId, secrets: Set<string>): IntegrationServices {
    return {
      apiUrl,
      async credential(id, app) {
        const r = await resolve(workspaceId, id, app);
        for (const s of secretsOf(r.app, r.values)) secrets.add(s);
        return r.values;
      },
      sqlQuery: (conf, sql, values, timeoutMs) => runPostgres(conf, sql, values, timeoutMs, cfg.allowPrivateNetwork),
      async sendMail(conf, msg) {
        return (await sendSmtp(conf, msg, cfg.allowPrivateNetwork))!;
      },
    };
  }

  async function callApi(req: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) {
    return cfg.http({
      method: req.method,
      url: apiUrl(req.url),
      headers: { accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...(req.headers ?? {}) },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      timeoutMs: 20_000,
    });
  }

  /** Checks that the account works. Returns a short description of the account, or throws. */
  async function check(appId: string, values: Record<string, string>): Promise<string | null> {
    switch (appId) {
      case "telegram": {
        const res = await callApi({ method: "GET", url: `https://api.telegram.org/bot${values.botToken}/getMe` });
        const b = res.body as { ok?: boolean; description?: string; result?: { username?: string } };
        if (!b?.ok) throw new StepError(`Telegram: ${b?.description ?? `status ${res.status}`}`);
        return b.result?.username ? `@${b.result.username}` : null;
      }
      case "slack": {
        const res = await callApi({ method: "POST", url: "https://slack.com/api/auth.test", headers: { authorization: `Bearer ${values.botToken}` } });
        const b = res.body as { ok?: boolean; error?: string; team?: string; user?: string };
        if (!b?.ok) throw new StepError(`Slack: ${b?.error ?? `status ${res.status}`}`);
        return b.team ? `${b.user ?? "bot"} in ${b.team}` : null;
      }
      case "whatsapp": {
        const res = await callApi({
          method: "GET",
          url: `https://graph.facebook.com/v21.0/${encodeURIComponent(values.phoneNumberId ?? "")}?fields=display_phone_number,verified_name`,
          headers: { authorization: `Bearer ${values.accessToken}` },
        });
        const b = res.body as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
        if (res.status >= 400) throw new StepError(`WhatsApp: ${b?.error?.message ?? `status ${res.status}`}`);
        return [b.verified_name, b.display_phone_number].filter(Boolean).join(" ") || null;
      }
      case "google": {
        const email = await fetchAccountEmail(cfg.http, apiUrl, "google", values.accessToken ?? "");
        if (!email) throw new StepError("Google rejected the sign-in. Reconnect the account.");
        return email;
      }
      case "notion": {
        const res = await callApi({ method: "GET", url: "https://api.notion.com/v1/users/me", headers: { authorization: `Bearer ${values.token}`, "notion-version": "2022-06-28" } });
        const b = res.body as { name?: string; message?: string };
        if (res.status >= 400) throw new StepError(`Notion: ${b?.message ?? `status ${res.status}`}`);
        return b.name ?? null;
      }
      case "airtable": {
        const res = await callApi({ method: "GET", url: "https://api.airtable.com/v0/meta/whoami", headers: { authorization: `Bearer ${values.token}` } });
        const b = res.body as { email?: string; error?: { message?: string } | string };
        if (res.status >= 400) throw new StepError(`Airtable: ${typeof b?.error === "object" ? b.error?.message : (b?.error ?? `status ${res.status}`)}`);
        return b.email ?? null;
      }
      case "discord": {
        const res = await callApi({ method: "GET", url: checkDiscordWebhook(values.webhookUrl ?? "") });
        const b = res.body as { name?: string; message?: string };
        if (res.status >= 400) throw new StepError(`Discord: ${b?.message ?? `status ${res.status}`}`);
        return b.name ? `webhook "${b.name}"` : null;
      }
      case "github": {
        const res = await callApi({ method: "GET", url: "https://api.github.com/user", headers: { authorization: `Bearer ${values.token}`, accept: "application/vnd.github+json" } });
        const b = res.body as { login?: string; message?: string };
        if (res.status >= 400) throw new StepError(`GitHub: ${b?.message ?? `status ${res.status}`}`);
        return b.login ? `@${b.login}` : null;
      }
      case "trello": {
        const qs = new URLSearchParams({ key: values.apiKey ?? "", token: values.token ?? "", fields: "username,fullName" });
        const res = await callApi({ method: "GET", url: `https://api.trello.com/1/members/me?${qs}` });
        const b = res.body as { username?: string } | string;
        if (res.status >= 400) throw new StepError(`Trello: ${typeof b === "string" ? b : `status ${res.status}`}`);
        return typeof b === "object" && b.username ? `@${b.username}` : null;
      }
      case "todoist": {
        const res = await callApi({ method: "GET", url: "https://api.todoist.com/api/v1/user", headers: { authorization: `Bearer ${values.token}` } });
        const b = res.body as { email?: string; full_name?: string };
        if (res.status >= 400) throw new StepError(`Todoist: the token was rejected (status ${res.status})`);
        return b.email ?? b.full_name ?? null;
      }
      case "mailchimp": {
        const res = await callApi({ method: "GET", url: `${mailchimpBase(values.apiKey ?? "")}/`, headers: { authorization: mailchimpAuth(values.apiKey ?? "") } });
        const b = res.body as { account_name?: string; detail?: string };
        if (res.status >= 400) throw new StepError(`Mailchimp: ${b?.detail ?? `status ${res.status}`}`);
        return b.account_name ?? null;
      }
      case "ntfy": {
        const server = ntfyServer(values.server);
        const res = await callApi({ method: "GET", url: `${server}/v1/health`, headers: values.accessToken ? { authorization: `Bearer ${values.accessToken}` } : {} });
        if (res.status >= 400) throw new StepError(`ntfy: ${server} answered with status ${res.status}`);
        return new URL(server).host;
      }
      case "postgres":
        await runPostgres(values, "select 1", [], 10_000, cfg.allowPrivateNetwork);
        return null;
      case "smtp":
        await sendSmtp(values, null, cfg.allowPrivateNetwork);
        return null;
      default:
        return null;
    }
  }

  /** Runs the health check and records the result. */
  async function test(workspaceId: ObjectId, id: string): Promise<CredentialView | null> {
    const doc = await find(workspaceId, id);
    if (!doc) return null;
    let status: CredentialDoc["status"] = "ok";
    let lastError: string | null = null;
    let account = doc.account;
    const secrets = new Set<string>();
    try {
      const values = await servicesFor(workspaceId, secrets).credential(id, doc.app);
      account = (await check(doc.app, values)) ?? account;
    } catch (err) {
      status = "error";
      lastError = redactText((err as Error).message, secrets);
    }
    const updated = await c.credentials.findOneAndUpdate(
      { _id: doc._id },
      { $set: { status, lastError, testedAt: new Date(), account } },
      { returnDocument: "after" },
    );
    return updated ? toCredentialView(updated) : null;
  }

  /** Suggestions for a field, loaded with the chosen account. */
  async function dynamicOptions(
    workspaceId: ObjectId,
    source: DynamicOptionsSource,
    credentialId: string,
    params: Record<string, unknown>,
  ): Promise<Array<{ value: string; label: string }>> {
    const secrets = new Set<string>();
    const svc = servicesFor(workspaceId, secrets);
    try {
      if (source === "slack.channels") {
        const { botToken } = await svc.credential(credentialId, "slack");
        const res = await callApi({
          method: "GET",
          url: "https://slack.com/api/conversations.list?exclude_archived=true&limit=200&types=public_channel,private_channel",
          headers: { authorization: `Bearer ${botToken}` },
        });
        const b = res.body as { ok?: boolean; error?: string; channels?: Array<{ id: string; name: string; is_member?: boolean }> };
        if (!b?.ok) throw new StepError(`Slack: ${b?.error ?? `status ${res.status}`}`);
        return (b.channels ?? []).map((ch) => ({ value: ch.id, label: `#${ch.name}${ch.is_member === false ? " (bot not in channel)" : ""}` }));
      }
      if (source === "google.sheets") {
        const { accessToken } = await svc.credential(credentialId, "google");
        const raw = String(params.spreadsheetId ?? "");
        const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? raw.trim();
        if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return [];
        const res = await callApi({
          method: "GET",
          url: `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (res.status >= 400) throw new StepError("Google Sheets: couldn't open that spreadsheet with this account");
        const sheets = (res.body as { sheets?: Array<{ properties: { title: string } }> }).sheets ?? [];
        return sheets.map((s) => ({ value: s.properties.title, label: s.properties.title }));
      }
      return [];
    } catch (err) {
      throw new StepError(redactText((err as Error).message, secrets));
    }
  }

  /** Workflows that reference the credential, and whether a published version does. */
  async function usage(workspaceId: ObjectId, id: string) {
    const drafts = await db
      .collection("workflows")
      .find({ workspaceId, "draft.nodes.parameters.credential": id }, { projection: { name: 1 } })
      .toArray();
    const versions = await db
      .collection("workflow_versions")
      .find({ workspaceId, "graph.nodes.parameters.credential": id }, { projection: { _id: 1 } })
      .toArray();
    const versionIds = versions.map((v) => v._id);
    const published = versionIds.length
      ? await db.collection("workflows").find({ workspaceId, publishedVersionId: { $in: versionIds } }, { projection: { name: 1 } }).toArray()
      : [];
    return {
      workflows: drafts.map((w) => ({ id: String(w._id), name: String(w.name) })),
      published: published.map((w) => ({ id: String(w._id), name: String(w.name) })),
    };
  }

  async function remove(workspaceId: ObjectId, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const r = await c.credentials.deleteOne({ _id: new ObjectId(id), workspaceId });
    return r.deletedCount === 1;
  }

  async function rename(workspaceId: ObjectId, id: string, label: string): Promise<CredentialView | null> {
    if (!ObjectId.isValid(id)) return null;
    const d = await c.credentials.findOneAndUpdate(
      { _id: new ObjectId(id), workspaceId },
      { $set: { label, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return d ? toCredentialView(d) : null;
  }

  // Telegram webhooks (one per bot): set when a workflow with a Telegram trigger is published.
  const telegram = {
    async setWebhook(workspaceId: ObjectId, credentialId: string, url: string, secretToken: string) {
      const { botToken } = (await resolve(workspaceId, credentialId, "telegram")).values;
      const res = await callApi({
        method: "POST",
        url: `https://api.telegram.org/bot${botToken}/setWebhook`,
        body: { url, secret_token: secretToken, allowed_updates: ["message"], drop_pending_updates: true },
      });
      const b = res.body as { ok?: boolean; description?: string };
      if (!b?.ok) throw new StepError(`Telegram: ${b?.description ?? `status ${res.status}`}`);
    },
    async deleteWebhook(workspaceId: ObjectId, credentialId: string, dropPendingUpdates = false) {
      const { botToken } = (await resolve(workspaceId, credentialId, "telegram")).values;
      const res = await callApi({
        method: "POST",
        url: `https://api.telegram.org/bot${botToken}/deleteWebhook`,
        body: dropPendingUpdates ? { drop_pending_updates: true } : {},
      });
      const b = res.body as { ok?: boolean; description?: string };
      if (!b?.ok) throw new StepError(`Telegram: ${b?.description ?? `status ${res.status}`}`);
    },
    /** Polling mode: new updates since `offset`, waiting up to `timeoutSec` for one to arrive. */
    async getUpdates(workspaceId: ObjectId, credentialId: string, offset: number | undefined, timeoutSec: number) {
      const { botToken } = (await resolve(workspaceId, credentialId, "telegram")).values;
      const res = await callApi({
        method: "POST",
        url: `https://api.telegram.org/bot${botToken}/getUpdates`,
        body: { ...(offset !== undefined ? { offset } : {}), timeout: timeoutSec, allowed_updates: ["message"] },
      });
      const b = res.body as { ok?: boolean; description?: string; result?: Array<Record<string, unknown>> };
      if (!b?.ok) throw new StepError(`Telegram: ${b?.description ?? `status ${res.status}`}`);
      return b.result ?? [];
    },
  };

  return {
    apiUrl,
    availableApps,
    create,
    find,
    list,
    resolve,
    servicesFor,
    test,
    check,
    dynamicOptions,
    usage,
    remove,
    rename,
    storeTokens,
    replaceTokens,
    telegram,
    collections: c,
    http: cfg.http,
    oauthClients: cfg.oauthClients,
    vault: cfg.vault,
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const MASK = "[hidden]";

export function redactText(text: string, secrets: Set<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 4) continue;
    out = out.split(s).join(MASK);
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join(MASK);
  }
  return out;
}

/** Deep-replaces secret values in any JSON-like value. */
export function redactValue<T>(value: T, secrets: Set<string>): T {
  if (!secrets.size) return value;
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets)) as T;
  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, secrets)])) as T;
  }
  return value;
}

/** Converts a Telegram update into the trigger's item shape. */
export function telegramUpdateToItem(update: Record<string, unknown>): Record<string, unknown> {
  const m = (update.message ?? update.edited_message ?? {}) as Record<string, any>;
  return {
    updateId: update.update_id ?? null,
    message: {
      messageId: m.message_id ?? null,
      text: m.text ?? m.caption ?? null,
      date: typeof m.date === "number" ? new Date(m.date * 1000).toISOString() : null,
      chat: { id: m.chat?.id ?? null, type: m.chat?.type ?? null, title: m.chat?.title ?? null, username: m.chat?.username ?? null },
      from: {
        id: m.from?.id ?? null,
        firstName: m.from?.first_name ?? null,
        lastName: m.from?.last_name ?? null,
        username: m.from?.username ?? null,
        languageCode: m.from?.language_code ?? null,
      },
    },
  };
}

