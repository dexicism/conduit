import "server-only";
import { createVariables, isVariableError } from "@conduit/runtime";
import { ApiError } from "./api";
import { db } from "./db";
import { rt } from "./runtime";

export const variables = () => createVariables(db, rt().integrations.vault);

/** Turns a variable problem into the right HTTP error. */
export async function variableCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isVariableError(e)) {
      const status = e.code === "not_found" ? 404 : e.code === "exists" ? 409 : 400;
      throw new ApiError(status, status === 404 ? "not_found" : "validation_failed", e.message);
    }
    throw e;
  }
}
