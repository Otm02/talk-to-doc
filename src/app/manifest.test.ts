import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const root = join(import.meta.dirname, "..", "..");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): string {
  const b = readFileSync(path);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

describe("web app manifest", () => {
  const m = manifest();

  it("names the app and opens it standalone from the start page", () => {
    expect(m.name).toBe("Talk to a Doc");
    expect(m.short_name?.length).toBeLessThanOrEqual(13);
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("lists icons that exist and are the size they claim", () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual([
      "192x192",
      "512x512",
      "512x512",
    ]);
    for (const icon of icons) {
      const file = join(root, "public", icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      expect(pngSize(file)).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    }
    // Android crops a maskable icon to its own shape; one must be marked so.
    expect(icons.filter((i) => i.purpose === "maskable")).toHaveLength(1);
  });

  it("has the icons Next links by file name", () => {
    for (const name of ["icon.svg", "apple-icon.png", "favicon.ico"]) {
      expect(existsSync(join(root, "src", "app", name)), name).toBe(true);
    }
    expect(pngSize(join(root, "src", "app", "apple-icon.png"))).toBe("180x180");
  });
});
