/**
 * The pseudo-model roster the bridge advertises on `GET /v1/models`.
 *
 * Open WebUI has no concept of "one request, two answers", so the arena is
 * exposed as several models instead, each a different compromise:
 *
 *  - `omni-arena-duel`   both answers stacked in one assistant message
 *  - `omni-arena-a`/`-b` two models the user selects together, so Open WebUI's
 *                        own side-by-side compare view renders one slot each
 *  - `omni-arena-single` one model, no vote (Omni-Arena's `single` plan)
 *
 * The names deliberately carry no model identity: whatever Open WebUI prints
 * above a column is the pseudo-model name, so blindness survives.
 */
export const MODELS = {
  "omni-arena-duel": {
    name: "Omni-Arena · Blind Duel (A + B)",
    kind: "duel",
    description:
      "One blind matchup, both anonymous answers in a single message. Vote with !a, !b, !tie, !bad or !skip.",
  },
  "omni-arena-a": {
    name: "Omni-Arena · Anonymous A",
    kind: "slot",
    slot: "A",
    description:
      "Slot A of a blind matchup. Select this together with 'Omni-Arena · Anonymous B' to use Open WebUI's side-by-side view.",
  },
  "omni-arena-b": {
    name: "Omni-Arena · Anonymous B",
    kind: "slot",
    slot: "B",
    description:
      "Slot B of a blind matchup. Select this together with 'Omni-Arena · Anonymous A'.",
  },
  "omni-arena-single": {
    name: "Omni-Arena · Single Model (no vote)",
    kind: "single",
    description:
      "Omni-Arena's `single` plan: one model, no matchup, no vote. The honest shape of an OpenAI-compatible round.",
  },
  "omni-arena-raw": {
    name: "Omni-Arena · Raw adapter passthrough (broken on purpose)",
    kind: "raw",
    description:
      "Omni-Arena's openai-sse adapter piped through byte-for-byte, two choices and all. Included as evidence: pick it and only Answer A appears, because Open WebUI reads choices[0] and discards choices[1].",
  },
};

export function modelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: Object.entries(MODELS).map(([id, model]) => ({
      id,
      object: "model",
      created,
      owned_by: "omni-arena",
      // Not part of the OpenAI schema, but Open WebUI honours it:
      // `'name': model.get('name', model_id)` in routers/openai.py.
      name: model.name,
      description: model.description,
    })),
  };
}
