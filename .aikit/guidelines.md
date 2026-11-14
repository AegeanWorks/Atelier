# Project Guidelines

Rules for this project only, written by people or AI agents. They add to AIKit's principles and
rank below them: a guideline never overrides a principle (PRINCIPLE-000 R6, PRINCIPLE-001 R4).
Add one with `python aikit.py guideline <name> "<rule>" --source <user|ADR-NNN|person>`, or by
hand as one line below in the form `- **G-NNN** (source): rule`; IDs are never reused.

Persisted state carries a format version. A loader refuses a version it does not support,
without modifying or quarantining that file; older versions migrate when a migration exists.

## Rules
- **G-001** (user): As fast as possible: every hot-path change has a measured before/after and cannot regress a budget.
- **G-002** (user): AI Usage Compatible: providers, tools, artifacts and headless routes must work without vendor lock-in.
- **G-003** (user): Crash Free: stop is a crash, start recovers, and no acknowledged write or non-idempotent effect is lost or duplicated.
- **G-004** (user): Browser Usage Compatible: Chromium, Firefox and WebKit; keyboard and axe gates; 390/768/1440 layouts without horizontal scroll.
- **G-005** (user): AI Testable: every claim has a machine-runnable check, a stable JSON result and a replayable trace.
- **G-006** (user): Every change carries before/after evidence: record the metric, command, baseline and candidate result in the task checkpoint; harness changes pass npm run eval:gate, perf changes npm run test:budgets, quality changes npm run eval:quality:gate, and UI changes refresh before/after screenshots. No improvement claim without paired numbers.
- **G-007** (user): Every UI change is analysed before and after with screenshots: run npm run ui:before on the unchanged tree, make the change, run npm run ui:after, inspect each before/after pair at 390/768/1440 for clipping, overlap, contrast and stale copy, and record the finding in the task checkpoint.
- **G-008** (user): UI is aesthetic and easy to use: colors, spacing and type come from theme tokens rather than raw values in components, controls share one visual grammar with a visible focus state, each surface has one obvious primary action and destructive actions are tinted and confirmed, labels name real behavior, and nothing is clipped, overlapping or unreachable at 390/768/1440; the G-007 before/after pair is the review evidence.
