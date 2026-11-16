/**
 * A tool schema is a promise to the model. If a parameter is advertised and then ignored, the
 * model passes it, pays for it in context, and silently gets the old behaviour: `delegate`
 * carried a `background` flag for exactly that reason.
 *
 * This reads each tool's real JSON schema, then looks for `args.<name>` in that tool's own
 * implementation, so a new dead parameter fails here instead of in a confusing run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolSchemas } from "../../server/tools";

const SOURCE = readFileSync(join(process.cwd(), "server", "tools.ts"), "utf8");
/** The agent loop dispatches these two itself, so their inputs are read there, not in tools.ts. */
const AGENT = readFileSync(join(process.cwd(), "server", "agent.ts"), "utf8");

/** The source of one named tool's entry: its `run` and nothing of its sibling. */
function toolSource(name: string): string {
  const start = SOURCE.indexOf(`\n  ${name}: {`);
  if (start < 0) throw new Error(`tool ${name} is not in server/tools.ts`);
  const rest = SOURCE.slice(start + 1);
  const next = rest.search(/\n  [a-z_]+: \{/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Where a parameter may legitimately be read: the tool's own block, or the agent's dispatch. */
function readAnywhere(tool: string, parameter: string): boolean {
  return toolSource(tool).includes(`args.${parameter}`) || AGENT.includes(`args.${parameter}`);
}

/** The top-level `properties` keys of a JSON schema, which are the inputs a model may send. */
function declaredParameters(schema: unknown): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  return properties === undefined ? [] : Object.keys(properties);
}

describe("tool schemas", () => {
  it("reads every parameter it advertises", () => {
    const dead: string[] = [];
    for (const tool of toolSchemas()) {
      for (const parameter of declaredParameters(tool.parameters)) {
        // `args.x` is how a tool reads its input, wherever the read happens.
        if (!readAnywhere(tool.name, parameter)) dead.push(`${tool.name}.${parameter}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("advertises at least one parameter per tool that takes input", () => {
    // Guards the check itself: if schema extraction silently returned nothing, the test above
    // would pass vacuously.
    const withInput = toolSchemas().filter((tool) => declaredParameters(tool.parameters).length > 0);
    expect(withInput.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps delegate's schema to what it actually does", () => {
    // The concrete case that motivated the check: a synchronous, read-only brief.
    const delegate = toolSchemas(["delegate"])[0];
    expect(delegate === undefined ? [] : declaredParameters(delegate.parameters)).toEqual(["brief"]);
  });
});
