/**
 * Pin: every SHARED_TEMPLATES tag is one activity-api's TagSchema accepts.
 *
 * The bootstrap seeder POSTs each SHARED_TEMPLATES entry to activity-api's /v2/activities/templates, which
 * validates `tags` element-wise against TagSchema. One tag outside that grammar ("verdict-corpus") made the
 * whole template a 400, so that template never reached the store and the seeder failed on every boot.
 *
 * TAG_PATTERN and TAG_MAX_LENGTH are a local copy of activity-api src/models/schemas.ts:44-48 (TagSchema):
 *   z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/).max(100)
 * ias-executor-ts does not depend on activity-api, so the grammar is copied rather than imported.
 * PARITY: if activity-api changes TagSchema, change this copy in the same breath, or this pin passes tags the
 * store refuses (or refuses tags it accepts).
 */
import { describe, expect, test } from "bun:test";
import { SHARED_TEMPLATES } from "../src/templates/index";

const TAG_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const TAG_MAX_LENGTH = 100;

const tagIsValid = (tag: unknown): boolean =>
  typeof tag === "string" && TAG_PATTERN.test(tag) && tag.length <= TAG_MAX_LENGTH;

describe("shared template tags match activity-api's TagSchema", () => {
  test("positive control: the copied grammar refuses a hyphenated tag and admits its dotted form", () => {
    expect(tagIsValid("verdict-corpus")).toBe(false);
    expect(tagIsValid("verdict.corpus")).toBe(true);
    expect(tagIsValid("Lifecycle")).toBe(false);
    expect(tagIsValid("registry.quality")).toBe(true);
    expect(tagIsValid("a".repeat(TAG_MAX_LENGTH + 1))).toBe(false);
  });

  test("the catalogue is non-empty, so the sweep below checks something", () => {
    expect(SHARED_TEMPLATES.length).toBeGreaterThan(0);
  });

  test("every tag on every SHARED_TEMPLATES entry passes the TagSchema grammar", () => {
    const bad: string[] = [];
    for (const t of SHARED_TEMPLATES) {
      const tags = (t as { tags?: unknown }).tags;
      if (tags === undefined) continue;
      if (!Array.isArray(tags)) {
        bad.push(`${t.id}: tags is not an array`);
        continue;
      }
      tags.forEach((tag, i) => {
        if (!tagIsValid(tag)) bad.push(`${t.id}: tags[${i}] = ${JSON.stringify(tag)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
