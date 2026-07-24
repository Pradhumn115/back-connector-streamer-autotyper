declare module "screenshot-desktop" {
  interface ScreenshotOptions {
    format?: "png" | "jpg";
    screen?: number | string;
    filename?: string;
  }
  /** Captures the screen and resolves to an image Buffer. */
  function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  namespace screenshot {
    function listDisplays(): Promise<Array<{ id: number | string; name: string }>>;
  }
  export = screenshot;
}
