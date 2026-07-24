import type { InputBackend, ScreenSize } from "./index.js";

type Modifier = "ctrl" | "alt" | "shift" | "meta";

/**
 * Real InputBackend backed by @nut-tree-fork/nut-js. nut-js is imported lazily
 * so that unit tests (which use a fake backend) never load the native module.
 */
export async function createNutBackend(): Promise<InputBackend> {
  const nut = await import("@nut-tree-fork/nut-js");
  const { mouse, keyboard, screen, Point, Button, Key } = nut;

  // Disable nut-js's own inter-keystroke delay; we manage timing ourselves.
  keyboard.config.autoDelayMs = 0;
  mouse.config.autoDelayMs = 0;

  const buttonMap: Record<"left" | "right" | "middle", number> = {
    left: Button.LEFT,
    right: Button.RIGHT,
    middle: Button.MIDDLE,
  };

  // Browser key name -> nut-js Key. Only special / non-printable keys need this;
  // printable characters go through keyboard.type().
  const keyMap: Record<string, number> = {
    Enter: Key.Enter,
    Backspace: Key.Backspace,
    Tab: Key.Tab,
    Escape: Key.Escape,
    " ": Key.Space,
    ArrowLeft: Key.Left,
    ArrowRight: Key.Right,
    ArrowUp: Key.Up,
    ArrowDown: Key.Down,
    Delete: Key.Delete,
    Home: Key.Home,
    End: Key.End,
    PageUp: Key.PageUp,
    PageDown: Key.PageDown,
    Control: Key.LeftControl,
    Alt: Key.LeftAlt,
    Shift: Key.LeftShift,
    Meta: Key.LeftSuper,
    CapsLock: Key.CapsLock,
    F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
    F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  };

  const modifierKey: Record<Modifier, number> = {
    ctrl: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    meta: Key.LeftSuper,
  };

  function resolveKey(name: string): number | null {
    if (name in keyMap) return keyMap[name];
    if (name.length === 1) {
      const upper = name.toUpperCase();
      if (upper >= "A" && upper <= "Z") return Key[upper as keyof typeof Key] as number;
      if (name >= "0" && name <= "9") {
        return Key[`Num${name}` as keyof typeof Key] as number;
      }
    }
    return null;
  }

  return {
    async screenSize(): Promise<ScreenSize> {
      const [width, height] = await Promise.all([screen.width(), screen.height()]);
      return { width, height };
    },

    async moveMouse(x: number, y: number): Promise<void> {
      await mouse.setPosition(new Point(x, y));
    },

    async mouseButton(action, button): Promise<void> {
      const b = buttonMap[button];
      if (action === "down") await mouse.pressButton(b);
      else if (action === "up") await mouse.releaseButton(b);
      else await mouse.click(b);
    },

    async scroll(dx, dy): Promise<void> {
      if (dy > 0) await mouse.scrollDown(Math.abs(Math.round(dy)));
      else if (dy < 0) await mouse.scrollUp(Math.abs(Math.round(dy)));
      if (dx > 0) await mouse.scrollRight(Math.abs(Math.round(dx)));
      else if (dx < 0) await mouse.scrollLeft(Math.abs(Math.round(dx)));
    },

    async keyAction(action, key, modifiers): Promise<void> {
      const mods = modifiers.map((m) => modifierKey[m]);

      // Fast path: a printable character with no modifiers -> type it directly.
      if (action === "press" && mods.length === 0 && key.length === 1 && !(key in keyMap)) {
        await keyboard.type(key);
        return;
      }

      const resolved = resolveKey(key);
      if (resolved === null) {
        // Unknown named key with no printable fallback; type it if single char.
        if (key.length === 1) await keyboard.type(key);
        return;
      }

      if (action === "down") {
        await keyboard.pressKey(...mods, resolved);
      } else if (action === "up") {
        await keyboard.releaseKey(...mods, resolved);
      } else {
        await keyboard.pressKey(...mods, resolved);
        await keyboard.releaseKey(...mods, resolved);
      }
    },
  };
}
