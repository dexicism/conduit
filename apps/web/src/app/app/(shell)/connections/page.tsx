import type { Metadata } from "next";
import { ConnectionsView } from "./connections-view";

export const metadata: Metadata = { title: "Connected apps" };

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
