import { describe, expect, it } from "vitest";
import {
  buildReference,
  collectReferences,
  getPath,
  hasReferences,
  parseTemplate,
  resolveParameters,
  resolveTemplate,
} from "./expression";

describe("parseTemplate", () => {
  it("returns plain text untouched", () => {
    expect(parseTemplate("hello")).toEqual([{ kind: "text", value: "hello" }]);
  });

  it("parses $input and node references with positions", () => {
    const s = "Hi ${['$input']['name']}, order ${['node-a']['items']['0']['id']}!";
    const parts = parseTemplate(s);
    expect(parts.map((p) => p.kind)).toEqual(["text", "ref", "text", "ref", "text"]);
    const ref = parts[1];
    expect(ref).toMatchObject({ kind: "ref", source: "$input", path: ["name"] });
    if (ref?.kind === "ref") expect(s.slice(ref.start, ref.end)).toBe(ref.raw);
    expect(parts[3]).toMatchObject({ source: "node-a", path: ["items", "0", "id"] });
  });

  it("handles escaped quotes in segments", () => {
    const raw = buildReference("n1", ["it's", "a\\b"]);
    expect(parseTemplate(raw)[0]).toMatchObject({ kind: "ref", source: "n1", path: ["it's", "a\\b"] });
  });

  it("flags malformed references", () => {
    const parts = parseTemplate("x ${node.field} y");
    expect(parts[1]).toMatchObject({ kind: "invalid", raw: "${node.field}" });
    expect(parseTemplate("${['a']")[0]?.kind).toBe("invalid");
  });

  it("treats legacy mustache paths as $input references", () => {
    expect(parseTemplate("{{ user.email }}")[0]).toMatchObject({ kind: "ref", source: "$input", path: ["user", "email"] });
  });

  it("leaves AI-fill placeholders as text", () => {
    expect(hasReferences("={{AI('x', `do it`, 'string')}}")).toBe(false);
  });
});

describe("buildReference", () => {
  it("round-trips through the parser", () => {
    const raw = buildReference("$input", ["a", 0, "b"]);
    expect(raw).toBe("${['$input']['a']['0']['b']}");
    expect(parseTemplate(raw)[0]).toMatchObject({ path: ["a", "0", "b"] });
  });
});

describe("getPath", () => {
  const data = { a: { list: [{ v: 1 }, { v: 2 }] }, n: null };
  it("walks objects and arrays", () => {
    expect(getPath(data, ["a", "list", "1", "v"])).toBe(2);
    expect(getPath(data, ["a", "list", "length"])).toBe(2);
  });
  it("returns undefined for missing paths and does not walk prototypes", () => {
    expect(getPath(data, ["a", "nope"])).toBeUndefined();
    expect(getPath(data, ["n", "x"])).toBeUndefined();
    expect(getPath(data, ["constructor"])).toBeUndefined();
  });
});

describe("resolveTemplate", () => {
  const ctx = { input: { name: "Ada", tags: ["x"] }, nodes: { order: { total: 42, items: [{ sku: "S1" }] } } };

  it("keeps the type of a whole-value reference", () => {
    expect(resolveTemplate("${['order']['total']}", ctx).value).toBe(42);
    expect(resolveTemplate("${['$input']['tags']}", ctx).value).toEqual(["x"]);
  });

  it("interpolates into text and stringifies objects", () => {
    expect(resolveTemplate("Hi ${['$input']['name']} (${['order']['items']['0']['sku']})", ctx).value).toBe("Hi Ada (S1)");
    expect(resolveTemplate("tags=${['$input']['tags']}", ctx).value).toBe('tags=["x"]');
  });

  it("reports missing references", () => {
    const r = resolveTemplate("${['ghost']['x']} and ${['order']['nope']}", ctx);
    expect(r.value).toBe(" and ");
    expect(r.missing).toHaveLength(2);
  });

  it("passes non-strings through", () => {
    expect(resolveTemplate(5, ctx).value).toBe(5);
  });
});

describe("resolveParameters / collectReferences", () => {
  it("resolves deeply and collects references", () => {
    const params = { url: "https://x/${['$input']['name']}", headers: [{ key: "n", value: "${['order']['total']}" }] };
    const ctx = { input: { name: "a" }, nodes: { order: { total: 1 } } };
    expect(resolveParameters(params, ctx).value).toEqual({ url: "https://x/a", headers: [{ key: "n", value: 1 }] });
    expect(collectReferences(params).map((r) => r.source)).toEqual(["$input", "order"]);
  });
});
