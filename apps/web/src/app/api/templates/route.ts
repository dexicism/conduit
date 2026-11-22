import { getApp, WORKFLOW_TEMPLATES } from "@conduit/nodes";
import { json, route } from "@/lib/api";
import { aiStatus, availableApps } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

/** Starter workflows, with whether this server can run each one. */
export const GET = route(async (req) => {
  await requireApiContext(req);
  const apps = new Set(availableApps());
  const ai = aiStatus().enabled;
  return json({
    templates: WORKFLOW_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      setup: t.setup ?? null,
      apps: t.apps.map((id) => ({ id, name: getApp(id)?.name ?? id })),
      needsAi: Boolean(t.needsAi),
      steps: t.steps.length,
      // Missing pieces this server doesn't offer (an app not configured, or no AI model).
      unavailable: [...t.apps.filter((a) => !apps.has(a)), ...(t.needsAi && !ai ? ["ai"] : [])],
    })),
  });
});
