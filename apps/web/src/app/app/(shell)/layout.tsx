import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/lib/session";
import { listUserWorkspaces } from "@/lib/workspaces";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const { user, workspace } = await requirePageUser("/app/workflows");
  const workspaces = await listUserWorkspaces(user.id);
  return (
    <AppShell user={user} workspaceName={workspace.workspaceName} workspaces={workspaces} currentWorkspaceId={workspace.workspaceId.toHexString()}>
      {children}
    </AppShell>
  );
}
