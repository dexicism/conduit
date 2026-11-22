import { createHash } from "node:crypto";
import type { KeyValuePair } from "@conduit/nodes";
import type { EngineServices, HttpResponse, IntegrationServices } from "../types";
import { StepError } from "../types";
import { toNumber, toText } from "../values";

type Json = Record<string, unknown>;
export type MoreAction = (p: Json, services: EngineServices) => Promise<Json | Json[]>;

function integrations(services: EngineServices): IntegrationServices {
  if (!services.integrations) throw new StepError("Connected apps aren't set up on this server");
  return services.integrations;
}

async function account(p: Json, app: string, services: EngineServices) {
  const id = toText(p.credential);
  if (!id) throw new StepError("Choose an account to use");
  return integrations(services).credential(id, app);
}

function pairs(v: unknown): KeyValuePair[] {
  return Array.isArray(v) ? (v as KeyValuePair[]).filter((r) => toText(r.key).trim() !== "") : [];
}

async function call(
  services: EngineServices,
  req: { method: string; url: string; headers?: Record<string, string>; body?: unknown; raw?: string; timeoutMs?: number },
): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  let body = req.raw;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    headers["content-type"] = "application/json";
  }
  return services.http({ method: req.method, url: integrations(services).apiUrl(req.url), headers, body, timeoutMs: req.timeoutMs ?? 30_000 });
}

/** Pulls a readable message out of the usual error shapes. */
function errorText(res: HttpResponse): string {
  const b = res.body as Record<string, unknown> | string | null;
  if (typeof b === "string") return b.slice(0, 200) || `status ${res.status}`;
  const e = b?.error;
  const msg =
    (typeof e === "object" && e && "message" in e ? String((e as Json).message) : typeof e === "string" ? e : undefined) ??
    (b?.message as string | undefined) ??
    (b?.detail as string | undefined) ??
    (b?.title as string | undefined);
  return msg ? String(msg) : `request failed with status ${res.status}`;
}

function fail(app: string, res: HttpResponse, hints: Record<number, string> = {}): StepError {
  return new StepError(`${app}: ${errorText(res)}${hints[res.status] ? ` (${hints[res.status]})` : ""}`);
}

/** Accepts a URL or a bare ID; returns the last 32-hex (Notion) or the raw ID. */
function notionId(v: unknown, label: string): string {
  const s = toText(v).trim();
  const m = /([0-9a-f]{32})(?:\?|$)/i.exec(s.replace(/-/g, "")) ?? /([0-9a-f]{32})/i.exec(s.replace(/-/g, ""));
  if (!m) throw new StepError(`${label}: paste the database link or its 32-character ID`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Notion (API version pinned; databases are addressed by database ID)
// ---------------------------------------------------------------------------

const NOTION = "https://api.notion.com/v1";
const notionHeaders = (token: string | undefined) => ({ authorization: `Bearer ${token}`, "notion-version": "2022-06-28" });
const NOTION_HINTS = { 401: "check the integration token", 404: "share the database with your integration: ••• → Connections" };

/** Turns a plain value into the property shape the database column expects. */
function notionValue(type: string, raw: string, column: string): unknown {
  switch (type) {
    case "title":
      return { title: [{ text: { content: raw } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: raw } }] };
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new StepError(`Notion: "${column}" needs a number`);
      return { number: n };
    }
    case "select":
      return { select: { name: raw } };
    case "status":
      return { status: { name: raw } };
    case "multi_select":
      return { multi_select: raw.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name })) };
    case "checkbox":
      return { checkbox: ["true", "yes", "1", "on", "x"].includes(raw.trim().toLowerCase()) };
    case "date":
      return { date: { start: raw } };
    case "url":
      return { url: raw };
    case "email":
      return { email: raw };
    case "phone_number":
      return { phone_number: raw };
    default:
      throw new StepError(`Notion: the "${column}" column is a ${type} column, which this step can't fill in`);
  }
}

