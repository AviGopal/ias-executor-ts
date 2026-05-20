/**
 * Shared catalogue tests.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §F
 * Tasks: tasks.md §2.
 */

import { describe, expect, test } from "bun:test";
import {
  SHARED_TEMPLATES,
  loadTemplate,
  loadTemplatesByTag,
  loadSubscriberTemplates,
} from "../src";

describe("shared template catalogue", () => {
  test("loads the canonical set of meta-activity templates", () => {
    // 6 lifecycle + 1 escalation + 5 registry-quality = 12. forge-vessel-for-shape
    // was not yet present in either minibob or deployment at port time
    // (see templates/index.ts header). When it lands, bump this floor.
    expect(SHARED_TEMPLATES.length).toBeGreaterThanOrEqual(12);
  });

  test("every template carries id, name, and a non-empty tasks array", () => {
    for (const t of SHARED_TEMPLATES) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(Array.isArray(t.tasks)).toBe(true);
      expect(t.tasks.length).toBeGreaterThan(0);
    }
  });

  test("template ids are unique across the catalogue", () => {
    const ids = SHARED_TEMPLATES.map((t) => t.id);
    const uniq = new Set(ids);
    expect(uniq.size).toBe(ids.length);
  });

  test("templates with a subscription declare a non-empty shape", () => {
    for (const t of SHARED_TEMPLATES) {
      if (!t.subscription) continue;
      expect(typeof t.subscription.shape).toBe("string");
      expect(t.subscription.shape.length).toBeGreaterThan(0);
      // filter is optional but if present must be an object
      if (t.subscription.filter !== undefined) {
        expect(typeof t.subscription.filter).toBe("object");
        expect(t.subscription.filter).not.toBeNull();
      }
    }
  });

  test("loadTemplate('slot-binding') returns the slot-binding template", () => {
    const t = loadTemplate("slot-binding");
    expect(t).toBeDefined();
    expect(t?.id).toBe("slot-binding");
    expect(t?.subscription?.shape).toBe("lifecycle:task:preBinding");
  });

  test("loadTemplate returns undefined for an unknown id", () => {
    expect(loadTemplate("does-not-exist")).toBeUndefined();
  });

  test("loadTemplatesByTag('audit') returns the audit-tagged templates", () => {
    const audits = loadTemplatesByTag("audit");
    const ids = new Set(audits.map((t) => t.id));
    // All four audit-tagged catalogue entries should appear: three lifecycle
    // (audit-test-report, run-sensitivity-probe, debug-failing-audit) plus
    // core-activity-audit from registry-quality.
    expect(ids.has("audit-test-report")).toBe(true);
    expect(ids.has("run-sensitivity-probe")).toBe(true);
    expect(ids.has("debug-failing-audit")).toBe(true);
    expect(ids.has("core-activity-audit")).toBe(true);
  });

  test("loadTemplatesByTag prefix-matches (e.g. 'registry.' picks up 'registry.quality')", () => {
    const registry = loadTemplatesByTag("registry.");
    expect(registry.length).toBeGreaterThan(0);
    for (const t of registry) {
      expect(t.tags?.some((tag) => tag.startsWith("registry."))).toBe(true);
    }
  });

  test("loadSubscriberTemplates returns only templates with a subscription block", () => {
    const subs = loadSubscriberTemplates();
    expect(subs.length).toBeGreaterThan(0);
    for (const t of subs) {
      expect(t.subscription).toBeDefined();
      expect(typeof t.subscription?.shape).toBe("string");
    }
    // The four known subscribers as of port time: slot-binding (preBinding),
    // validator-dispatch (task:completed), audit-test-report
    // (execution:succeeded + output_shapes_contains: test_report), and
    // run-sensitivity-probe / debug-failing-audit. ribosome-extract also
    // subscribes (execution:succeeded). Floor: 4 to leave room for catalogue
    // edits that drop one without breaking the test.
    expect(subs.length).toBeGreaterThanOrEqual(4);
  });

  test("templates are pure JSON (no executable imports / requires inside)", () => {
    // Sanity: a template object should be a plain record with no functions,
    // matching the canonical-host stance that the executor only reads JSON.
    for (const t of SHARED_TEMPLATES) {
      const walk = (v: unknown): void => {
        if (v === null) return;
        if (typeof v === "function") {
          throw new Error(`template ${t.id} contains a function`);
        }
        if (Array.isArray(v)) {
          for (const el of v) walk(el);
        } else if (typeof v === "object") {
          for (const val of Object.values(v as Record<string, unknown>)) walk(val);
        }
      };
      walk(t);
    }
  });
});
