import type { Metadata } from "next";
import { requirePageUser } from "@/lib/session";
import { BillingView } from "./billing-view";

export const metadata: Metadata = { title: "Plan & credits" };

export default async function BillingPage(props: PageProps<"/app/billing">) {
  const { workspace } = await requirePageUser("/app/billing");
  const sp = await props.searchParams;
  const notice = sp.checkout === "success" || sp.checkout === "canceled" ? sp.checkout : undefined;
  return <BillingView key={workspace.workspaceId.toHexString()} notice={notice} />;
}