function notionPlain(prop: Json): unknown {
  const type = String(prop.type);
  const v = prop[type] as unknown;
  if (type === "title" || type === "rich_text") return (v as Array<{ plain_text?: string }>).map((t) => t.plain_text ?? "").join("");
  if (type === "select" || type === "status") return (v as { name?: string } | null)?.name ?? null;
  if (type === "multi_select") return (v as Array<{ name: string }>).map((o) => o.name);
  if (type === "date") return (v as { start?: string } | null)?.start ?? null;
  if (type === "people") return (v as Array<{ name?: string }>).map((u) => u.name ?? "");
  if (type === "formula") return (v as Json)?.[String((v as Json)?.type)] ?? null;
  if (type === "unique_id") {
    const u = v as { prefix?: string | null; number?: number } | null;
    return u ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : null;
  }
  return v ?? null;
}

const notionAddPage: MoreAction = async (p, services) => {
  const { token } = await account(p, "notion", services);
  const db = notionId(p.database, "Database");
  const schemaRes = await call(services, { method: "GET", url: `${NOTION}/databases/${db}`, headers: notionHeaders(token) });
  if (schemaRes.status >= 400) throw fail("Notion", schemaRes, NOTION_HINTS);
  const columns = (schemaRes.body as { properties: Record<string, { type: string }> }).properties;
  const byLower = new Map(Object.entries(columns).map(([name, c]) => [name.toLowerCase(), { name, type: c.type }]));
  const properties: Json = {};
  for (const pair of pairs(p.columns)) {
    const col = byLower.get(toText(pair.key).trim().toLowerCase());
    if (!col) throw new StepError(`Notion: no column named "${toText(pair.key)}". The database has: ${Object.keys(columns).join(", ")}`);
    properties[col.name] = notionValue(col.type, toText(pair.value), col.name);
  }
  const content = toText(p.content).trim();
  const res = await call(services, {
    method: "POST",
    url: `${NOTION}/pages`,
    headers: notionHeaders(token),
    body: {
      parent: { database_id: db },
      properties,
      ...(content ? { children: content.split(/\n{2,}/).map((para) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: para.slice(0, 2000) } }] } })) } : {}),
    },
  });
  if (res.status >= 400) throw fail("Notion", res, NOTION_HINTS);
  const b = res.body as { id: string; url: string };
  return { id: b.id, url: b.url };
};

const notionQuery: MoreAction = async (p, services) => {
  const { token } = await account(p, "notion", services);
  const db = notionId(p.database, "Database");
  const limit = Math.min(Math.max(Math.trunc(toNumber(p.limit ?? 50, "Max pages")), 1), 100);
  const res = await call(services, { method: "POST", url: `${NOTION}/databases/${db}/query`, headers: notionHeaders(token), body: { page_size: limit } });
  if (res.status >= 400) throw fail("Notion", res, NOTION_HINTS);
  const pages = (res.body as { results: Array<{ id: string; url: string; properties: Record<string, Json> }> }).results;
  return pages.map((pg) => ({ id: pg.id, url: pg.url, ...Object.fromEntries(Object.entries(pg.properties).map(([k, v]) => [k, notionPlain(v)])) }));
};

// ---------------------------------------------------------------------------
// Airtable
// ---------------------------------------------------------------------------

const AIRTABLE_HINTS = { 401: "check the access token", 403: "give the token access to this base, with data.records scopes", 404: "check the base ID and table name" };

