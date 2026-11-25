import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { BSON, type Db } from "mongodb";

const { EJSON } = BSON;

/**
 * Backups of the whole database: one folder per backup, one gzipped file per
 * collection (Extended JSON lines, so ids, dates and binary data come back
 * exactly). Saved accounts stay encrypted in the backup; to use them after a
 * restore you also need the same encryption key (.data/encryption.key or
 * CONDUIT_ENCRYPTION_KEY), which is deliberately NOT inside the backup.
 */

/** Short-lived or rebuildable data that isn't worth backing up. */
const SKIP = new Set(["jobs", "oauth_states", "whatsapp_web_outbox", "session", "verification"]);
const PREFIX = "conduit-backup-";

export interface BackupResult {
  path: string;
  collections: Record<string, number>;
  bytes: number;
  tookMs: number;
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}

export async function backupDatabase(db: Db, dir: string, opts: { keep?: number; now?: Date } = {}): Promise<BackupResult> {
  const started = Date.now();
  const folder = join(dir, `${PREFIX}${stamp(opts.now ?? new Date())}`);
  const tmp = `${folder}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !SKIP.has(n) && !n.startsWith("system."))
    .sort();
  const collections: Record<string, number> = {};
  let bytes = 0;
  for (const name of names) {
    let count = 0;
    const cursor = db.collection(name).find({}, { batchSize: 500 });
    async function* lines() {
      for await (const doc of cursor) {
        count++;
        yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
      }
    }
    const file = join(tmp, `${name}.jsonl.gz`);
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file));
    collections[name] = count;
    bytes += (await stat(file)).size;
  }
  await writeFile(join(tmp, "manifest.json"), JSON.stringify({ app: "conduit", createdAt: new Date().toISOString(), database: db.databaseName, collections }, null, 2));
  // Only a complete backup gets its real name, so a crash halfway never looks like a good backup.
  await rm(folder, { recursive: true, force: true });
  await rename(tmp, folder);
  await pruneBackups(dir, opts.keep ?? 14);
  return { path: folder, collections, bytes, tookMs: Date.now() - started };
}

/** Backups in `dir`, newest first. */
export async function listBackups(dir: string): Promise<Array<{ name: string; path: string; createdAt: string | null }>> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string; createdAt: string | null }> = [];
  for (const name of entries.filter((e) => e.startsWith(PREFIX) && !e.endsWith(".partial")).sort().reverse()) {
    try {
      const m = JSON.parse(await readFile(join(dir, name, "manifest.json"), "utf8")) as { createdAt?: string };
      out.push({ name, path: join(dir, name), createdAt: m.createdAt ?? null });
    } catch {
      /* not a finished backup */
    }
  }
  return out;
}

async function pruneBackups(dir: string, keep: number) {
  const all = await listBackups(dir);
  for (const old of all.slice(Math.max(1, keep))) await rm(old.path, { recursive: true, force: true });
}

/**
 * Puts a backup back. Each collection in the backup replaces the one in the
 * database (other collections are left alone). Stop Conduit first.
 */
export async function restoreDatabase(db: Db, folder: string): Promise<Record<string, number>> {
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")) as { app?: string; collections?: Record<string, number> };
  if (manifest.app !== "conduit") throw new Error(`${folder} isn't a Conduit backup`);
  const restored: Record<string, number> = {};
  for (const name of Object.keys(manifest.collections ?? {})) {
    const col = db.collection(name);
    await col.deleteMany({});
    const rl = createInterface({ input: createReadStream(join(folder, `${name}.jsonl.gz`)).pipe(createGunzip()), crlfDelay: Infinity });
    let batch: Record<string, unknown>[] = [];
    let n = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }) as Record<string, unknown>);
      if (batch.length >= 500) {
        await col.insertMany(batch, { ordered: false });
        n += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await col.insertMany(batch, { ordered: false });
      n += batch.length;
    }
    restored[name] = n;
  }
  return restored;
}

/**
 * Makes a backup when the newest one is more than `everyHours` old: right after
 * start (a laptop that was off overnight still gets its daily backup) and then
 * once an hour checks again.
 */
export function startBackups(db: Db, opts: { dir: string; everyHours?: number; keep?: number; checkMs?: number; log?: (msg: string) => void }) {
  const every = (opts.everyHours ?? 24) * 3_600_000;
  const log = opts.log ?? ((m: string) => console.info(m));
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const newest = (await listBackups(opts.dir))[0];
      const age = newest?.createdAt ? Date.now() - Date.parse(newest.createdAt) : Infinity;
      if (age >= every) {
        const r = await backupDatabase(db, opts.dir, { keep: opts.keep });
        log(`[backup] saved ${Object.values(r.collections).reduce((a, b) => a + b, 0)} records (${Math.round(r.bytes / 1024)} KB) to ${r.path}`);
      }
    } catch (e) {
      console.error("[backup] failed", (e as Error).message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void check(), 30_000);
  const timer = setInterval(() => void check(), opts.checkMs ?? 3_600_000);
  first.unref?.();
  timer.unref?.();
  return {
    check,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
