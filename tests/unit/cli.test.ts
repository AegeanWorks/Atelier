import { describe, expect, it } from "vitest";
import { HELP, parse, validateRun } from "../../server/cli";

describe("CLI parsing", () => {
  it("documents the headless run command", () => {
    expect(HELP).toContain("atelier run <prompt>");
    expect(HELP).toContain("--mode");
    expect(HELP).toContain("--session");
    expect(HELP).toContain("--yes");
  });

  it("parses a run command with flags in any position", () => {
    const options = parse(["run", "fix", "the", "test", "--mode", "build", "--yes", "--session=ses_1", "--json"]);
    expect(options.command).toBe("run");
    expect(options.prompt).toBe("fix the test");
    expect(options.mode).toBe("build");
    expect(options.yes).toBe(true);
    expect(options.session).toBe("ses_1");
    expect(options.json).toBe(true);
  });

  it("defaults the run mode to plan and keeps bare flow options", () => {
    const options = parse(["run", "hello"]);
    expect(options.mode).toBe("plan");
    expect(options.yes).toBe(false);
    expect(options.command).toBe("run");
    expect(parse(["--no-open"]).command).toBeNull();
  });

  it("rejects unknown flags but accepts dash-containing prompts after the command", () => {
    expect(() => parse(["--nope"])).toThrow(/Unknown argument/);
    expect(parse(["run", "--", "-x", "and", "y"]).prompt).toBe("-x and y");
  });

  it("validates prompt, mode and the --yes coupling", () => {
    expect(validateRun(parse(["run"]))?.what).toMatch(/prompt/);
    expect(validateRun(parse(["run", "hi", "--mode", "fast"]))?.what).toMatch(/unknown mode/);
    expect(validateRun(parse(["run", "hi", "--yes"]))?.what).toMatch(/no effect in plan mode/);
    expect(validateRun(parse(["run", "hi", "--mode", "build", "--yes"]))).toBeNull();
    expect(validateRun(parse(["run", "hi"]))).toBeNull();
  });

  it("parses --continue and -c and the sessions command", () => {
    expect(parse(["run", "more", "--continue"]).continue).toBe(true);
    expect(parse(["run", "more", "-c"]).continue).toBe(true);
    expect(parse(["run", "more"]).continue).toBe(false);
    expect(parse(["sessions", "--json"])).toMatchObject({ command: "sessions", json: true });
  });

  it("rejects --continue together with --session and documents both", () => {
    const options = parse(["run", "more", "--continue", "--session", "ses_1"]);
    expect(validateRun(options)?.what).toMatch(/--continue/);
    expect(HELP).toContain("--continue");
    expect(HELP).toContain("atelier sessions");
  });

  it("collects repeated --image paths", () => {
    const options = parse(["run", "what is this", "--image", "a.png", "--image=b.jpg"]);
    expect(options.images).toEqual(["a.png", "b.jpg"]);
    expect(parse(["run", "x"]).images).toEqual([]);
    expect(HELP).toContain("--image");
  });
});
