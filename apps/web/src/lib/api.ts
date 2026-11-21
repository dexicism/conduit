import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import type { ApiErrorBody, ErrorCode, FieldIssue } from "@conduit/core";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public issues?: FieldIssue[],
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: number | ResponseInit): NextResponse<T> {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

function errorResponse(err: ApiError): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: err.code, message: err.message };
  if (err.issues?.length) body.issues = err.issues;
  return NextResponse.json(body, { status: err.status });
}

/** Wraps a route handler: maps ApiError to JSON, logs and hides unexpected errors. */
export function route<Ctx>(handler: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      console.error("[api] unhandled error", err);
      return errorResponse(new ApiError(500, "internal_error", "Something went wrong. Please try again."));
    }
  };
}

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new ApiError(400, "validation_failed", issues[0]?.message ?? "Invalid request", issues);
  }
  return result.data;
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ApiError(400, "invalid_request", "Expected a JSON request body");
  }
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body is not valid JSON");
  }
}

export function searchParamsObject(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}
