import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SHELL_DIR } from "../config.ts";

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

/**
 * The harness is never served by the platform. Playwright answers these requests
 * itself, so there is no public page that renders a house full-screen on the app's
 * origin without the shell around it.
 */
const HARNESS_FILES: Record<string, { file: string; type: string }> = {
  "/__check/harness.html": { file: "check-harness.html", type: "text/html; charset=utf-8" },
  "/__check/check-harness.js": { file: "check-harness.js", type: "text/javascript; charset=utf-8" },
  "/__check/check-harness.css": { file: "check-harness.css", type: "text/css; charset=utf-8" },
  "/__check/bridge.js": { file: "bridge.js", type: "text/javascript; charset=utf-8" },
};

/** House code under test gets no WebRTC: it's the one network path CSP can't close. */
const DISABLE_WEBRTC = `for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) { try { delete window[k]; } catch (_) {} }`;

type Browser = { newContext(o: object): Promise<any>; close(): Promise<void> };

export interface BrowserCheckerOptions {
  platformOrigin: string;
  houseScheme: string;
  houseDomain: string;
  /** Chromium's own sandbox. Required in production; only disable for local dev as root. */
  sandbox: boolean;
}

/**
 * Renders a house with the real sandbox, CSP and bridge against fake data, in
 * headless Chromium. In production, run this process as its own user (or container)
 * without access to the data directory: it executes member-written JavaScript.
 */
export class BrowserChecker implements Checker {
  private browser: Promise<Browser | null> | undefined;
  private launchError: string | undefined;

  constructor(private readonly opts: BrowserCheckerOptions) {}

  private getBrowser(): Promise<Browser | null> {
    this.browser ??= (async () => {
      let playwright: { chromium: { launch(o?: object): Promise<Browser> } };
      try {
        playwright = createRequire(import.meta.url)("playwright");
      } catch {
        this.launchError = "No headless browser is installed on this server, so the house could not be rendered.";
        return null;
      }
      try {
        return await playwright.chromium.launch({
          chromiumSandbox: this.opts.sandbox,
          args: [
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            // The harness page is answered by Playwright, so Chrome treats it as public
            // and would block its frame on a local house origin. Network reach is
            // already limited to house origins by the request router below.
            "--disable-features=LocalNetworkAccessChecks",
          ],
        });
      } catch (err) {
        console.error("[checker] browser failed to start:", (err as Error).message.split("\n")[0]);
        this.launchError = this.opts.sandbox
          ? "The test browser couldn't start with its sandbox, so the house could not be rendered."
          : "The test browser couldn't start, so the house could not be rendered.";
        this.browser = undefined;
        return null;
      }
    })();
    return this.browser;
  }

  private isHouseUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      return `${u.protocol}` === `${this.opts.houseScheme}:` && u.host.endsWith(`.${this.opts.houseDomain}`);
    } catch {
      return false;
    }
  }

  async check(frameUrl: string, houseName: string): Promise<CheckResult> {
    const browser = await this.getBrowser();
    if (!browser) {
      return { available: false, connected: false, errors: [], blocked: [], console: [], screenshots: [], note: this.launchError };
    }
    const result: CheckResult = { available: true, connected: false, errors: [], blocked: [], console: [], screenshots: [] };
    const harness = `${this.opts.platformOrigin}/__check/harness.html#${new URLSearchParams({ frame: frameUrl, name: houseName })}`;
    const houseCsp = `default-src 'self'; script-src 'self'; style-src 'self'; frame-src ${this.opts.houseScheme}://*.${this.opts.houseDomain}; object-src 'none'; base-uri 'none'`;
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
      try {
        await context.addInitScript({ content: DISABLE_WEBRTC });
        // Only the harness (answered locally) and house origins are reachable.
        await context.route("**/*", async (route: any) => {
          const url = new URL(route.request().url());
          const local = url.origin === this.opts.platformOrigin ? HARNESS_FILES[url.pathname] : undefined;
          if (local) {
            return route.fulfill({
              status: 200,
              headers: { "content-type": local.type, "content-security-policy": houseCsp },
              body: fs.readFileSync(path.join(SHELL_DIR, local.file)),
            });
          }
          if (this.isHouseUrl(url.href)) return route.continue();
          return route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        page.on("pageerror", (err: Error) => pushUnique(result.errors, err.message));
        await page.goto(harness, { waitUntil: "load", timeout: 15_000 });
        await page
          .waitForFunction("window.__houseCheck && window.__houseCheck.connected === true", null, { timeout: 8_000 })
          .catch(() => {});
        await page.waitForTimeout(1200);
        const report = await page.evaluate("window.__houseCheck");
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
    const b = await this.browser?.catch(() => null);
    this.browser = undefined;
    await b?.close().catch(() => {});
  }
}

function pushUnique(list: string[], item: string): void {
  if (list.length < 30 && !list.includes(item)) list.push(item);
}
