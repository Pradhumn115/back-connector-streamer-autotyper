import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage } from "@bcsa/shared";

type SendFn = (msg: ClientMessage) => void;

/**
 * Raises the phone's on-screen keyboard and forwards what it types to the
 * remote machine.
 *
 * ## Why a hidden input exists at all
 *
 * The canvas has `tabIndex={0}`, so it takes keyboard focus and receives key
 * events from a physical keyboard. But a canvas is not editable, and a mobile
 * OS raises its keyboard only for something that is — so on a phone the canvas
 * can be focused and still leave the user with no way to type. A hidden but
 * genuinely focusable `<input>` is the standard way out: it exists purely to be
 * the thing the OS agrees to open a keyboard for.
 *
 * ## Why `beforeinput` rather than `keydown`
 *
 * Android's keyboards mostly do not report real keys. Gboard fires `keydown`
 * with `key: "Unidentified"` and `keyCode: 229` — the IME sentinel meaning
 * "composition in progress, ask me later" — so a keydown-only implementation
 * types nothing on most Android phones. `beforeinput` reports the actual text,
 * which is what we need to forward.
 *
 * `keydown` is still handled, because it is the only source for keys that
 * produce no text: arrows, Escape, Tab, and anything from a Bluetooth keyboard
 * paired to the phone.
 *
 * ## Why the field holds a sentinel character
 *
 * Backspace at the start of an empty field is not an edit, so several mobile
 * keyboards emit nothing at all for it. Keeping one character in the field and
 * the caret after it means every backspace is a real deletion, which does get
 * reported. The value is reset after each event so the buffer cannot grow and
 * the field never scrolls.
 */
const SENTINEL = " ";

export interface UseSoftKeyboard {
  /** Attach to the hidden input. */
  ref: React.RefObject<HTMLInputElement>;
  /** True while the input holds focus, i.e. the keyboard is (probably) up. */
  open: boolean;
  /** Focus the input, raising the keyboard. Must run inside a user gesture. */
  show: () => void;
  /** Blur the input, dismissing the keyboard. */
  hide: () => void;
  /**
   * Handlers for the hidden input element.
   *
   * Only focus and blur: the `beforeinput` and `keydown` listeners are attached
   * natively instead, see the note in the hook.
   */
  handlers: {
    onFocus: () => void;
    onBlur: () => void;
  };
}

/** Keys worth forwarding from `keydown`, because they produce no text. */
const NON_TEXT_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

export function useSoftKeyboard(send: SendFn, enabled: boolean): UseSoftKeyboard {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const sendRef = useRef(send);
  const enabledRef = useRef(enabled);
  sendRef.current = send;
  enabledRef.current = enabled;

  /** Send one keystroke as a press and release, as the mouse path does. */
  const tap = useCallback((key: string, modifiers: ("ctrl" | "alt" | "shift" | "meta")[] = []) => {
    sendRef.current({ type: "key", action: "down", key, modifiers });
    sendRef.current({ type: "key", action: "up", key, modifiers });
  }, []);

  const reset = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.value = SENTINEL;
    // Caret after the sentinel, so the next backspace has something to delete.
    try {
      el.setSelectionRange(SENTINEL.length, SENTINEL.length);
    } catch {
      // Some browsers refuse selection APIs on certain input types; harmless.
    }
  }, []);

  useEffect(reset, [reset]);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el || !enabledRef.current) return;
    reset();
    el.focus({ preventScroll: true });
  }, [reset]);

  const hide = useCallback(() => ref.current?.blur(), []);

  /**
   * Native listeners, not React props.
   *
   * React's `onBeforeInput` is a *synthetic* event reconstructed from
   * `keypress` and `textInput`, not a subscription to the native `beforeinput`.
   * On a phone that distinction is the whole feature: the native event is the
   * only one that reports what an IME keyboard actually typed, and the React
   * one does not fire for it — which meant text typed on Android arrived
   * nowhere. `keydown` is attached the same way to keep both on one path.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onBeforeInput = (e: InputEvent) => {
      if (!enabledRef.current) return;
      const type = e.inputType;

      if (type === "insertText" || type === "insertCompositionText") {
        for (const ch of e.data ?? "") tap(ch);
      } else if (type === "insertFromPaste") {
        // Typed out character by character, so the remote sees ordinary
        // keystrokes rather than a paste it has no clipboard for.
        for (const ch of e.dataTransfer?.getData("text") ?? "") tap(ch);
      } else if (type === "insertLineBreak" || type === "insertParagraph") {
        tap("Enter");
      } else if (type.startsWith("deleteContent")) {
        tap(type === "deleteContentForward" ? "Delete" : "Backspace");
      }

      // Nothing typed here should ever appear in the field itself.
      e.preventDefault();
      reset();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // 229 is the IME sentinel meaning "composition in progress, ask later";
      // the real text arrives through beforeinput.
      if (e.keyCode === 229 || e.key === "Unidentified") return;
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;

      const modifiers: ("ctrl" | "alt" | "shift" | "meta")[] = [];
      if (e.ctrlKey) modifiers.push("ctrl");
      if (e.altKey) modifiers.push("alt");
      if (e.shiftKey) modifiers.push("shift");
      if (e.metaKey) modifiers.push("meta");

      // Plain printable keys are left to beforeinput, which also sees them —
      // handling both here would type every character twice on a hardware
      // keyboard. A shortcut produces no text, so it can only come from here.
      if (e.key.length === 1 && modifiers.length === 0) return;
      if (e.key.length > 1 && !NON_TEXT_KEYS.has(e.key) && modifiers.length === 0) return;

      e.preventDefault();
      tap(e.key, modifiers);
      reset();
    };

    el.addEventListener("beforeinput", onBeforeInput as EventListener);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput as EventListener);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [tap, reset]);

  const onFocus = useCallback(() => setOpen(true), []);
  const onBlur = useCallback(() => setOpen(false), []);

  // Losing control should not leave a keyboard hanging over the screen.
  useEffect(() => {
    if (!enabled) ref.current?.blur();
  }, [enabled]);

  return { ref, open, show, hide, handlers: { onFocus, onBlur } };
}
