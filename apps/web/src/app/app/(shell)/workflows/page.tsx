import type { Metadata } from "next";
import { WorkflowsView } from "./workflows-view";

export const metadata: Metadata = { title: "Workflows" };

export default async function WorkflowsPage(props: PageProps<"/app/workflows">) {
  const sp = await props.searchParams;
  return <WorkflowsView openTemplates={sp.templates === "1"} />;
}
