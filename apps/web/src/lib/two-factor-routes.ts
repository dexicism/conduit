import "server-only";
import { ApiError } from "./api";
import { TwoFactorError } from "./two-factor";

/** Maps 2FA errors (wrong code, locked out) to 400s with their message. */
export async function twoFactorCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TwoFactorError) throw new ApiError(400, "invalid_request", err.message);
    throw err;
  }
}
