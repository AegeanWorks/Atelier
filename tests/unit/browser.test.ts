import { describe, expect, it, vi } from "vitest";
import { browserLaunch, openBrowser, type SpawnBrowser } from "../../server/browser";

const noBrowser = { exists: () => false, env: {} as NodeJS.ProcessEnv };
const edgeAt = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const edgeEnv = { "ProgramFiles(x86)": "C:\\Program Files (x86)" } as NodeJS.ProcessEnv;

describe("browser launch", () => {
  it("opens a dedicated app window when Edge or Chrome exists", () => {
    expect(browserLaunch("http://127.0.0.1:4317", "win32", { env: edgeEnv, exists: (path) => path === edgeAt })).toEqual({
      command: edgeAt,
      args: ["--app=http://127.0.0.1:4317/", "--window-size=1440,900", "--no-first-run"],
      appWindow: true,
    });
  });

  it("prefers Edge over Chrome when both exist", () => {
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv;
    const exists = (path: string): boolean => path === chrome || path === edgeAt;
    expect(browserLaunch("http://127.0.0.1:4317", "win32", { env, exists }).command).toBe(edgeAt);
  });

  it("opens an app window on macOS and a PATH-resolved browser on Linux", () => {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(browserLaunch("http://127.0.0.1:4317", "darwin", { exists: (path) => path === mac })).toMatchObject({
      command: mac,
      appWindow: true,
    });
    const linux = browserLaunch("http://127.0.0.1:4317", "linux", {
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      exists: (path) => path === "/usr/bin/google-chrome",
    });
    expect(linux).toMatchObject({ command: "google-chrome", appWindow: true });
    expect(linux.args[0]).toBe("--app=http://127.0.0.1:4317/");
  });

  it("falls back to the system file handler when no Chromium browser exists", () => {
    expect(browserLaunch("http://127.0.0.1:4317", "win32", noBrowser)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4317/"],
      appWindow: false,
    });
    expect(browserLaunch("http://127.0.0.1:4317", "darwin", noBrowser)).toEqual({
      command: "open",
      args: ["http://127.0.0.1:4317/"],
      appWindow: false,
    });
    expect(browserLaunch("http://127.0.0.1:4317", "linux", noBrowser)).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:4317/"],
      appWindow: false,
    });
  });

  it("honours an explicit ATELIER_BROWSER path", () => {
    const custom = "C:\\Tools\\Chromium\\chrome.exe";
    expect(
      browserLaunch("http://127.0.0.1:4317", "win32", {
        env: { ATELIER_BROWSER: custom, "ProgramFiles(x86)": "C:\\Program Files (x86)" } as NodeJS.ProcessEnv,
        exists: (path) => path === custom || path === edgeAt,
      }).command,
    ).toBe(custom);
  });

  it("can force the plain browser behaviour", () => {
    expect(browserLaunch("http://127.0.0.1:4317", "win32", { appWindow: false }).command).toBe("rundll32.exe");
  });

  it("refuses a non-http URL", () => {
    expect(() => browserLaunch("file:///tmp/index.html", "linux")).toThrow(/http\(s\)/);
  });

  it("spawns the launch detached and releases the child", () => {
    const calls: unknown[][] = [];
    const unref = vi.fn();
    const on = vi.fn();
    const spawnBrowser: SpawnBrowser = (command, args, options) => {
      calls.push([command, args, options]);
      return { on, unref };
    };
    openBrowser("http://127.0.0.1:4317", { platform: "linux", spawnBrowser, ...noBrowser });
    expect(calls).toEqual([
      ["xdg-open", ["http://127.0.0.1:4317/"], { detached: true, stdio: "ignore", windowsHide: true }],
    ]);
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
  });

  it("spawns the app window with the resolved executable", () => {
    const calls: unknown[][] = [];
    const spawnBrowser: SpawnBrowser = (command, args, options) => {
      calls.push([command, args, options]);
      return { on: () => undefined, unref: () => undefined };
    };
    openBrowser("http://127.0.0.1:4317", {
      platform: "win32",
      spawnBrowser,
      env: edgeEnv,
      exists: (path) => path === edgeAt,
    });
    expect(calls[0]?.[0]).toBe(edgeAt);
    expect(calls[0]?.[1]).toEqual(["--app=http://127.0.0.1:4317/", "--window-size=1440,900", "--no-first-run"]);
  });

  it("reports a spawn error through the callback without throwing", () => {
    const onError = vi.fn();
    const spawnBrowser: SpawnBrowser = () => {
      throw new Error("no opener");
    };
    expect(() =>
      openBrowser("http://127.0.0.1:4317", { platform: "linux", spawnBrowser, onError, ...noBrowser }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "no opener" }));
  });

  it("reports an asynchronous opener error and an invalid URL through the callback", () => {
    let listener: ((error: Error) => void) | undefined;
    const onError = vi.fn();
    const spawnBrowser: SpawnBrowser = () => ({
      on: (event, callback) => {
        if (event === "error") listener = callback;
        return undefined;
      },
      unref: () => undefined,
    });
    openBrowser("http://127.0.0.1:4317", { platform: "linux", spawnBrowser, onError, ...noBrowser });
    listener?.(new Error("detached failure"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "detached failure" }));
    openBrowser("not a URL", { platform: "linux", spawnBrowser, onError, ...noBrowser });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
