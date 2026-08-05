/** Reads/writes the agent machine's system clipboard. Text-only. */
export interface ClipboardBackend {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
}

/**
 * Real ClipboardBackend backed by @nut-tree-fork/nut-js, which already exposes
 * a cross-platform clipboard API — no new dependency needed.
 *
 * nut-js is imported lazily, matching input/nutBackend.ts and
 * autotyper/nutTyping.ts, so unit tests never load the native module.
 */
export async function createNutClipboardBackend(): Promise<ClipboardBackend> {
  const { clipboard } = await import("@nut-tree-fork/nut-js");
  return {
    getContent: () => clipboard.getContent(),
    setContent: (text: string) => clipboard.setContent(text),
  };
}
