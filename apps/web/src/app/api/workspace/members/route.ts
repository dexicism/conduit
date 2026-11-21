import { json, route } from "@/lib/api";
import { requireApiContext } from "@/lib/session";
import { listInvitations, listMembers } from "@/lib/teams";
import { canManage } from "@/lib/workspaces";

/** Members, plus pending invitations for those who manage the workspace. */
export const GET = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const members = await listMembers(workspace.workspaceId);
  const invitations = canManage(workspace.role) ? await listInvitations(workspace.workspaceId) : [];
  return json({ members, invitations });
});
