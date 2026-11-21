/** Machine-readable error codes shared by the REST API, public API and MCP server. */
export const ERROR_CODES = [
  "invalid_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "revision_conflict",
  "in_use",
  "insufficient_credits",
  "rate_limited",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
  issues?: FieldIssue[];
}
