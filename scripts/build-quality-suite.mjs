import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "evals", "suites", "atelier-quality");
const tasks = join(ROOT, "tasks");
const fixtures = join(ROOT, "fixtures");
const prompts = join(ROOT, "prompts");
for (const dir of [tasks, fixtures, prompts]) mkdirSync(dir, { recursive: true });

const text = (value) => ({ events: [{ type: "text-delta", text: value }, { type: "usage", promptTokens: 0, completionTokens: Math.ceil(value.length / 4) }, { type: "finish", reason: "stop" }] });
const task = (id, prompt, checks, extra = {}) => ({ id, suite: "atelier-quality", split: "dev", mode: "quality", prompt, provider: "fixture", fixture: `fixtures/${id}.json`, qualityChecks: checks, tags: ["quality", "modelduck"], ...extra });
const fixture = (id, value) => writeFileSync(join(fixtures, `${id}.json`), `${JSON.stringify({ provider: "fixture", models: [{ id: "fixture-model", name: "Fixture" }], responses: [text(value)] }, null, 2)}\n`);
const writeTask = (id, value) => writeFileSync(join(tasks, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);

const cases = (entries) => entries.map(([args, expect]) => ({ args, expect }));

const runLength = "function runLength(s) {\n  let out = \"\";\n  for (let i = 0; i < s.length;) {\n    let j = i;\n    while (j < s.length && s[j] === s[i]) j += 1;\n    out += s[i] + (j - i);\n    i = j;\n  }\n  return out;\n}";
const gcd = "function gcd(a, b) {\n  while (b !== 0) {\n    const t = a % b;\n    a = b;\n    b = t;\n  }\n  return a;\n}";
const parseCsv = "function parseCsvLine(line) {\n  const out = [];\n  let field = \"\";\n  let quoted = false;\n  for (let i = 0; i < line.length; i += 1) {\n    const ch = line[i];\n    if (quoted) {\n      if (ch === '\"' && line[i + 1] === '\"') { field += '\"'; i += 1; }\n      else if (ch === '\"') quoted = false;\n      else field += ch;\n    } else if (ch === '\"') quoted = true;\n    else if (ch === ',') { out.push(field); field = \"\"; }\n    else field += ch;\n  }\n  out.push(field);\n  return out;\n}";

const coding = [
  {
    id: "code-write-run-length",
    prompt: 'Write a JavaScript function named runLength that run-length encodes a string as each character followed by how many times it repeats in a row, for example "aaabcc" becomes "a3b1c2". Reply with code only.',
    answer: runLength,
    checks: [{ type: "jsTests", entry: "runLength", cases: cases([[["aaabcc"], "a3b1c2"], [[""], ""], [["abc"], "a1b1c1"], [["zzzz"], "z4"]]) }],
  },
  {
    id: "code-fix-gcd",
    prompt: 'This JavaScript function has a bug:\nfunction gcd(a, b) {\n  while (b !== 0) {\n    const t = a % b;\n    a = b;\n    b = t;\n  }\n  return b;\n}\nIt should return the greatest common divisor of two non-negative integers. Fix the bug. Reply with code only, keeping the function name gcd.',
    answer: gcd,
    checks: [{ type: "jsTests", entry: "gcd", cases: cases([[[12, 18], 6], [[17, 5], 1], [[0, 9], 9], [[100, 75], 25]]) }],
  },
  {
    id: "code-write-csv",
    prompt: 'Write a JavaScript function named parseCsvLine that parses one CSV line into an array of fields. Commas separate fields; a field may be wrapped in double quotes; inside quotes a comma is data and two double quotes stand for one quote. Empty fields are kept. Reply with code only.',
    answer: parseCsv,
    checks: [{ type: "jsTests", entry: "parseCsvLine", cases: cases([[["a,b,c"], ["a", "b", "c"]], [['"x, y",z'], ["x, y", "z"]], [['"he said ""hi""",ok'], ['he said "hi"', "ok"]], [[""], [""]], [["a,,b"], ["a", "", "b"]]]) }],
  },
  {
    id: "public-humaneval-26",
    prompt: "Write a JavaScript function named removeDuplicates that takes an array of integers and removes every element that occurs more than once, keeping the order of the remaining elements. Reply with code only.",
    answer: "function removeDuplicates(arr) {\n  const counts = new Map();\n  for (const x of arr) counts.set(x, (counts.get(x) || 0) + 1);\n  return arr.filter((x) => counts.get(x) === 1);\n}",
    checks: [{ type: "jsTests", entry: "removeDuplicates", cases: cases([[ [[1, 2, 3, 2, 4]], [1, 3, 4]], [[[]], []], [[[1, 2, 3, 4]], [1, 2, 3, 4]], [[[1, 2, 3, 2, 4, 3, 5]], [1, 4, 5]] ]) }],
    source: { dataset: "HumanEval", id: "HumanEval/26", license: "MIT" },
  },
  {
    id: "public-mbpp-80",
    prompt: "Write a JavaScript function named tetrahedralNumber that takes a positive integer n and returns the nth tetrahedral number. Reply with code only.",
    answer: "function tetrahedralNumber(n) {\n  return (n * (n + 1) * (n + 2)) / 6;\n}",
    checks: [{ type: "jsTests", entry: "tetrahedralNumber", cases: cases([[ [5], 35], [[6], 56], [[7], 84]]) }],
    source: { dataset: "MBPP", id: "MBPP/80", license: "CC-BY-4.0" },
  },
  {
    id: "code-comprehension",
    prompt: "Read this JavaScript function:\nfunction score(xs) {\n  let total = 0;\n  for (const x of xs) total += x % 2 === 0 ? x : -x;\n  return total;\n}\nWhat does score([1, 2, 3, 4]) return? Reply with only the number.",
    answer: "2",
    checks: [{ type: "exact", value: "2" }],
  },
];

for (const item of coding) {
  const extra = item.id === "code-comprehension" ? { maxTokens: 16 } : { maxTokens: 512 };
  if (item.source !== undefined) extra.source = item.source;
  writeTask(item.id, task(item.id, item.prompt, item.checks, extra));
  fixture(item.id, item.answer);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const words = ["pond", "duck", "reed", "census", "calm", "morning", "count", "ledger", "keeper", "fen", "water", "nest", "quack", "wader", "marsh", "tally", "dawn", "ripple", "sedge", "brook"];
function longFiller(targetChars, seed) {
  const next = mulberry32(seed);
  const sentences = [];
  let chars = 0;
  let note = 1;
  while (chars < targetChars) {
    const sentence = `Entry ${note}: the ${Array.from({ length: 8 + Math.floor(next() * 8) }, () => words[Math.floor(next() * words.length)]).join(" ")} tally is ${1000 + Math.floor(next() * 9000)}.`;
    sentences.push(sentence);
    chars += sentence.length + 1;
    note += 1;
  }
  return sentences.join(" ");
}
for (const { id, kiloTokens, seed, code } of [
  { id: "recall-long-4k", kiloTokens: 4, seed: 427, code: 4510 },
  { id: "recall-long-8k", kiloTokens: 8, seed: 428, code: 8823 },
  { id: "recall-long-16k", kiloTokens: 16, seed: 429, code: 16047 },
]) {
  const filler = longFiller(kiloTokens * 4000, seed);
  const half = Math.floor(filler.length / 2);
  const prompt = `Read these notes carefully.\n\n${filler.slice(0, half)}\n\nThe vault code is VAULT-${code}. Keep it in mind.\n\n${filler.slice(half)}\n\nQuestion: What is the vault code? Reply with only the code.`;
  writeFileSync(join(prompts, `${id}.txt`), prompt);
  writeTask(id, { ...task(id, "See promptFile.", [{ type: "exact", value: `VAULT-${code}` }], { maxTokens: 16 }), prompt: "", promptFile: `prompts/${id}.txt`, budgets: { wallMs: 120_000 } });
  fixture(id, `VAULT-${code}`);
}

const syllables = ["ka", "lo", "mi", "ren", "sa", "to", "vi", "nu", "pe", "dar", "el", "ro", "ta", "ji", "mo", "zan"];
const rows = Array.from({ length: 40 }, (_, index) => ({
  badge: 300 + index,
  name: syllables[(index * 7) % syllables.length] + syllables[(index * 3) % syllables.length],
  room: `${String.fromCharCode(65 + (index % 6))}${1 + (index % 40)}`,
  pin: String(1000 + ((index + 1) * 7919) % 9000),
}));
const target = rows[27];
const register = rows.map((row) => `Badge ${row.badge}: holder ${row.name}, room ${row.room}, PIN ${row.pin}.`).join("\n");
const registerPrompt = `Here is the badge register.\n${register}\n\nWhat is the PIN of badge ${target.badge}? Reply with only the PIN.`;
writeFileSync(join(prompts, "recall-register.txt"), registerPrompt);
writeTask("recall-register", { ...task("recall-register", "", [{ type: "exact", value: target.pin }], { maxTokens: 16 }), prompt: "", promptFile: "prompts/recall-register.txt" });
fixture("recall-register", target.pin);

const multiFiller = longFiller(6000, 731);
const multiHalf = Math.floor(multiFiller.length / 2);
const multiPrompt = `Read these notes carefully.\n\n${multiFiller.slice(0, multiHalf)}\n\nThe first vault code is VAULT-1111. The second vault code is VAULT-2222. The third vault code is VAULT-3333.\n\n${multiFiller.slice(multiHalf)}\n\nQuestion: What is the second vault code? Reply with only the code.`;
writeFileSync(join(prompts, "recall-multi-needle.txt"), multiPrompt);
writeTask("recall-multi-needle", { ...task("recall-multi-needle", "", [{ type: "exact", value: "VAULT-2222" }], { maxTokens: 16 }), prompt: "", promptFile: "prompts/recall-multi-needle.txt" });
fixture("recall-multi-needle", "VAULT-2222");

const statusLog = [
  "P-410 is packed.", "P-417 is shipped.", "P-410 is shipped.", "P-424 is packed.",
  "P-410 is delayed.", "P-417 is delivered.", "P-424 is shipped.", "P-410 is shipped.",
  "P-431 is packed.", "P-410 is delayed.", "P-424 is delayed.", "P-431 is shipped.",
  "P-410 is delivered.", "P-431 is delayed.", "P-424 is delivered.", "P-410 is delayed.",
];
const statusPrompt = `Here is a delivery log, oldest first. A later line replaces an earlier one for the same parcel.\n${statusLog.map((line, index) => `${String(index + 1).padStart(2, "0")}. ${line}`).join("\n")}\n\nWhat is the latest status of parcel P-410? Reply with only the status.`;
writeFileSync(join(prompts, "recall-latest-status.txt"), statusPrompt);
writeTask("recall-latest-status", { ...task("recall-latest-status", "", [{ type: "exact", value: "delayed" }], { maxTokens: 16 }), prompt: "", promptFile: "prompts/recall-latest-status.txt" });
fixture("recall-latest-status", "delayed");

const reversePrompt = `Here is the badge register.\n${register}\n\nWho holds the badge with PIN ${target.pin}? Reply with only the name.`;
writeFileSync(join(prompts, "recall-reverse.txt"), reversePrompt);
writeTask("recall-reverse", { ...task("recall-reverse", "", [{ type: "exact", value: target.name }], { maxTokens: 16 }), prompt: "", promptFile: "prompts/recall-reverse.txt" });
fixture("recall-reverse", target.name);

writeFileSync(join(ROOT, "NOTICE.md"), `# Quality suite provenance\n\nCoding and long-recall task shapes are adapted from ModelDuck's benchmark suite (suite v17), which is part of this workspace. The implementations here are small, deterministic ports for atelier's measurement ground; they are not the full ModelDuck suite. ModelDuck's own items are its own work; its public items carry dataset provenance in \`benchmarks/NOTICE-benchmarks.md\`.\n\nTasks: run-length encoding, GCD repair, CSV parsing, code comprehension, HumanEval/26 and MBPP/80 public items, locker-register lookup and reverse lookup, latest-status tracking, multi-needle recall, and 4k/8k/16k needle recall. HumanEval is MIT (c) OpenAI; MBPP is CC BY 4.0 (c) Google LLC; both are translated to JavaScript with test cases from their original checks. The long prompts are generated deterministically by \`scripts/build-quality-suite.mjs\`.\n`);
console.log(`quality suite written: ${coding.length + 4 + 3} tasks`);
