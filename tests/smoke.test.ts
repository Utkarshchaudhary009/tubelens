import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("repo quality-gate contract", () => {
  test("package.json defines the scripts the unit-test workflow gates on", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(typeof pkg.scripts.lint).toBe("string");
    expect(typeof pkg.scripts.build).toBe("string");
  });

  test("unit-test workflow gates lint, typecheck, tests, and build", () => {
    const workflow = readFileSync(
      join(root, ".github", "workflows", "unit-test.yml"),
      "utf8",
    );
    for (const gate of [
      "bun run lint",
      "tsc --noEmit",
      "bun test",
      "bun run build",
    ]) {
      expect(workflow.includes(gate)).toBe(true);
    }
  });
});
