import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface BrowserLaunch {
  command: string;
  args: string[];
  appWindow: boolean;
}

export interface BrowserChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export type SpawnBrowser = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean },
) => BrowserChild;

export interface LaunchOptions {
  appWindow?: boolean;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export interface OpenBrowserOptions extends LaunchOptions {
  platform?: NodeJS.Platform;
  spawnBrowser?: SpawnBrowser;
  onError?: (error: Error) => void;
}

const APP_WINDOW_ARGS = ["--window-size=1440,900", "--no-first-run"];

function executableCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pick = platform === "win32" ? win32.join : posix.join;
  const override = env.ATELIER_BROWSER?.trim();
  const found: string[] = [];
  if (override !== undefined && override.length > 0) found.push(override);
  if (platform === "win32") {
    found.push(
      ...[
        env["ProgramFiles(x86)"] && pick(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        env.ProgramFiles && pick(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        env.LOCALAPPDATA && pick(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
        env.ProgramFiles && pick(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
        env["ProgramFiles(x86)"] && pick(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
        env.LOCALAPPDATA && pick(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0),
    );
  } else if (platform === "darwin") {
    found.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    found.push("microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  return found;
}

function onPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): boolean {
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? win32.join : posix.join;
  if (command.includes("/") || command.includes("\\")) return exists(command);
  const entries = (env.PATH ?? env.Path ?? "").split(separator).filter((entry) => entry.length > 0);
  return entries.some((entry) => exists(join(entry, command)) || exists(join(entry, `${command}.exe`)));
}

function findAppWindowBrowser(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const candidates = executableCandidates(platform, env);
  for (const candidate of candidates) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath ? exists(candidate) : onPath(candidate, platform, env, exists)) return candidate;
  }
  return null;
}

function fallbackLaunch(target: string, platform: NodeJS.Platform): BrowserLaunch {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target], appWindow: false };
  }
  if (platform === "darwin") return { command: "open", args: [target], appWindow: false };
  return { command: "xdg-open", args: [target], appWindow: false };
}

export function browserLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
  options: LaunchOptions = {},
): BrowserLaunch {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs can be opened; received '${url}'.`);
  }
  const target = parsed.href;
  if (options.appWindow !== false) {
    const executable = findAppWindowBrowser(platform, options.env ?? process.env, options.exists ?? existsSync);
    if (executable !== null) {
      return {
        command: executable,
        args: [`--app=${target}`, ...APP_WINDOW_ARGS],
        appWindow: true,
      };
    }
  }
  return fallbackLaunch(target, platform);
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean },
): BrowserChild {
  return spawn(command, args, options);
}

export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const onError = options.onError ?? (() => {});
  let launch: BrowserLaunch;
  try {
    launch = browserLaunch(url, options.platform, options);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  try {
    const child = (options.spawnBrowser ?? defaultSpawn)(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", onError);
    child.unref();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}
