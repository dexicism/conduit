import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { StepError, type HttpRequest, type HttpResponse } from "@conduit/engine";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const n = v4ToInt(address);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a.replace(/^0+/, ""));
  }
  return true;
}

/**
 * Dispatcher that validates every address DNS returns, at connect time. Checking
 * inside the connection's lookup (rather than before fetch) closes the DNS
 * rebinding gap between "check" and "connect".
 */
function guardedDispatcher(allowPrivate: boolean): Dispatcher {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const list = addresses as LookupAddress[];
          if (!allowPrivate) {
            const bad = list.find((a) => isPrivateAddress(a.address));
            if (bad) {
              return callback(new Error(`Blocked request to a private network address (${hostname})`), "", 0);
            }
          }
          const first = list[0];
          if (!first) return callback(new Error(`No address for ${hostname}`), "", 0);
          if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
          else callback(null, first.address, first.family);
        });
      },
    },
  });
}

async function readCapped(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_RESPONSE_BYTES) throw new StepError(`Response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body) {
    total += (chunk as Uint8Array).byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new StepError(`Response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Errors where the request never reached the server (no internet yet after the
 * laptop wakes up, a DNS hiccup): safe to send again, whatever the method.
 */
const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Connection dropped mid-way: only safe to repeat for reads. */
const DROPPED = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT"]);

export function createHttpClient(opts: { allowPrivateNetwork: boolean; retryDelaysMs?: number[] }) {
  const dispatcher = guardedDispatcher(opts.allowPrivateNetwork);
  const delays = opts.retryDelaysMs ?? [2000, 5000, 12000];

  return async function http(req: HttpRequest): Promise<HttpResponse> {
    let url = new URL(req.url);
    let method = req.method;
    let body = req.body;
    let reqHeaders = req.headers;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new StepError("Only http and https URLs are allowed");
      // Literal IPs never hit DNS, so check them here too.
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!opts.allowPrivateNetwork && isIP(host) && isPrivateAddress(host)) {
        throw new StepError(`Blocked request to a private network address (${host})`);
      }
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await undiciFetch(url, {
            method,
            headers: reqHeaders,
            body,
            redirect: "manual",
            dispatcher,
            signal: AbortSignal.timeout(req.timeoutMs),
          });
          break;
        } catch (err) {
          const e = err as Error & { cause?: Error & { code?: string } };
          if (e.name === "TimeoutError") throw new StepError(`Request timed out after ${req.timeoutMs / 1000}s`);
          const code = e.cause?.code ?? "";
          const again = NOT_SENT.has(code) || (DROPPED.has(code) && (method === "GET" || method === "HEAD"));
          if (again && attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
            continue;
          }
          throw new StepError(e.cause?.message ?? e.message ?? "Request failed");
        }
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const next = new URL(location, url);
        // Never forward credentials to another origin.
        if (next.origin !== url.origin) {
          const drop = new Set(["authorization", "cookie", "proxy-authorization", ...(req.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);
          reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !drop.has(k.toLowerCase())));
        }
        url = next;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const raw = await readCapped(res);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const type = headers["content-type"] ?? "";
      let parsed: unknown = raw.toString("utf8");
      if (type.includes("json")) {
        try {
          parsed = JSON.parse(parsed as string);
        } catch {
          /* keep text */
        }
      }
      return { status: res.status, headers, body: parsed };
    }
    throw new StepError(`Too many redirects (more than ${MAX_REDIRECTS})`);
  };
}
