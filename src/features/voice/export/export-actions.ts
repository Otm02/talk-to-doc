import { downloadText } from "@/lib/download";

// The two ways out for a transcript. Both report whether they worked, so the
// UI can say "Copied" or point at the other one.

interface CopyEnvironment {
  clipboard?: { writeText?: (text: string) => Promise<void> } | undefined;
  document?: Document | undefined;
}

function browser(): CopyEnvironment {
  return {
    clipboard: globalThis.navigator?.clipboard,
    document: globalThis.document,
  };
}

/**
 * The pre-Clipboard-API way: select the text in an off-screen field and ask
 * the browser to copy the selection. Still needed on http origins and in
 * in-app browsers, where navigator.clipboard is missing or refuses.
 */
function legacyCopy(text: string, doc: Document | undefined): boolean {
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const field = doc.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  // On screen for the selection to count, but never visible or focus-scrolled.
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
  doc.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** true when the text is on the clipboard. Never throws. */
export async function copyText(
  text: string,
  env: CopyEnvironment = browser(),
): Promise<boolean> {
  const write = env.clipboard?.writeText;
  if (typeof write === "function") {
    try {
      await write.call(env.clipboard, text);
      return true;
    } catch {
      // Permission refused or the page lost focus: try the older way.
    }
  }
  return legacyCopy(text, env.document);
}

export function downloadMarkdown(filename: string, markdown: string): boolean {
  return downloadText(filename, markdown, "text/markdown;charset=utf-8");
}
