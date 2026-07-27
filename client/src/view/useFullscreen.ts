import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Makes the screen view fill the display, and keeps the chrome out of the way
 * while it does.
 *
 * ## Why there are two mechanisms rather than one
 *
 * The Fullscreen API is not available everywhere this app runs. iOS Safari
 * implements `requestFullscreen` only on `<video>` elements — an arbitrary
 * element, including the canvas this app draws into, cannot go fullscreen at
 * all. Since iOS is a phone, and a phone is exactly where the letterboxed view
 * hurts most, "no fullscreen on iOS" would gut the feature on the platform
 * that needs it.
 *
 * So there are two: the real API where it exists, and otherwise a CSS mode that
 * pins the stage over the viewport and hides everything else. The CSS mode
 * cannot hide the browser's own UI, but it reclaims every pixel this app
 * controls, and it is what iOS gets. Desktop users who only want the chrome
 * gone without leaving the browser get the same thing on request.
 *
 * ## Why the exit affordance cannot be the Escape key
 *
 * While remote control is on, keystrokes are forwarded to the agent — Escape
 * included, because Escape is a key the remote machine legitimately needs. So
 * Escape cannot also mean "leave fullscreen" without stealing it from the
 * thing being controlled. Native fullscreen still exits on Escape because the
 * browser intercepts it before the page sees it; the CSS mode instead relies
 * on the on-screen exit button, which is why that button must never be
 * unreachable.
 */
export interface UseFullscreen {
  /** True in either mode. */
  active: boolean;
  /** True when the real Fullscreen API is driving it. */
  native: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

/** Vendor-prefixed shapes still shipped by WebKit. */
interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/** Screen Orientation lock, which TypeScript's DOM lib still omits. */
interface LockableOrientation extends ScreenOrientation {
  lock?: (orientation: string) => Promise<void>;
}

export function useFullscreen(targetRef: React.RefObject<HTMLElement>): UseFullscreen {
  const [active, setActive] = useState(false);
  const [native, setNative] = useState(false);
  /** Set while we are the ones calling exit, so the event handler is a no-op. */
  const exitingRef = useRef(false);

  const currentFullscreenElement = () => {
    const d = document as FullscreenDocument;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  };

  /**
   * A phone held upright shows a 16:9 desktop as a thin band across the middle;
   * landscape roughly triples the usable pixels. The lock is best-effort: it
   * needs fullscreen to already be active, and several browsers (iOS Safari
   * among them) refuse outright. A refusal is not a failure of the feature, so
   * it is swallowed rather than surfaced.
   */
  const tryLockLandscape = useCallback(() => {
    const orientation = globalThis.screen?.orientation as LockableOrientation | undefined;
    if (!orientation?.lock) return;
    // Only worth attempting where the display is actually portrait-shaped.
    if (globalThis.innerWidth > globalThis.innerHeight) return;
    void orientation.lock("landscape").catch(() => {
      // Not permitted here; the CSS mode still fills whatever we were given.
    });
  }, []);

  const unlockOrientation = useCallback(() => {
    try {
      globalThis.screen?.orientation?.unlock?.();
    } catch {
      // Never locked, or not permitted to unlock; nothing to undo.
    }
  }, []);

  const enter = useCallback(() => {
    const el = targetRef.current as FullscreenElement | null;
    if (!el) return;
    setActive(true);

    const request = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!request) {
      // iOS Safari and anything else without element fullscreen: CSS mode only.
      setNative(false);
      tryLockLandscape();
      return;
    }
    Promise.resolve(request())
      .then(() => {
        setNative(true);
        tryLockLandscape();
      })
      .catch(() => {
        // Refused (not a user gesture, or blocked by permissions policy). The
        // CSS mode still applies, so the feature degrades instead of failing.
        setNative(false);
        tryLockLandscape();
      });
  }, [targetRef, tryLockLandscape]);

  const exit = useCallback(() => {
    exitingRef.current = true;
    setActive(false);
    setNative(false);
    unlockOrientation();
    const d = document as FullscreenDocument;
    if (currentFullscreenElement()) {
      const leave = d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d);
      Promise.resolve(leave?.()).catch(() => {
        // Already left, e.g. the user pressed Escape first.
      });
    }
    // Cleared on the next tick so the change event this triggers is ignored.
    setTimeout(() => (exitingRef.current = false), 0);
  }, [unlockOrientation]);

  const toggle = useCallback(() => (active ? exit() : enter()), [active, enter, exit]);

  // The user can leave native fullscreen without touching our button — Escape,
  // the system gesture, a window change. The CSS mode must come off with it, or
  // the page would stay pinned over a viewport that is no longer fullscreen.
  useEffect(() => {
    const onChange = () => {
      if (exitingRef.current) return;
      if (!currentFullscreenElement()) {
        setActive(false);
        setNative(false);
        unlockOrientation();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [unlockOrientation]);

  return { active, native, enter, exit, toggle };
}

/**
 * Fades the chrome out while the view is idle, and brings it back on any sign
 * of activity — the behaviour of every video player, for the same reason: the
 * controls are worth less than the pixels they cover, until you reach for them.
 *
 * Only runs while `enabled`, so the ordinary windowed layout never hides
 * anything.
 */
export function useIdleChrome(enabled: boolean, timeoutMs = 3000): {
  visible: boolean;
  poke: () => void;
} {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poke = useCallback(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!enabled) return;
    timerRef.current = setTimeout(() => setVisible(false), timeoutMs);
  }, [enabled, timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      // Leaving fullscreen must not strand the chrome hidden.
      if (timerRef.current) clearTimeout(timerRef.current);
      setVisible(true);
      return;
    }
    poke();
    const events = ["pointermove", "pointerdown", "touchstart", "keydown", "wheel"] as const;
    for (const e of events) globalThis.addEventListener(e, poke, { passive: true });
    return () => {
      for (const e of events) globalThis.removeEventListener(e, poke);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, poke]);

  return { visible, poke };
}
