import { describe, expect, it } from "vitest";
import { isSecretName, scrubbedEnv } from "../../server/shellEnv";

const base: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/dev",
  SystemRoot: "C:\\Windows",
  OPENAI_API_KEY: "sk-fabricated-0000",
  GITHUB_TOKEN: "tok-fabricated-1111",
  AWS_SECRET_ACCESS_KEY: "fabricated-2222",
  DB_PASSWORD: "fabricated-3333",
  KEYBOARD_LAYOUT: "us",
  MONKEY_COUNT: "3",
  TOKENIZERS_PARALLELISM: "false",
};

describe("isSecretName", () => {
  it("recognises credential-shaped names by their words, not by substrings", () => {
    for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "my_passwd", "GCP_CREDENTIALS", "SERVICE_CREDENTIAL", "ANTHROPIC_AUTH_TOKEN", "apikey", "OPENAIAPIKEY", "SSH_PRIVATE_KEY", "npm_config_authToken"]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "KEYBOARD_LAYOUT", "MONKEY_COUNT", "TOKENIZERS_PARALLELISM", "SECRETARY_NAME", "SystemRoot", "KEYCHAIN_PATH"]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});

describe("scrubbedEnv", () => {
  it("removes secret-shaped variables and keeps the rest", () => {
    const env = scrubbedEnv(base, { providers: [], passthrough: [] });
    expect(Object.keys(env).sort()).toEqual(["HOME", "KEYBOARD_LAYOUT", "MONKEY_COUNT", "PATH", "SystemRoot", "TOKENIZERS_PARALLELISM"]);
  });

  it("also removes the variable each provider names for its key, whatever it is called", () => {
    const env = scrubbedEnv({ ...base, MY_VENDOR_ACCESS: "fabricated-4444" }, { providers: [{ apiKeyEnv: "MY_VENDOR_ACCESS" }, {}], passthrough: [] });
    expect(env.MY_VENDOR_ACCESS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets a listed variable through, ignoring case, even when it looks secret or is a provider key", () => {
    const env = scrubbedEnv(base, { providers: [{ apiKeyEnv: "GITHUB_TOKEN" }], passthrough: ["github_token", "AWS_SECRET_ACCESS_KEY"] });
    expect(env.GITHUB_TOKEN).toBe("tok-fabricated-1111");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("fabricated-2222");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("does not change the environment it was given and never emits undefined values", () => {
    const input: NodeJS.ProcessEnv = { ...base, EMPTY: undefined };
    const before = JSON.stringify(input);
    const env = scrubbedEnv(input, { providers: [], passthrough: [] });
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });
});
