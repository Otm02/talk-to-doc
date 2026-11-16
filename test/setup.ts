import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetHistoryLayers } from "@/lib/nav/history-layers";

// Vitest globals are off, so Testing Library can't register its own cleanup.
afterEach(() => {
  cleanup();
  // Layers live in module state and a pending history.go() would land in the
  // next test, closing its sheets. (A no-op in the node environment.)
  if (typeof window !== "undefined") resetHistoryLayers();
});
