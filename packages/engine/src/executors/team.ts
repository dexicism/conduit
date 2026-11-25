import type { Executor, Item } from "../types";
import { StepError } from "../types";
import { toText } from "../values";
import { account, readTable, spreadsheetIdOf } from "./apps";

/**
 * "Team access check": who is writing, and are they allowed?
 *
 * Reads a Team tab in a Google Sheet (Name, Phone, Role, Access) and matches the
 * sender's phone number on its digits, so "+91 98123 45678", "09812345678" and
 * "919812345678" are the same person. Items go out of "allowed" or "denied",
 * with a `person` object either way, so the next steps (and the AI) know who it is.
 *
 * Access column values: edit / yes / full / admin = can change data;
 * view / read / no = can ask but not change; blocked / none = ignored.
 * A role containing "owner" or "boss" is the owner.
 */

export interface Person {
  known: boolean;
  name: string | null;
  role: string | null;
  access: "edit" | "view" | "blocked" | null;
  canEdit: boolean;
  isOwner: boolean;
  phone: string | null;
  row: number | null;
  /** Every column of their row, by header. */
  details: Record<string, string>;
}

const ALIASES: Record<"name" | "phone" | "role" | "access", string[]> = {
  name: ["name", "full name", "employee", "person"],
  phone: ["phone", "phone number", "number", "mobile", "whatsapp", "contact"],
  role: ["role", "position", "designation", "title"],
  access: ["access", "can edit", "permission", "permissions", "rights"],
};

function findColumn(header: string[], key: keyof typeof ALIASES): number {
  const names = ALIASES[key];
  return header.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

export function accessOf(value: string): Person["access"] {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (["edit", "editor", "yes", "y", "true", "full", "admin", "write", "update"].includes(v)) return "edit";
  if (["blocked", "block", "none", "banned", "off", "disabled"].includes(v)) return "blocked";
  return "view";
}

const digits = (v: string) => v.replace(/\D/g, "");

/** Same number if the shorter one (7+ digits) is the end of the longer one: country codes and leading zeros don't matter. */
export function samePhone(a: string, b: string): boolean {
  const x = digits(a).replace(/^0+/, "");
  const y = digits(b).replace(/^0+/, "");
  if (x.length < 7 || y.length < 7) return false;
  return x.endsWith(y) || y.endsWith(x);
}

export function personFrom(header: string[], rows: string[][], phone: string): Person {
  const cols = { name: findColumn(header, "name"), phone: findColumn(header, "phone"), role: findColumn(header, "role"), access: findColumn(header, "access") };
  if (cols.phone < 0) throw new StepError(`The team sheet needs a Phone column. It has: ${header.filter(Boolean).join(", ")}`);
  const i = phone ? rows.findIndex((r) => samePhone(r[cols.phone] ?? "", phone)) : -1;
  if (i < 0) return { known: false, name: null, role: null, access: null, canEdit: false, isOwner: false, phone: phone || null, row: null, details: {} };
  const r = rows[i]!;
  const role = cols.role >= 0 ? (r[cols.role] ?? "").trim() || null : null;
  const isOwner = /\b(owner|boss|founder|ceo|proprietor)\b/i.test(role ?? "");
  // No Access column (or an empty cell): owners can edit, everyone else can view.
  const access = (cols.access >= 0 ? accessOf(r[cols.access] ?? "") : null) ?? (isOwner ? "edit" : "view");
  return {
    known: true,
    name: cols.name >= 0 ? (r[cols.name] ?? "").trim() || null : null,
    role,
    access,
    canEdit: access === "edit",
    isOwner: isOwner && access !== "blocked",
    phone: (r[cols.phone] ?? "").trim() || phone,
    row: i + 2,
    details: Object.fromEntries(header.map((h, c) => [h, r[c] ?? ""]).filter(([h]) => h)),
  };
}

export function isAllowed(person: Person, rule: string, roles: string): boolean {
  if (!person.known || person.access === "blocked") return false;
  if (rule === "edit") return person.canEdit;
  if (rule === "owner") return person.isOwner;
  if (rule === "roles") {
    const wanted = roles
      .split(/[,;\n]+/)
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    return Boolean(person.role) && wanted.includes(person.role!.toLowerCase());
  }
  return true;
}

export const teamCheckExecutor: Executor = async (ctx) => {
  const allowed: Item[] = [];
  const denied: Item[] = [];
  // One read of the sheet per run, even with many items.
  let table: { header: string[]; rows: string[][] } | null = null;
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    if (!table) {
      const { accessToken } = await account(p, "google", ctx.services);
      table = await readTable(ctx.services, accessToken, spreadsheetIdOf(p.spreadsheetId), p.sheet);
    }
    const phone = toText(p.phone).trim();
    const person = personFrom(table.header, table.rows, phone);
    const ok = isAllowed(person, toText(p.allow) || "known", toText(p.roles));
    (ok ? allowed : denied).push({ json: { ...ctx.items[i]!.json, person: { ...person } } });
  }
  ctx.log(`${allowed.length} allowed, ${denied.length} denied`);
  return { outputs: { allowed, denied } };
};
