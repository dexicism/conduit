"use client";

import { createContext, useContext } from "react";
import type { AppInfo } from "@/lib/app-info";

/** Apps that can be connected on this server, provided by the editor page. */
export const AppsContext = createContext<AppInfo[]>([]);

export function useApps(): AppInfo[] {
  return useContext(AppsContext);
}
