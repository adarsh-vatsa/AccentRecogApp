import { createRequire } from "node:module";

export interface CheckResult {
  available: boolean;
  connected: boolean;
  errors: string[];
  blocked: string[];
  console: string[];
  screenshots: Array<{ label: string; png: Buffer }>;
  note?: string;
}

/** Loads a house version in a headless browser and reports what happened. */
export interface Checker {
  check(frameUrl: string, houseName: string): Promise<CheckResult>;
  close(): Promise<void>;
}

const VIEWPORTS = [
  { label: "desktop 1024x640", width: 1024, height: 640 },
  { label: "phone 390x780", width: 390, height: 780 },
];

type Browser = { newContext(o: object): Promise<any>; close(): Promise<void> };

/**
 * Uses Playwright's Chromium through the platform's own check harness page, so the
 * house runs with the real sandbox, CSP and bridge, just against fake data.
 */
export class BrowserChecker implements Checker {
  private browser: Promise<Browser> | undefined;

  constructor(private readonly platformOrigin: string) {}

  private async getBrowser(): Promise<Browser | null> {
    if (!this.browser) {
      let playwright: { chromium: { launch(o?: object): Promise<Browser> } };
      try {
        playwright = createRequire(import.meta.url)("playwright");
      } catch {
        return null;
      }
      this.browser = playwright.chromium.launch();
      this.browser.catch(() => (this.browser = undefined));
    }
    return this.browser;
  }

  async check(frameUrl: string, houseName: string): Promise<CheckResult> {
    const browser = await this.getBrowser().catch(() => null);
    if (!browser) {
      return { available: false, connected: false, errors: [], blocked: [], console: [], screenshots: [], note: "No headless browser is installed on this server, so the house could not be rendered." };
    }
    const result: CheckResult = { available: true, connected: false, errors: [], blocked: [], console: [], screenshots: [] };
    const harness = `${this.platformOrigin}/check-harness.html#${new URLSearchParams({ frame: frameUrl, name: houseName })}`;
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        page.on("pageerror", (err: Error) => pushUnique(result.errors, err.message));
        await page.goto(harness, { waitUntil: "load", timeout: 15_000 });
        await page
          .waitForFunction(() => (window as any).__houseCheck?.connected === true, null, { timeout: 8_000 })
          .catch(() => {});
        await page.waitForTimeout(1200);
        const report = await page.evaluate(() => (window as any).__houseCheck);
        result.connected ||= Boolean(report?.connected);
        for (const e of report?.errors ?? []) pushUnique(result.errors, e);
        for (const b of report?.blocked ?? []) pushUnique(result.blocked, b);
        for (const c of report?.console ?? []) pushUnique(result.console, c);
        const png: Buffer = await page.locator("iframe").screenshot({ timeout: 5_000 });
        result.screenshots.push({ label: vp.label, png });
      } catch (err) {
        pushUnique(result.errors, `Check harness failed: ${(err as Error).message.split("\n")[0]}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
    return result;
  }

  async close(): Promise<void> {
    const b = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    await b?.close().catch(() => {});
  }
}

function pushUnique(list: string[], item: string): void {
  if (list.length < 30 && !list.includes(item)) list.push(item);
}
