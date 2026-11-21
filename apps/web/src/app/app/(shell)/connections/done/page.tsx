import type { Metadata } from "next";
import { OAuthDone } from "./oauth-done";

export const metadata: Metadata = { title: "Connect an app" };

export default async function OAuthDonePage(props: PageProps<"/app/connections/done">) {
  const sp = await props.searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  return <OAuthDone id={one(sp.id)} app={one(sp.app)} error={one(sp.error)} />;
}