function airtablePath(p: Json): string {
  const base = toText(p.base).trim().match(/app[A-Za-z0-9]{14}/)?.[0];
  if (!base) throw new StepError("Airtable: paste the base link or its ID (starts with app…)");
  const table = toText(p.table).trim();
  if (!table) throw new StepError("Airtable: add the table name");
  return `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
}

const airtableAdd: MoreAction = async (p, services) => {
  const { token } = await account(p, "airtable", services);
  const fields = Object.fromEntries(pairs(p.fields).map((f) => [toText(f.key).trim(), toText(f.value)]));
  if (!Object.keys(fields).length) throw new StepError("Airtable: add at least one field");
  // typecast lets Airtable turn "42" into a number, "yes" into a checkbox, new select options, etc.
  const res = await call(services, { method: "POST", url: airtablePath(p), headers: { authorization: `Bearer ${token}` }, body: { records: [{ fields }], typecast: true } });
  if (res.status >= 400) throw fail("Airtable", res, AIRTABLE_HINTS);
  const rec = (res.body as { records: Array<{ id: string; createdTime: string; fields: Json }> }).records[0]!;
  return { id: rec.id, createdTime: rec.createdTime, fields: rec.fields };
};

const airtableList: MoreAction = async (p, services) => {
  const { token } = await account(p, "airtable", services);
  const qs = new URLSearchParams({ maxRecords: String(Math.min(Math.max(Math.trunc(toNumber(p.limit ?? 100, "Max records")), 1), 1000)) });
  const formula = toText(p.filter).trim();
  if (formula) qs.set("filterByFormula", formula);
  const view = toText(p.view).trim();
  if (view) qs.set("view", view);
  const res = await call(services, { method: "GET", url: `${airtablePath(p)}?${qs}`, headers: { authorization: `Bearer ${token}` } });
  if (res.status >= 400) throw fail("Airtable", res, { ...AIRTABLE_HINTS, 422: "check the filter formula" });
  return (res.body as { records: Array<{ id: string; createdTime: string; fields: Json }> }).records.map((r) => ({ id: r.id, createdTime: r.createdTime, ...r.fields }));
};

// ---------------------------------------------------------------------------
// Discord (incoming webhook)
// ---------------------------------------------------------------------------

export function checkDiscordWebhook(url: string): string {
  const u = url.trim();
  if (!/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u)) {
    throw new StepError("Discord: that isn't a webhook URL. Copy it from Server Settings → Integrations → Webhooks.");
  }
  return u;
}

const discordSend: MoreAction = async (p, services) => {
  const { webhookUrl } = await account(p, "discord", services);
  const content = toText(p.content);
  if (!content.trim()) throw new StepError("Discord: the message is empty");
  if (content.length > 2000) throw new StepError("Discord: messages can be at most 2,000 characters");
  const username = toText(p.username).trim();
  const res = await call(services, {
    method: "POST",
    url: `${checkDiscordWebhook(webhookUrl ?? "")}?wait=true`,
    // Don't let workflow data ping @everyone by accident.
    body: { content, ...(username ? { username } : {}), allowed_mentions: { parse: p.allowMentions === true ? ["users", "roles", "everyone"] : [] } },
  });
  if (res.status >= 400) throw fail("Discord", res, { 404: "the webhook was deleted; make a new one", 429: "Discord is rate limiting this webhook" });
  const b = res.body as { id: string; channel_id: string; timestamp: string };
  return { id: b.id, channelId: b.channel_id, timestamp: b.timestamp };
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const githubHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });

function repoOf(v: unknown): string {
  const s = toText(v).trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw new StepError("GitHub: the repository should look like owner/name");
  return s;
}

const githubIssue: MoreAction = async (p, services) => {
  const { token } = await account(p, "github", services);
  const title = toText(p.title).trim();
  if (!title) throw new StepError("GitHub: the issue needs a title");
  const labels = toText(p.labels).split(",").map((s) => s.trim()).filter(Boolean);
  const res = await call(services, {
    method: "POST",
    url: `https://api.github.com/repos/${repoOf(p.repo)}/issues`,
    headers: githubHeaders(token ?? ""),
    body: { title, body: toText(p.body) || undefined, ...(labels.length ? { labels } : {}) },
  });
  if (res.status >= 400) throw fail("GitHub", res, { 401: "check the token", 403: "the token needs Issues: write on this repository", 404: "check the repository name, and that the token can see it", 410: "issues are turned off for this repository" });
  const b = res.body as { number: number; html_url: string; id: number };
  return { number: b.number, url: b.html_url, id: b.id };
};

// ---------------------------------------------------------------------------
// Trello
// ---------------------------------------------------------------------------

const trelloCard: MoreAction = async (p, services) => {
  const { apiKey, token } = await account(p, "trello", services);
  const list = toText(p.list).trim();
  if (!/^[0-9a-f]{24}$/i.test(list)) throw new StepError("Trello: the list ID is 24 letters and numbers. Open a card in that list, add .json to its URL, and copy idList.");
  const name = toText(p.name).trim();
  if (!name) throw new StepError("Trello: the card needs a name");
  const qs = new URLSearchParams({ key: apiKey ?? "", token: token ?? "" });
  const due = toText(p.due).trim();
  const res = await call(services, { method: "POST", url: `https://api.trello.com/1/cards?${qs}`, body: { idList: list, name, desc: toText(p.description), ...(due ? { due } : {}), pos: "top" } });
  if (res.status >= 400) throw fail("Trello", res, { 401: "check the API key and token", 404: "check the list ID" });
  const b = res.body as { id: string; shortUrl: string; url: string };
  return { id: b.id, url: b.shortUrl ?? b.url };
};

