import type { Metadata } from "next";
import { requirePageUser } from "@/lib/session";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = { title: "Team & settings" };

export default async function SettingsPage() {
  const { user, workspace } = await requirePageUser("/app/settings");
  return (
    <SettingsView
      key={workspace.workspaceId.toHexString()}
      me={user.id}
      workspace={{ id: workspace.workspaceId.toHexString(), name: workspace.workspaceName, role: workspace.role, personal: workspace.personal, plan: workspace.plan }}
    />
  );
}
