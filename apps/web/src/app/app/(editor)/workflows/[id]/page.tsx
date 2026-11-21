import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { WorkflowEditor } from "@/components/editor/workflow-editor";
import { ApiError } from "@/lib/api";
import { appCatalog } from "@/lib/connections";
import { aiStatus } from "@/lib/runtime";
import { requirePageUser } from "@/lib/session";
import { getWorkflow } from "@/lib/workflows-repo";

const load = cache(async (id: string) => {
  const { workspace } = await requirePageUser(`/app/workflows/${id}`);
  try {
    return await getWorkflow(workspace.workspaceId, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
});

export async function generateMetadata(props: PageProps<"/app/workflows/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: (await load(id)).name };
}

export default async function WorkflowEditorPage(props: PageProps<"/app/workflows/[id]">) {
  const { id } = await props.params;
  const workflow = await load(id);
  // key: a fresh editor store if the user navigates between workflows.
  return <WorkflowEditor key={workflow.id} initial={workflow} ai={aiStatus()} apps={appCatalog()} />;
}
