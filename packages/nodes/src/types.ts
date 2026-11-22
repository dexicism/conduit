/**
 * Declarative node definitions. One definition drives the node picker, the
 * config form, parameter validation, handle layout and execution.
 */

export type NodeCategory = "trigger" | "ai" | "tool" | "app" | "flow" | "core" | "transform";

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: "Triggers",
  ai: "AI",
  tool: "Agent tools",
  app: "Apps",
  flow: "Flow control",
  core: "Core",
  transform: "Transform data",
};

/** Output handle on an AI Agent that tool steps attach to. Never carries items. */
export const TOOL_HANDLE = "tool";
/** Input handle on a tool step. */
export const AGENT_HANDLE = "agent";

export const MODEL_OPTIONS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast and capable)" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, lowest cost)" },
] as const;
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Show a field only when another field has one of the listed values. */
export interface ShowIf {
  field: string;
  equals: readonly unknown[];
}

interface FieldBase {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  showIf?: ShowIf;
}

export interface StringField extends FieldBase {
  kind: "string";
  default?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Accepts `${[...]}` references (default true). */
  expression?: boolean;
  /** Extra format check applied when the value has no references. */
  format?: "url" | "cron" | "email" | "path-segment" | "tool-name";
  /** Accepts `={{AI(...)}}` placeholders the agent fills when calling the tool. */
  aiFill?: boolean;
  /** Suggestions loaded from the connected account (see `/api/nodes/options`). */
  dynamicOptions?: DynamicOptionsSource;
}

/** Live lists offered as suggestions next to a text field. */
export type DynamicOptionsSource = "slack.channels" | "google.sheets";

export interface NumberField extends FieldBase {
  kind: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Accepts a reference string instead of a number. */
  expression?: boolean;
}

export interface BooleanField extends FieldBase {
  kind: "boolean";
  default?: boolean;
}

export interface SelectField extends FieldBase {
  kind: "select";
  options: ReadonlyArray<{ value: string; label: string }>;
  default?: string;
}

export interface JsonField extends FieldBase {
  kind: "json";
  default?: string;
  placeholder?: string;
}

export interface CodeField extends FieldBase {
  kind: "code";
  language: "javascript";
  default?: string;
}

/** List of {key, value} pairs, e.g. headers or query params. */
export interface KeyValueField extends FieldBase {
  kind: "keyValue";
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/** Condition group used by If / Filter. */
export interface ConditionsField extends FieldBase {
  kind: "conditions";
}

/** Switch cases. Each case becomes an output handle. */
export interface CasesField extends FieldBase {
  kind: "cases";
}

/** Named output fields with a value expression and type (Set Fields). */
export interface AssignmentsField extends FieldBase {
  kind: "assignments";
}

/** Picks another workflow in the same workspace. */
export interface WorkflowRefField extends FieldBase {
  kind: "workflow";
}

/** Questions on a hosted form (Form trigger). */
export interface FormFieldsField extends FieldBase {
  kind: "formFields";
}

/** Picks a connected account (credential) of one app in the workspace. */
export interface CredentialField extends FieldBase {
  kind: "credential";
  app: string;
}

export type ParamField =
  | StringField
  | NumberField
  | BooleanField
  | SelectField
  | JsonField
  | CodeField
  | KeyValueField
  | ConditionsField
  | CasesField
  | AssignmentsField
  | WorkflowRefField
  | CredentialField
  | FormFieldsField;

export interface HandleSpec {
  id: string;
  label?: string;
}

export interface NodeDefinition {
  type: string;
  version: number;
  name: string;
  description: string;
  category: NodeCategory;
  /** lucide-react icon name, resolved by the UI. */
  icon: string;
  /** Accent token used by the node card. */
  color: "indigo" | "amber" | "emerald" | "sky" | "rose" | "violet" | "slate";
  /** Extra words that should match this node in search. */
  keywords?: string[];
  inputs: HandleSpec[];
  /** Static outputs, or computed from the current parameters (Switch). */
  outputs: HandleSpec[] | ((params: Record<string, unknown>) => HandleSpec[]);
  /** Input handles that may receive an edge that closes a cycle (loop back). */
  loopInputs?: string[];
  /** AI Agent: has a tool port that tool steps connect to. */
  toolPort?: boolean;
  /** Needs a configured AI model to run (hidden when AI is off). */
  requiresAi?: boolean;
  /** App this step talks to (see APP_DEFINITIONS). */
  app?: string;
  /** App action that can also be attached to an agent as a tool. */
  asTool?: { name: string; description: string };
  fields: ParamField[];
  /** Called once when the node is added, for values that must be unique (webhook path). */
  initParameters?: () => Record<string, unknown>;
  /** Shape of one output item; drives the variable picker before the first run. */
  outputSample: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Structured parameter value shapes
// ---------------------------------------------------------------------------

export interface KeyValuePair {
  key: string;
  value: string;
}

export const CONDITION_OPERATORS = [
  { value: "equals", label: "is equal to", unary: false },
  { value: "notEquals", label: "is not equal to", unary: false },
  { value: "contains", label: "contains", unary: false },
  { value: "notContains", label: "does not contain", unary: false },
  { value: "startsWith", label: "starts with", unary: false },
  { value: "endsWith", label: "ends with", unary: false },
  { value: "gt", label: "is greater than", unary: false },
  { value: "gte", label: "is greater than or equal to", unary: false },
  { value: "lt", label: "is less than", unary: false },
  { value: "lte", label: "is less than or equal to", unary: false },
  { value: "matches", label: "matches regex", unary: false },
  { value: "isEmpty", label: "is empty", unary: true },
  { value: "isNotEmpty", label: "is not empty", unary: true },
  { value: "isTrue", label: "is true", unary: true },
  { value: "isFalse", label: "is false", unary: true },
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["value"];

export interface ConditionRule {
  id: string;
  left: string;
  operator: ConditionOperator;
  right: string;
}

export interface ConditionGroup {
  combinator: "and" | "or";
  rules: ConditionRule[];
}

export interface SwitchCase {
  id: string;
  value: string;
  label?: string;
}

export const FORM_FIELD_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "number", label: "Number" },
  { value: "select", label: "Choice" },
  { value: "checkbox", label: "Checkbox" },
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]["value"];

export interface FormQuestion {
  id: string;
  /** Key in the submitted data, e.g. "email". */
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  /** Choice: comma-separated options. */
  options?: string;
}

export interface Assignment {
  id: string;
  name: string;
  value: string;
  type: "string" | "number" | "boolean" | "json";
}
