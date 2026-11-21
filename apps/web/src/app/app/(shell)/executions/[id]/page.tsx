import type { Metadata } from "next";
import { ExecutionDetailView } from "./execution-detail-view";

export const metadata: Metadata = { title: "Run" };

export default async function ExecutionPage(props: PageProps<"/app/executions/[id]">) {
  const { id } = await props.params;
  return <ExecutionDetailView id={id} />;
}
