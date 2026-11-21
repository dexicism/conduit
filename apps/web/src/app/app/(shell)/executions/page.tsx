import type { Metadata } from "next";
import { ExecutionsView } from "./executions-view";

export const metadata: Metadata = { title: "Runs" };

export default async function ExecutionsPage(props: PageProps<"/app/executions">) {
  const sp = await props.searchParams;
  const workflowId = typeof sp.workflowId === "string" && /^[a-f\d]{24}$/i.test(sp.workflowId) ? sp.workflowId : undefined;
  return <ExecutionsView initialWorkflowId={workflowId} />;
}
