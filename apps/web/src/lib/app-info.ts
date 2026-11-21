import type { AppDefinition } from "@conduit/nodes";

/** What the UI needs to render an app's connect form. Never includes secrets. */
export interface AppInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  help: string | null;
  auth: AppDefinition["auth"];
}

/** A saved account as the API returns it. */
export interface CredentialView {
  id: string;
  app: string;
  label: string;
  account: string | null;
  status: "ok" | "error";
  lastError: string | null;
  testedAt: string | null;
  createdAt: string;
}
