import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicEnv } from "@/lib/public-env";
import { VoiceDev } from "./voice-dev";

export const metadata: Metadata = {
  title: "Voice engine (dev)",
  robots: { index: false },
};

// Temporary harness for the M6 realtime engine, removed when M7 ships the
// real chat UI. It exists only in development and in mock-transport builds.
export default function DevVoicePage() {
  if (!publicEnv.isDev && publicEnv.realtimeTransport !== "mock") notFound();
  return <VoiceDev />;
}
