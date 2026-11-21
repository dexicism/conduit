import { requirePageUser } from "@/lib/session";

/** Every /app route requires a signed-in user. Layout chrome lives in the (shell) and (editor) groups. */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  await requirePageUser("/app/workflows");
  return children;
}