// ---------------------------------------------------------------------------
// Todoist (API v1)
// ---------------------------------------------------------------------------

const todoistTask: MoreAction = async (p, services) => {
  const { token } = await account(p, "todoist", services);
  const content = toText(p.content).trim();
  if (!content) throw new StepError("Todoist: the task needs a name");
  const project = toText(p.project).trim();
  const due = toText(p.due).trim();
  const labels = toText(p.labels).split(",").map((s) => s.trim()).filter(Boolean);
  const res = await call(services, {
    method: "POST",
    url: "https://api.todoist.com/api/v1/tasks",
    headers: { authorization: `Bearer ${token}` },
    body: {
      content,
      description: toText(p.description) || undefined,
      // Todoist's API counts the other way round from the app: 4 is the red "P1".
      priority: Number(toText(p.priority) || 1),
      ...(due ? { due_string: due } : {}),
      ...(project ? { project_id: project } : {}),
      ...(labels.length ? { labels } : {}),
    },
  });
  if (res.status >= 400) throw fail("Todoist", res, { 401: "check the API token", 403: "check the API token", 404: "check the project ID" });
  const b = res.body as { id: string; content: string; due?: { date?: string } | null };
  return { id: b.id, content: b.content, due: b.due?.date ?? null, url: `https://app.todoist.com/app/task/${b.id}` };
};

// ---------------------------------------------------------------------------
// Mailchimp
// ---------------------------------------------------------------------------

export function mailchimpBase(apiKey: string): string {
  const dc = /-([a-z]+\d+)$/.exec(apiKey.trim())?.[1];
  if (!dc) throw new StepError("Mailchimp: the API key should end with a data center, like -us21");
  return `https://${dc}.api.mailchimp.com/3.0`;
}

export const mailchimpAuth = (apiKey: string) => `Basic ${Buffer.from(`conduit:${apiKey.trim()}`).toString("base64")}`;

const mailchimpSubscribe: MoreAction = async (p, services) => {
  const { apiKey } = await account(p, "mailchimp", services);
  const email = toText(p.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StepError(`Mailchimp: "${toText(p.email)}" isn't a valid email address`);
  const list = toText(p.audience).trim();
  if (!list) throw new StepError("Mailchimp: add the audience ID (Audience → Settings → Unique ID)");
  const status = toText(p.status) === "pending" ? "pending" : "subscribed";
  const merge = Object.fromEntries(pairs(p.mergeFields).map((m) => [toText(m.key).trim().toUpperCase(), toText(m.value)]));
  const tags = toText(p.tags).split(",").map((s) => s.trim()).filter(Boolean);
  const hash = createHash("md5").update(email).digest("hex");
  // PUT adds new people and updates existing ones, so re-running a workflow is safe.
  const res = await call(services, {
    method: "PUT",
    url: `${mailchimpBase(apiKey ?? "")}/lists/${encodeURIComponent(list)}/members/${hash}`,
    headers: { authorization: mailchimpAuth(apiKey ?? "") },
    body: { email_address: email, status_if_new: status, ...(Object.keys(merge).length ? { merge_fields: merge } : {}) },
  });
  if (res.status >= 400) throw fail("Mailchimp", res, { 401: "check the API key", 404: "check the audience ID" });
  const b = res.body as { id: string; status: string; email_address: string };
  if (tags.length) {
    const t = await call(services, {
      method: "POST",
      url: `${mailchimpBase(apiKey ?? "")}/lists/${encodeURIComponent(list)}/members/${hash}/tags`,
      headers: { authorization: mailchimpAuth(apiKey ?? "") },
      body: { tags: tags.map((name) => ({ name, status: "active" })) },
    });
    if (t.status >= 400) throw fail("Mailchimp", t);
  }
  return { id: b.id, email: b.email_address, status: b.status };
};

// ---------------------------------------------------------------------------
// ntfy (push notifications to your phone)
// ---------------------------------------------------------------------------

export function ntfyServer(v: string | undefined): string {
  const s = (v || "https://ntfy.sh").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(s)) throw new StepError("ntfy: the server should be a URL like https://ntfy.sh");
  return s;
}

