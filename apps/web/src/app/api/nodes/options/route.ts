import { z } from "zod";
import { json, parse, readJson, route } from "@/lib/api";
import { appCall } from "@/lib/connections";
import { rt } from "@/lib/runtime";
import { requireApiContext } from "@/lib/session";

const bodySchema = z.object({
  source: z.enum(["slack.channels", "google.sheets"]),
  credentialId: z.string().min(1, "Choose an account first"),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** Live suggestions for a field (e.g. Slack channels), loaded with the chosen account. */
export const POST = route(async (req) => {
  const { workspace } = await requireApiContext(req);
  const body = parse(bodySchema, await readJson(req));
  const options = await appCall(() => rt().integrations.dynamicOptions(workspace.workspaceId, body.source, body.credentialId, body.params));
  return json({ options });
});
