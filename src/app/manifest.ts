import type { MetadataRoute } from "next";

// The web app manifest: lets a phone add the app to its home screen with a
// proper name and icon, and open it without browser chrome. Icons are made
// by scripts/make-icons.ts.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Talk to a Doc",
    short_name: "Talk to a Doc",
    description: "Upload a PDF or paste a YouTube link, then talk about it.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
