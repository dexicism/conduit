import { z } from "zod";

/** Lifecycle states exposed by the API. `archived` is derived from `archivedAt`. */
export const WORKFLOW_STATUSES = ["draft", "published", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_NAME_MAX = 150;
export const WORKFLOW_DESCRIPTION_MAX = 1000;

export const workflowNameSchema = z
  .string({ error: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(WORKFLOW_NAME_MAX, `Name must be ${WORKFLOW_NAME_MAX} characters or fewer`);

export const workflowDescriptionSchema = z
  .string()
  .trim()
  .max(WORKFLOW_DESCRIPTION_MAX, `Description must be ${WORKFLOW_DESCRIPTION_MAX} characters or fewer`)
  .nullable();

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const connectionTargetSchema = z.object({
  targetId: z.string().min(1),
  targetHandle: z.string().min(1).optional(),
});

/** Outgoing edges keyed by the source handle (e.g. "main", "true", "false", "loop", "done", "tool"). */
export const connectionsSchema = z.record(z.string().min(1), z.array(connectionTargetSchema).max(100));

export const nodeIdSchema = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_-]+$/, "Node IDs may contain letters, digits, '-' and '_' only");

export const workflowNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.string().min(1).max(250),
  typeVersion: z.number().int().positive().default(1),
  label: z.string().trim().min(1).max(200),
  parameters: z.record(z.string(), z.unknown()).default({}),
  credentialId: z.string().optional(),
  position: positionSchema,
  connections: connectionsSchema.default({}),
  disabled: z.boolean().optional(),
  onError: z.enum(["stop", "continue", "errorOutput"]).optional(),
  notes: z.string().max(2000).optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const stickyNoteSchema = z.object({
  id: nodeIdSchema,
  text: z.string().max(5000),
  position: positionSchema,
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
  color: z.string().max(32).optional(),
});
export type StickyNote = z.infer<typeof stickyNoteSchema>;

export const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().positive(),
});

export const ORIENTATIONS = ["horizontal", "vertical"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).max(500).default([]),
  stickyNotes: z.array(stickyNoteSchema).max(200).default([]),
  viewport: viewportSchema.default({ x: 0, y: 0, zoom: 1 }),
  /** Direction the flow reads in; drives handle placement and auto-layout. */
  orientation: z.enum(ORIENTATIONS).default("horizontal"),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export function emptyGraph(): WorkflowGraph {
  return { nodes: [], stickyNotes: [], viewport: { x: 0, y: 0, zoom: 1 }, orientation: "horizontal" };
}

/** Body of PUT /api/workflows/:id/draft. */
export const saveDraftInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  graph: workflowGraphSchema,
});
export type SaveDraftInput = z.infer<typeof saveDraftInputSchema>;

export interface SaveDraftResult {
  revision: number;
  updatedAt: string;
}

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

/**
 * Structural checks a schema cannot express: unique IDs and edges that point at
 * existing nodes. Returns an empty array for a valid graph.
 */
export function validateGraphStructure(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push({ nodeId: node.id, message: `Duplicate node ID "${node.id}"` });
    ids.add(node.id);
  }
  for (const note of graph.stickyNotes) {
    if (ids.has(note.id)) issues.push({ nodeId: note.id, message: `Duplicate ID "${note.id}"` });
    ids.add(note.id);
  }
  for (const node of graph.nodes) {
    for (const [handle, targets] of Object.entries(node.connections)) {
      for (const t of targets) {
        if (t.targetId === node.id) {
          issues.push({ nodeId: node.id, message: `Node "${node.id}" connects to itself on "${handle}"` });
        } else if (!graph.nodes.some((n) => n.id === t.targetId)) {
          issues.push({
            nodeId: node.id,
            message: `Connection "${handle}" from "${node.id}" points to missing node "${t.targetId}"`,
          });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export const createWorkflowInputSchema = z.object({
  name: workflowNameSchema,
  description: workflowDescriptionSchema.optional(),
  /** Client-generated UUID; repeating it returns the original workflow instead of a duplicate. */
  requestId: z.uuid().optional(),
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;

export const updateWorkflowInputSchema = z
  .object({
    name: workflowNameSchema.optional(),
    description: workflowDescriptionSchema.optional(),
    archived: z.boolean().optional(),
    settings: z
      .object({ errorWorkflowId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid workflow").nullable().optional() })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInputSchema>;

export const LIST_FILTERS = ["active", "archived"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export const listWorkflowsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(LIST_FILTERS).default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;

/** Shape returned by the API (dates as ISO strings). */
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  revision: number;
  nodeCount: number;
  /** Draft revision that is live, or null when not published. */
  publishedRevision: number | null;
  publishedAt: string | null;
  settings: { errorWorkflowId: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: WorkflowGraph;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
