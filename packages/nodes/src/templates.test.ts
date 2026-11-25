import { parseTemplate, workflowGraphSchema } from "@conduit/core";
import { describe, expect, it } from "vitest";
import { getDefinition, nodeIssues, validateGraphWithRegistry } from "./registry";
import { templateGraph, WORKFLOW_TEMPLATES } from "./templates";

// Things a template can't know: your accounts, your sheet, your repo, your topic…
const LEFT_FOR_YOU = new Set(["credential", "spreadsheetId", "repo", "audience", "topic"]);

describe("workflow templates", () => {
  it("have unique ids", () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const t of WORKFLOW_TEMPLATES) {
    it(`"${t.name}" is a valid workflow out of the box`, () => {
      const graph = workflowGraphSchema.parse(templateGraph(t));
      expect(validateGraphWithRegistry(graph)).toEqual([]);

      for (const node of graph.nodes) {
        // Only the fields you're expected to fill in may be missing.
        const issues = nodeIssues(graph, node).filter((i) => !LEFT_FOR_YOU.has(i.field));
        expect(issues, `${t.id} / ${node.id}`).toEqual([]);

        // Every reference to another step points at a step that exists.
        for (const value of Object.values(node.parameters)) {
          for (const text of JSON.stringify(value ?? "").split('\\"').join('"').match(/\$\{[^}]*\}/g) ?? []) {
            for (const part of parseTemplate(text)) {
              if (part.kind === "ref" && part.source !== "$input" && part.source !== "$vars") expect(graph.nodes.map((n) => n.id), `${t.id} / ${node.id}: ${text}`).toContain(part.source);
            }
          }
        }
      }

      // The listed apps are exactly the ones its steps need.
      const needed = new Set(graph.nodes.map((n) => getDefinition(n.type)?.app).filter((a): a is string => Boolean(a)));
      expect(new Set(t.apps), t.id).toEqual(needed);
      expect(Boolean(t.needsAi), t.id).toBe(graph.nodes.some((n) => getDefinition(n.type)?.requiresAi));
    });
  }
});
