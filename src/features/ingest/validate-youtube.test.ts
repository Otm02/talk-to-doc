import { describe, expect, it } from "vitest";
import { checkYoutubeInput } from "./validate-youtube";

describe("checkYoutubeInput", () => {
  it("is empty for blank input", () => {
    expect(checkYoutubeInput("   ")).toEqual({ status: "empty" });
  });
  it.each([
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw",
    "youtube.com/watch?v=jNQXAC9IVRw",
    "jNQXAC9IVRw",
  ])("accepts %s", (input) => {
    expect(checkYoutubeInput(input)).toEqual({
      status: "valid",
      videoId: "jNQXAC9IVRw",
    });
  });
  it("explains a playlist link", () => {
    const r = checkYoutubeInput("https://www.youtube.com/playlist?list=PLabc");
    expect(r).toMatchObject({ status: "invalid", code: "youtube_no_video_id" });
  });
  it("rejects other sites", () => {
    expect(checkYoutubeInput("https://example.com/x")).toMatchObject({
      status: "invalid",
      code: "youtube_bad_url",
    });
  });
});
