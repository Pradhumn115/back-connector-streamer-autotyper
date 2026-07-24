import type { KeyMessage, MouseMessage } from "@bcsa/shared";
import { toPixel } from "./coords.js";

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * Abstraction over the OS input backend so the controller can be unit-tested
 * without the native nut-js module. See createNutBackend() for the real one.
 */
export interface InputBackend {
  screenSize(): Promise<ScreenSize>;
  moveMouse(x: number, y: number): Promise<void>;
  mouseButton(action: "down" | "up" | "click", button: "left" | "right" | "middle"): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  keyAction(
    action: "down" | "up" | "press",
    key: string,
    modifiers: Array<"ctrl" | "alt" | "shift" | "meta">,
  ): Promise<void>;
}

/**
 * Applies incoming client control messages to the OS via an InputBackend,
 * translating normalized coordinates to pixels using the cached screen size.
 */
export class InputController {
  private size: ScreenSize | null = null;

  constructor(private readonly backend: InputBackend) {}

  async screenSize(): Promise<ScreenSize> {
    if (!this.size) this.size = await this.backend.screenSize();
    return this.size;
  }

  async applyMouse(msg: MouseMessage): Promise<void> {
    if (msg.action === "scroll") {
      await this.backend.scroll(msg.dx ?? 0, msg.dy ?? 0);
      return;
    }

    // Position first (if provided) so clicks land where the client aimed.
    if (typeof msg.x === "number" && typeof msg.y === "number") {
      const { width, height } = await this.screenSize();
      await this.backend.moveMouse(toPixel(msg.x, width), toPixel(msg.y, height));
    }

    if (msg.action === "move") return;
    await this.backend.mouseButton(msg.action, msg.button ?? "left");
  }

  async applyKey(msg: KeyMessage): Promise<void> {
    await this.backend.keyAction(msg.action, msg.key, msg.modifiers ?? []);
  }
}
