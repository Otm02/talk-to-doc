import { publicEnv } from "@/lib/public-env";

/**
 * Dev tools (cost overlay, event recorder) show in development or when the
 * URL has ?debug=1. They only read what the browser already has and report
 * nothing to the server.
 */
export function isDebug(
  search: string = globalThis.location?.search ?? "",
  dev: boolean = publicEnv.isDev,
): boolean {
  return dev || new URLSearchParams(search).get("debug") === "1";
}
