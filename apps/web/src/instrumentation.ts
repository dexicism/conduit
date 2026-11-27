/**
 * Starts the execution worker inside the Next.js server process in development
 * (one `npm run dev` runs everything). In production, run `apps/worker` as its
 * own process instead, or set CONDUIT_WORKER=inprocess deliberately.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A local install (CONDUIT_LOCAL=1) is one process for everything, like development.
  const mode = process.env.CONDUIT_WORKER ?? (process.env.NODE_ENV === "production" && process.env.CONDUIT_LOCAL !== "1" ? "off" : "inprocess");
  if (mode !== "inprocess") return;
  const { bootWorker } = await import("./worker-boot");
  await bootWorker();
}
