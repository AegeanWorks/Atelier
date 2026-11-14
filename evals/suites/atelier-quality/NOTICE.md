# Quality suite provenance

Coding and long-recall task shapes are adapted from ModelDuck's benchmark suite (suite v17), which is part of this workspace. The implementations here are small, deterministic ports for atelier's measurement ground; they are not the full ModelDuck suite.

| Dataset | Source | License | Items here | Changes |
|---|---|---|---|---|
| HumanEval | [openai/openai_humaneval](https://huggingface.co/datasets/openai/openai_humaneval) | MIT, © OpenAI | HumanEval/26 `removeDuplicates` | Python task translated to JavaScript; test cases taken from the original check function |
| MBPP (sanitized) | [google-research-datasets/mbpp](https://huggingface.co/datasets/google-research-datasets/mbpp) | CC BY 4.0, © Google LLC | MBPP/80 `tetrahedralNumber` | Python task translated to JavaScript; original asserts kept |
| ModelDuck own items | `projects/modelduck/benchmarks` | workspace project | run-length encoding, GCD repair, CSV parsing, code comprehension, locker register, latest status, multi-needle, 4k/8k/16k needles | Rewritten as atelier quality tasks |

Tasks: run-length encoding, GCD repair, CSV parsing, code comprehension, HumanEval/26 and MBPP/80 public items, locker-register lookup and reverse lookup, latest-status tracking, multi-needle recall, and 4k/8k/16k needle recall. HumanEval is MIT (c) OpenAI; MBPP is CC BY 4.0 (c) Google LLC; both are translated to JavaScript with test cases from their original checks.

The long prompts are generated deterministically by `scripts/build-quality-suite.mjs`. Public benchmark items may appear in models' training data, so public-item results should be read separately from the private recall items.
