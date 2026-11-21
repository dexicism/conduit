import "server-only";
import type { NextResponse } from "next/server";
import { env } from "./env";
import { WORKSPACE_COOKIE } from "./workspaces";

export function setWorkspaceCookie<T extends NextResponse>(res: T, workspaceId: string): T {
  res.cookies.set(WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 365 * 86_400 });
  return res;
}
