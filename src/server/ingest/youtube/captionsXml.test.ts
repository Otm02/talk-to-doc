import { describe, expect, it } from "vitest";
import {
  CaptionsXmlError,
  decodeEntities,
  parseCaptionsXml,
} from "./captionsXml";

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8" ?><transcript>${body}</transcript>`;

describe("parseCaptionsXml", () => {
  it("reads start and dur as seconds and returns milliseconds", () => {
    const xml = wrap(
      '<text start="12.34" dur="2.5">Hello there</text><text start="15" dur="1">Bye</text>',
    );
    expect(parseCaptionsXml(xml)).toEqual([
      { startMs: 12340, durMs: 2500, text: "Hello there" },
      { startMs: 15000, durMs: 1000, text: "Bye" },
    ]);
  });

  it("defaults a missing dur to 0", () => {
    expect(parseCaptionsXml(wrap('<text start="3">Hi</text>'))).toEqual([
      { startMs: 3000, durMs: 0, text: "Hi" },
    ]);
  });

  it("decodes the double-encoded entities YouTube sends", () => {
    const xml = wrap(
      '<text start="0" dur="1">it&amp;#39;s &amp;quot;fine&amp;quot; &amp;amp; more</text>',
    );
    expect(parseCaptionsXml(xml)[0]?.text).toBe('it\'s "fine" & more');
  });

  it("decodes single-encoded, numeric and hex entities", () => {
    const xml = wrap(
      '<text start="0" dur="1">a &lt;3 b &#8217; c &#x2019; d &amp; e</text>',
    );
    expect(parseCaptionsXml(xml)[0]?.text).toBe("a <3 b ’ c ’ d & e");
  });

  it("strips markup the captioner left in", () => {
    const xml = wrap(
      '<text start="0" dur="1">&lt;font color="#ccc"&gt;one&lt;/font&gt; <i>two</i></text>',
    );
    expect(parseCaptionsXml(xml)[0]?.text).toBe("one two");
  });

  it("collapses newlines and non-breaking spaces", () => {
    const xml = wrap('<text start="0" dur="1">a\n  b&amp;nbsp;c</text>');
    expect(parseCaptionsXml(xml)[0]?.text).toBe("a b c");
  });

  it("skips empty and self-closing elements", () => {
    const xml = wrap(
      '<text start="0" dur="1"></text><text start="1" dur="1"/><text start="2" dur="1">   </text><text start="3" dur="1">kept</text>',
    );
    expect(parseCaptionsXml(xml).map((s) => s.text)).toEqual(["kept"]);
  });

  it("drops a segment that is only a sound tag", () => {
    const xml = wrap(
      '<text start="0" dur="1">[Music]</text><text start="1" dur="1">[Applause] [Laughter]</text><text start="2" dur="1">[Music] and then we begin</text><text start="3" dur="1">a [pause] b</text>',
    );
    expect(parseCaptionsXml(xml).map((s) => s.text)).toEqual([
      "[Music] and then we begin",
      "a [pause] b",
    ]);
  });

  it("skips elements with a missing or invalid start", () => {
    const xml = wrap(
      '<text dur="1">no start</text><text start="abc" dur="1">bad</text><text start="-1" dur="1">neg</text><text start="4" dur="1">ok</text>',
    );
    expect(parseCaptionsXml(xml).map((s) => s.text)).toEqual(["ok"]);
  });

  it("sorts by start time", () => {
    const xml = wrap(
      '<text start="5" dur="1">b</text><text start="1" dur="1">a</text>',
    );
    expect(parseCaptionsXml(xml).map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("returns an empty list for a document with no captions", () => {
    expect(parseCaptionsXml(wrap(""))).toEqual([]);
    expect(parseCaptionsXml("")).toEqual([]);
  });

  it("rejects a DOCTYPE", () => {
    expect(() =>
      parseCaptionsXml("<!DOCTYPE foo><transcript></transcript>"),
    ).toThrow(CaptionsXmlError);
  });

  it("rejects the billion-laughs payload without expanding it", () => {
    const lol = [
      '<?xml version="1.0"?>',
      "<!DOCTYPE lolz [",
      '<!ENTITY lol "lol">',
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
      "]>",
      '<transcript><text start="0" dur="1">&lol3;</text></transcript>',
    ].join("\n");
    expect(() => parseCaptionsXml(lol)).toThrow(CaptionsXmlError);
  });

  it("rejects an external entity declaration", () => {
    const xxe =
      '<!ENTITY xxe SYSTEM "file:///etc/passwd"><transcript><text start="0" dur="1">&xxe;</text></transcript>';
    expect(() => parseCaptionsXml(xxe)).toThrow(CaptionsXmlError);
  });

  it("leaves an unknown entity as plain text instead of expanding it", () => {
    const xml = wrap('<text start="0" dur="1">&nosuchentity; stays</text>');
    expect(parseCaptionsXml(xml)[0]?.text).toBe("&nosuchentity; stays");
  });

  it("handles a large input in linear time", () => {
    const body =
      '<text start="1" dur="1">line &amp;#39;x&amp;#39;</text>'.repeat(20_000);
    const started = Date.now();
    expect(parseCaptionsXml(wrap(body))).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("decodeEntities", () => {
  it("is one pass, not recursive", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("replaces invalid code points with U+FFFD", () => {
    expect(decodeEntities("&#0; &#55296; &#1114112;")).toBe("� � �");
  });
});
