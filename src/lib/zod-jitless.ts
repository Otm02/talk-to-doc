import { z } from "zod";

// zod speeds up object parsing by compiling parsers with `new Function`, and
// finds out whether it may by trying once. Our CSP has no 'unsafe-eval', so in
// the browser that one try is a blocked eval: a CSP violation in the console
// on every page load. Turning the JIT off skips the attempt. Parsing a few
// small event objects without it costs nothing a user could notice.
//
// Import this (for its side effect) from every module whose schemas run in the
// browser, before any of them parses.
z.config({ jitless: true });
