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

  it("documents and parses the acp command", () => {
    expect(HELP).toContain("atelier acp");
    expect(HELP).toMatch(/Agent Client Protocol/);
    expect(parse(["acp"]).command).toBe("acp");
  });

  it("parses and validates --max-turns", () => {
    expect(HELP).toContain("--max-turns");
    expect(HELP).toMatch(/Exit codes:[\s\S]*0 {2}the command succeeded[\s\S]*2 {2}invalid usage/);
    expect(parse(["run", "x", "--max-turns", "5"]).maxTurns).toBe(5);
    expect(parse(["run", "x", "--max-turns=7"]).maxTurns).toBe(7);
    expect(parse(["run", "x"]).maxTurns).toBeNull();
    for (const bad of ["0", "-1", "abc", "1.5", "201"]) {
      expect(validateRun(parse(["run", "x", `--max-turns=${bad}`]))?.what, bad).toMatch(/--max-turns/);
    }
    expect(validateRun(parse(["run", "x", "--max-turns", "3"]))).toBeNull();
  });

  it("parses --output-format and keeps --json as its short form", () => {
    expect(HELP).toContain("--output-format");
    expect(parse(["run", "x"]).outputFormat).toBe("text");
    expect(parse(["run", "x", "--json"]).outputFormat).toBe("json");
    expect(parse(["run", "x", "--output-format", "stream-json"]).outputFormat).toBe("stream-json");
    expect(parse(["run", "x", "--output-format=json"]).outputFormat).toBe("json");
    expect(validateRun(parse(["run", "x", "--output-format=xml"]))?.what).toMatch(/--output-format/);
    expect(validateRun(parse(["run", "x", "--output-format", "stream-json"]))).toBeNull();
  });

  it("parses and validates --max-budget-usd", () => {
    expect(HELP).toContain("--max-budget-usd");
    expect(parse(["run", "x", "--max-budget-usd", "0.5"]).maxBudgetUsd).toBe(0.5);
    expect(parse(["run", "x", "--max-budget-usd=2"]).maxBudgetUsd).toBe(2);
    expect(parse(["run", "x"]).maxBudgetUsd).toBeNull();
    for (const bad of ["0", "-1", "abc", "Infinity", "1001"]) {
      expect(validateRun(parse(["run", "x", `--max-budget-usd=${bad}`]))?.what, bad).toMatch(/--max-budget-usd/);
    }
    expect(validateRun(parse(["run", "x", "--max-budget-usd", "3"]))).toBeNull();
  });

  it("parses --model, --no-session, -p and --print", () => {
    expect(HELP).toContain("--model");
    expect(parse(["run", "x", "--model", "claude-sonnet-4-5"]).model).toBe("claude-sonnet-4-5");
    expect(parse(["run", "x", "--model=gpt-4o"]).model).toBe("gpt-4o");
    expect(parse(["run", "x"]).model).toBeNull();
    expect(validateRun(parse(["run", "x", "--model="]))?.what).toMatch(/--model/);
    expect(parse(["run", "x", "--no-session"]).noSession).toBe(true);
    expect(parse(["run", "x"]).noSession).toBe(false);
    // -p is the Claude-Code-style headless form: it implies `run` and takes an optional prompt.
    expect(parse(["-p", "fix it"]).command).toBe("run");
    expect(parse(["-p", "fix it"]).prompt).toBe("fix it");
    expect(parse(["--print", "fix it"]).command).toBe("run");
    expect(parse(["-p"]).command).toBe("run");
  });

  it("accepts a prompt that arrived on stdin and documents the exit codes", () => {
    const piped = { ...parse(["-p"]), prompt: "from stdin", promptFromStdin: true };
    expect(validateRun(piped)).toBeNull();
    // Without a piped prompt the same invocation is still a usage error.
    expect(validateRun(parse(["-p"]))?.what).toMatch(/prompt/);
    expect(HELP).toMatch(/8 {2}the run reached its --max-turns/);
    expect(HELP).toMatch(/130 {2}the run was interrupted/);
  });
});
