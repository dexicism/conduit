import type { Metadata } from "next";
import { WorkflowsView } from "./workflows-view";

export const metadata: Metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  return <WorkflowsView />;
}
