import "server-only";
import { workflowGraphSchema, type WorkflowNode } from "@conduit/core";
import type { FormQuestion } from "@conduit/nodes";
import type { ObjectId } from "mongodb";
import { db } from "./db";
import { rt } from "./runtime";

export interface PublishedForm {
  workspaceId: ObjectId;
  workflowId: ObjectId;
  workflowName: string;
  versionId: ObjectId;
  graph: ReturnType<typeof workflowGraphSchema.parse>;
  node: WorkflowNode;
  title: string;
  description: string;
  questions: FormQuestion[];
  submitLabel: string;
  successMessage: string;
}

/** The live form at /form/:path, from the published version. */
export async function loadPublishedForm(path: string): Promise<PublishedForm | null> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(path)) return null;
  const t = await rt().triggers.findForm(path);
  if (!t?.versionId) return null;
  const [wf, version] = await Promise.all([
    db.collection("workflows").findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
    db.collection("workflow_versions").findOne({ _id: t.versionId }),
  ]);
  if (!wf || !version) return null;
  const graph = workflowGraphSchema.parse(version.graph);
  const node = graph.nodes.find((n) => n.id === t.nodeId && n.type === "trigger.form");
  if (!node) return null;
  const p = node.parameters;
  return {
    workspaceId: t.workspaceId,
    workflowId: t.workflowId,
    workflowName: String(wf.name),
    versionId: t.versionId,
    graph,
    node,
    title: String(p.title ?? "Form"),
    description: String(p.description ?? ""),
    questions: Array.isArray(p.questions) ? (p.questions as FormQuestion[]) : [],
    submitLabel: String(p.submitLabel || "Submit"),
    successMessage: String(p.successMessage || "Thanks! We got your response."),
  };
}

const MAX_TEXT = 5000;

/** Validates submitted values against the questions. Returns clean values keyed by question key, or errors. */
export function validateSubmission(questions: FormQuestion[], raw: Record<string, unknown>) {
  const values: Record<string, string | number | boolean | null> = {};
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const v = raw[q.name];
    if (q.type === "checkbox") {
      const on = v === true || v === "on" || v === "true";
      if (q.required && !on) errors[q.name] = "Please check this box";
      values[q.name] = on;
      continue;
    }
    const s = v === undefined || v === null ? "" : String(v).trim();
    if (!s) {
      if (q.required) errors[q.name] = "This is required";
      values[q.name] = null;
      continue;
    }
    if (s.length > (q.type === "textarea" ? MAX_TEXT : 500)) errors[q.name] = "That's too long";
    else if (q.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errors[q.name] = "Enter a valid email address";
    else if (q.type === "number" && !Number.isFinite(Number(s))) errors[q.name] = "Enter a number";
    else if (q.type === "select" && !(q.options ?? "").split(",").map((o) => o.trim()).includes(s)) errors[q.name] = "Choose one of the options";
    values[q.name] = q.type === "number" ? Number(s) : s;
  }
  return { values, errors };
}
