/**
 * Pin: the verdict corpus runner's catalogue entry exists, names the shape goal-host serves, and is seeded.
 *
 * goal-host's closed runner records its traces under this template id; the bootstrap seeder seeds
 * SHARED_TEMPLATES. If the entry drifts (id, name, shapes, pointer) or drops out of the catalogue, the
 * runner's traces name an activity the store never holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED_TEMPLATES } from "../src/templates/index";

const TEMPLATES_DIR = join(import.meta.dir, "..", "src", "templates");
const JSON_REL = "./lifecycle/verdict-corpus-runner.json";
const ID = "verdict-corpus-runner";

describe("verdict corpus runner catalogue entry", () => {
  test("the template file carries the runner's exact id, name, shapes, resolver and pointer", () => {
    const t = JSON.parse(readFileSync(join(TEMPLATES_DIR, JSON_REL), "utf8"));
    expect(t.id).toBe(ID);
    expect(t.name).toBe("verdict corpus runner (judge behaviour pins)");
    expect(t.input_shapes).toEqual(["verdictCorpusRun"]);
    expect(t.output_shapes).toEqual(["verdictCorpusReport"]);
    expect(Array.isArray(t.tasks)).toBe(true);
    expect(t.tasks.length).toBe(1);
    expect(t.tasks[0].resolver).toBe("impulse-resolve");
    expect(t.tasks[0].config?.pointer?.type).toBe("verdictCorpusRun");
  });

  test("index.ts imports the template file exactly once and registers that import exactly once", () => {
    const src = readFileSync(join(TEMPLATES_DIR, "index.ts"), "utf8");
    const esc = JSON_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imports = [...src.matchAll(new RegExp(`^import\\s+(\\w+)\\s+from\\s+["']${esc}["']`, "gm"))];
    expect(imports.length).toBe(1);
    const ident = imports[0]![1]!;
    const registrations = [...src.matchAll(new RegExp(`^\\s*cast\\(${ident}\\)\\s*,?\\s*$`, "gm"))];
    expect(registrations.length).toBe(1);
  });

  test("SHARED_TEMPLATES holds the entry exactly once, as loaded from that file", () => {
    const hits = SHARED_TEMPLATES.filter((t) => t.id === ID);
    expect(hits.length).toBe(1);
    const fromFile = JSON.parse(readFileSync(join(TEMPLATES_DIR, JSON_REL), "utf8"));
    expect(JSON.parse(JSON.stringify(hits[0]))).toEqual(fromFile);
  });
});