const ntfySend: MoreAction = async (p, services) => {
  const { server, accessToken } = await account(p, "ntfy", services);
  const topic = toText(p.topic).trim();
  if (!/^[\w-]{1,64}$/.test(topic)) throw new StepError("ntfy: topics can use letters, numbers, - and _ (up to 64)");
  const message = toText(p.message);
  if (!message.trim()) throw new StepError("ntfy: the message is empty");
  const tags = toText(p.tags).split(",").map((s) => s.trim()).filter(Boolean);
  const click = toText(p.click).trim();
  const res = await call(services, {
    method: "POST",
    url: `${ntfyServer(server)}/`,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    body: { topic, message, title: toText(p.title) || undefined, priority: Number(toText(p.priority) || 3), ...(tags.length ? { tags } : {}), ...(click ? { click } : {}) },
  });
  if (res.status >= 400) throw fail("ntfy", res, { 401: "this topic needs an access token", 403: "the token can't write to this topic", 429: "too many messages; ntfy.sh limits how often you can send" });
  const b = res.body as { id: string; time: number };
  return { id: b.id, topic, time: b.time ? new Date(b.time * 1000).toISOString() : null };
};

// ---------------------------------------------------------------------------
// RSS / Atom feeds (no account)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decode(m[1]!) : null;
}

// Descriptions are usually HTML, so after dropping the tags there are HTML entities left to decode.
const stripHtml = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. Good enough for real-world feeds; not a full XML parser. */
export function parseFeed(xml: string): { title: string | null; items: Json[] } {
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const items = blocks.map((b) => {
    const link = isAtom
      ? (/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) ?? /<link[^>]*href=["']([^"']+)["']/i.exec(b))?.[1] ?? null
      : tag(b, "link");
    const summary = tag(b, isAtom ? "summary" : "description") ?? tag(b, "content:encoded") ?? (isAtom ? tag(b, "content") : null);
    const date = isAtom ? (tag(b, "published") ?? tag(b, "updated")) : (tag(b, "pubDate") ?? tag(b, "dc:date"));
    const parsed = date ? new Date(date) : null;
    return {
      title: tag(b, "title"),
      link: link ? decode(link) : null,
      id: tag(b, isAtom ? "id" : "guid") ?? link,
      published: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : date,
      summary: summary ? stripHtml(summary).slice(0, 2000) : null,
      author: isAtom ? tag(b, "name") : (tag(b, "author") ?? tag(b, "dc:creator")),
    };
  });
  const first = xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = first > 0 ? xml.slice(0, first) : xml;
  return { title: tag(head, "title"), items };
}

const rssRead: MoreAction = async (p, services) => {
  const url = toText(p.url).trim();
  if (!/^https?:\/\//i.test(url)) throw new StepError("RSS: the feed URL should start with http:// or https://");
  const res = await services.http({ method: "GET", url: services.integrations?.apiUrl(url) ?? url, headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, timeoutMs: 20_000 });
  if (res.status >= 400) throw new StepError(`RSS: the feed answered with status ${res.status}`);
  const xml = typeof res.body === "string" ? res.body : "";
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new StepError("RSS: that URL didn't return an RSS or Atom feed");
  const feed = parseFeed(xml);
  const limit = Math.min(Math.max(Math.trunc(toNumber(p.limit ?? 20, "Max items")), 1), 200);
  return feed.items.slice(0, limit).map((i) => ({ ...i, feed: feed.title }));
};

export const MORE_APP_ACTIONS: Record<string, MoreAction> = {
  "app.notion.addPage": notionAddPage,
  "app.notion.query": notionQuery,
  "app.airtable.add": airtableAdd,
  "app.airtable.list": airtableList,
  "app.discord.send": discordSend,
  "app.github.issue": githubIssue,
  "app.trello.card": trelloCard,
  "app.todoist.task": todoistTask,
  "app.mailchimp.subscribe": mailchimpSubscribe,
  "app.ntfy.send": ntfySend,
  "app.rss.read": rssRead,
};
