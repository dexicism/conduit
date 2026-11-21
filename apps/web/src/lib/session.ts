import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { ApiError } from "./api";
import { sessionNeedsTwoFactor } from "./two-factor";
import { findMemberWorkspace, resolveWorkspace, WORKSPACE_COOKIE, type WorkspaceContext } from "./workspaces";

export interface AppUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** Cached per request so layouts and pages share one lookup. */
export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

function toAppUser(u: { id: string; name: string; email: string; image?: string | null }): AppUser {
  return { id: u.id, name: u.name, email: u.email, image: u.image ?? null };
}

/** For server components: redirects to /login when signed out. */
export async function requirePageUser(nextPath = "/app"): Promise<{ user: AppUser; workspace: WorkspaceContext }> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (await sessionNeedsTwoFactor(session.user.id, session.session.id)) redirect(`/2fa?next=${encodeURIComponent(nextPath)}`);
  const user = toAppUser(session.user);
  const workspace = await resolveWorkspace(user, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  return { user, workspace };
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** For route handlers: throws 401/403 ApiErrors. Honors an `x-workspace-id` header when the user is a member. */
export async function requireApiContext(req: Request): Promise<{ user: AppUser; workspace: WorkspaceContext }> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new ApiError(401, "unauthorized", "Sign in to continue");
  if (await sessionNeedsTwoFactor(session.user.id, session.session.id)) {
    throw new ApiError(401, "unauthorized", "Enter your two-step verification code to continue");
  }
  const user = toAppUser(session.user);
  const requested = req.headers.get("x-workspace-id");
  if (requested) {
    const ws = await findMemberWorkspace(user.id, requested);
    if (!ws) throw new ApiError(403, "forbidden", "You are not a member of that workspace");
    return { user, workspace: ws };
  }
  // The editor and API calls follow the workspace chosen in the switcher (cookie).
  return { user, workspace: await resolveWorkspace(user, cookieValue(req, WORKSPACE_COOKIE)) };
}
