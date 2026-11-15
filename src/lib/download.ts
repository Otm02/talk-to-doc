// Saves text as a file from the browser. Shared by the transcript export and
// the dev event recorder.

export const REVOKE_DELAY_MS = 10_000;

/** false when the browser cannot build the file (no Blob URLs). */
export function downloadText(
  filename: string,
  text: string,
  mime: string,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([text], { type: mime }));
  } catch {
    return false;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari (iOS especially) starts the download after click() returns;
  // revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  return true;
}
