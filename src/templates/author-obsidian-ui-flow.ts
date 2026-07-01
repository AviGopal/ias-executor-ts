/**
 * author-obsidian-ui-flow — substrate-self-development template.
 *
 * Authors NEW Obsidian UI (a command or a view) into the obsidian-vessel plugin
 * so the substrate can facilitate a *modeled human interaction* — not merely
 * write a note. Where `summarize-and-emit-concept` is a terminal template that
 * answers a goal into a concept, this one is a self-development template: it
 * dispatches `feature_compose` to add a command/view to
 * `repos/obsidian-vessel/src/commands.ts` (and `main.ts registerView` when the
 * capability is a view), keeping the change typecheck-clean.
 *
 * The single task's config is a `FeatureComposePointer` (see
 * repos/development-vessel/src/resolvers/feature-compose.ts): `type`, `spec`,
 * `verify_vessels`, `land`. `land: false` means author + typecheck-verify only —
 * the operator (or the cutover tick) lands the change and then runs
 * scripts/substrate/obsidian-plugin-reload.sh to build + install + reload the
 * plugin so the new UI is live in the vault.
 *
 * NOTE ON SHAPE: feature_compose emits the `featureComposeReport` shape (its
 * ResolverResult `shape` field — verified in feature-compose.ts), so that is
 * this template's declared `output_shapes`. The input is `implicitVesselReport`
 * (the modeled-interaction gap that names the needed capability).
 */

import type { ActivityTemplate } from "../ontology";

const authorObsidianUiFlow: ActivityTemplate = {
  id: "author-obsidian-ui-flow",
  name: "Author new Obsidian UI (command or view)",
  description:
    "Substrate-self-development template: given a modeled human interaction that the " +
    "obsidian-vessel plugin does not yet support (an implicitVesselReport naming the " +
    "needed capability), author a NEW Obsidian command or view into the plugin — NOT a " +
    "note. Dispatches feature_compose to add a command to repos/obsidian-vessel/src/" +
    "commands.ts (and, for a view, a registerView call in main.ts), keeping the change " +
    "typecheck-clean. land is false: this authors + verifies; landing + plugin reload " +
    "(scripts/substrate/obsidian-plugin-reload.sh) are the cutover step.",
  category: "self-development",
  version: "0.1.0",
  tags: ["substrate.self-development", "obsidian.ui", "feature-compose", "author"],
  input_shapes: ["implicitVesselReport"],
  output_shapes: ["featureComposeReport"],
  variables: [
    {
      name: "needed_capability",
      type: "string",
      required: true,
      description:
        "The modeled human interaction the new UI must facilitate — e.g. 'a command to " +
        "capture the current selection as a Substrate/ note' or 'a side view listing open " +
        "substrate goals'. Interpolated into the feature_compose spec.",
    },
  ],
  tasks: [
    {
      id: "compose_obsidian_ui",
      description:
        "Dispatch feature_compose to author the new Obsidian command/view into " +
        "obsidian-vessel, typecheck-verify it, and (land=false) leave it staged for the " +
        "cutover. The spec instructs a surgical, typecheck-clean addition wired to an " +
        "existing resolver or the Substrate/ vault namespace.",
      resolver: "feature_compose",
      config: {
        type: "feature_compose",
        spec:
          "Add a new Obsidian UI capability to the obsidian-vessel plugin implementing: " +
          "{{needed_capability}}.\n\n" +
          "Concrete requirements:\n" +
          "- Add a new command to repos/obsidian-vessel/src/commands.ts, following the " +
          "existing command-registration pattern in that file exactly (id, name, callback/" +
          "editorCallback). If the capability is better served by a persistent panel, also " +
          "register a new view via addView/registerView in repos/obsidian-vessel/src/main.ts, " +
          "mirroring how existing views are registered there.\n" +
          "- The command/view MUST do real work: either call an existing obsidian-vessel " +
          "resolver/dispatch path, or read/write inside the vault's Substrate/ namespace " +
          "(create the folder if absent). Do NOT just open a note.\n" +
          "- Keep the change surgical and typecheck-clean (bun x tsc --noEmit must pass); " +
          "match the existing types, imports, and call signatures in those files. Do not " +
          "invent APIs or file paths.",
        verify_vessels: ["obsidian-vessel"],
        land: false,
      },
      outputShapes: ["featureComposeReport"],
      outputImpulses: ["obsidian_ui_compose_report"],
      notes:
        "config is a FeatureComposePointer (feature-compose.ts): type/spec/verify_vessels/" +
        "land. verify_vessels typechecks repos/obsidian-vessel. land:false authors + verifies " +
        "only; the cutover (obsidian-plugin-reload.sh) builds main.js, installs it into the " +
        "vault plugin dir, and reloads the plugin so the new UI registers live.",
    },
  ],
  metadata: {
    author: "operator",
    embedded: false,
    bootstrapTemplate: true,
    selfDevelopment: true,
  },
};

export default authorObsidianUiFlow;
