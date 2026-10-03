/**
 * fingerprint/probe-prompts.mjs — the questions we ask to get a fingerprint
 *
 * The probe works because a model cannot help biasing which numbers it picks.
 * That bias is small, so the ask has to be narrow: a long run of plain integers
 * in a fixed range, with nothing to reason about and no room to show off. Any
 * prompt that invites deliberation — "pick random numbers", "be creative" — lets
 * the model choose a *strategy* (evens, descending, memorable numbers) and the
 * strategy drowns the fingerprint.
 *
 * Several variants, not one. The bank has to separate "which model" from "what
 * circumstances", and circumstances is exactly what a variant varies: same
 * model, different wording, slightly different distribution. A bank collected
 * from a single variant has no way to learn that difference and would read it
 * as identity.
 *
 * These prompts are written for this project. They are not copied from any
 * reference implementation.
 */

const COUNT = 240;

/**
 * The shared instruction. Everything before the variant clause is identical on
 * purpose: it pins down the output shape, so a failure to parse means the model
 * ignored the format, not that our wording drifted.
 */
const RULES = [
  `Output exactly ${COUNT} integers, one after another, separated by single spaces.`,
  "Every integer must be between 1 and 355.",
  "Answer with the numbers only — no explanation, no code block, no preamble, no list markers.",
  "Do not use a tool. Do not count. Do not aim for a pattern.",
].join("\n");

/**
 * Each variant is a different way to ask for the same thing. The openers are
 * deliberately not paraphrases of one another: they frame the task differently
 * (intuition / quickness / free association), which is what makes the resulting
 * offset directions informative when the bank estimates them.
 */
const VARIANTS = [
  {
    id: "v1-instant",
    clause: "Write down the first numbers that come to mind, as fast as you can, without checking them.",
  },
  {
    id: "v2-gut",
    clause: "Go with your gut. Whatever number surfaces next is the one to write, then move on immediately.",
  },
  {
    id: "v3-freeflow",
    clause: "Let the numbers flow out in whatever order they arrive. Do not go back and adjust anything.",
  },
  {
    id: "v4-reflex",
    clause: "Reply reflexively, the way you would if asked aloud and answering in the same breath.",
  },
  {
    id: "v5-nothink",
    clause: "Do not think about this question. Produce the next number repeatedly until you have enough.",
  },
  {
    id: "v6-unplanned",
    clause: "Produce them without a plan. There is no correct answer to find, so do not look for one.",
  },
  {
    id: "v7-spontaneous",
    clause: "Be spontaneous. Take whatever the next impulse gives you and keep going to the end.",
  },
  {
    id: "v8-immediate",
    clause: "Answer immediately and keep answering. No deliberation between one number and the next.",
  },
  {
    id: "v9-wander",
    clause: "Let the sequence wander where it wants. You are not steering it, only writing it down.",
  },
  {
    id: "v10-default",
    clause: "Use whatever number your default response produces, then repeat for the full set.",
  },
  {
    id: "v11-unedited",
    clause: "Write them unedited. If a number feels odd, that is fine — keep it and continue.",
  },
  {
    id: "v12-attention-off",
    clause: "Keep your attention off the choices. Produce the run and stop when you reach the count.",
  },
];

/** The number of integers each probe asks for. */
export const PROBE_COUNT = COUNT;

/** Identifiers of every variant, in bank order. */
export function variantIds() {
  return VARIANTS.map((v) => v.id);
}

/**
 * The prompt for one variant. Accepts either a variant id or a zero-based
 * index, so a collector can walk the set without hardcoding names.
 *
 * An unknown variant throws rather than falling back to a default: silently
 * probing with the wrong wording would poison the bank, and a bank is only
 * rebuilt rarely, so a loud failure is far cheaper than a quiet one.
 */
export function probePrompt(variant) {
  const found =
    typeof variant === "number" ? VARIANTS[variant] : VARIANTS.find((v) => v.id === variant);
  if (!found) throw new Error(`unknown probe variant: ${variant}`);
  return `${found.clause}\n\n${RULES}`;
}

/**
 * Which variant a prompt came from, or null. The collector tags each archived
 * reply with this, and the bank needs the tag to group conditions — so it has
 * to survive a round trip through whatever transcribed the prompt.
 */
export function variantOfPrompt(prompt) {
  const text = String(prompt || "");
  const found = VARIANTS.find((v) => text.includes(v.clause));
  return found ? found.id : null;
}

/**
 * A short nonce that makes each probe a distinct turn.
 *
 * The bridge memoises sessions by prompt hash, so sending the identical probe
 * text twice can be served as the previous turn instead of running a new one —
 * which would silently stack duplicate records for one reply. Tagging the
 * prompt keeps every probe a genuinely new turn.
 */
export function probeNonce(random = Math.random) {
  const n = Math.floor(random() * 0xffffffff) >>> 0;
  return n.toString(16).padStart(8, "0");
}

/** The prompt actually sent: variant clause + rules + a nonce line. */
export function probeTurn(variant, random = Math.random) {
  return `${probePrompt(variant)}\n\n(probe ${probeNonce(random)})`;
}
