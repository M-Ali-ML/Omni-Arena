/**
 * Rendering of a failed slot for protocols whose only per-message channel is
 * assistant text (AG-UI text messages, OpenAI `delta.content`).
 *
 * Those protocols have no per-message error taxonomy, so a failure has to be
 * carried twice: once structurally (AG-UI's `CUSTOM slot_error`, the OpenAI
 * adapter's `omni_arena_error` extension) for clients that read it, and once as
 * marked text so a client that only renders content shows *something* instead
 * of a permanently blank column. The marker is what makes the text
 * distinguishable from the model having said those words.
 */
export const SLOT_ERROR_MARKER = "[omni-arena:slot-error]";

/** The marked, human-readable form of a slot failure. */
export function slotErrorText(message: string): string {
  return `\n\n${SLOT_ERROR_MARKER} ${message}\n`;
}
