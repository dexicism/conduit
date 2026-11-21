import { handleWebhook } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

async function handler(req: Request, ctx: RouteContext<"/hook/[path]">) {
  const { path } = await ctx.params;
  try {
    return await handleWebhook(req, path, false);
  } catch (err) {
    console.error("[webhook] failed", err);
    return Response.json({ error: "internal_error", message: "Something went wrong" }, { status: 500 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
