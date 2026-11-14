import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  MAX_OUTPUT_LINES,
  TERMINAL_HEADER,
  boundOutput,
  pushCommand,
  readTerminal,
  writeTerminal,
} from "../../src/terminalStore";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("terminal store", () => {
  it("defaults to the header and no history", () => {
    expect(readTerminal(memoryStorage())).toEqual({ output: TERMINAL_HEADER, history: [] });
  });

  it("bounds output by line count", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
    expect(boundOutput(text, 3)).toBe("line 7\nline 8\nline 9");
    expect(boundOutput("short", 3)).toBe("short");
  });

  it("caps the history and skips an immediate repeat", () => {
    let history: string[] = [];
    for (let index = 0; index < 5; index += 1) history = pushCommand(history, `cmd ${index}`, 3);
    expect(history).toEqual(["cmd 2", "cmd 3", "cmd 4"]);
    expect(pushCommand(history, "cmd 4", 3)).toEqual(history);
    expect(pushCommand(history, "   ", 3)).toEqual(history);
  });

  it("round-trips and bounds a written state", () => {
    const storage = memoryStorage();
    writeTerminal({ output: `${TERMINAL_HEADER}\n${"x\n".repeat(MAX_OUTPUT_LINES * 2)}`, history: ["a", "b"] }, storage);
    const restored = readTerminal(storage);
    expect(restored.history).toEqual(["a", "b"]);
    expect(restored.output.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
  });

  it("keeps at most the maximum history on read", () => {
    const storage = memoryStorage();
    const history = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => `cmd ${index}`);
    storage.setItem("atelier.terminal", JSON.stringify({ output: "out", history }));
    expect(readTerminal(storage).history).toHaveLength(MAX_HISTORY);
    expect(readTerminal(storage).history[0]).toBe("cmd 5");
  });

  it("survives corrupt JSON and a throwing storage", () => {
    const storage = memoryStorage({ "atelier.terminal": "{not json" });
    expect(readTerminal(storage)).toEqual({ output: TERMINAL_HEADER, history: [] });
    const broken = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as Storage;
    expect(readTerminal(broken)).toEqual({ output: TERMINAL_HEADER, history: [] });
    expect(() => writeTerminal({ output: "x", history: [] }, broken)).not.toThrow();
  });
});
