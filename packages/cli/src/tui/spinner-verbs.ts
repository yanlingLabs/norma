// Whimsical verb lists for the in-progress spinner and the turn-complete
// summary line. These are Norma's own words — written fresh for this project,
// not lifted from any other tool's list. `pickVerb` is a pure, deterministic
// selector: callers inject a seed (e.g. the turn's start timestamp) so the
// same seed always yields the same verb, with no wall-clock or RNG access
// inside this module.

/** ~50 original whimsical gerunds shown while Norma is working on a turn. */
export const SPINNER_VERBS: string[] = [
  "Percolating",
  "Untangling",
  "Sketching",
  "Doodling",
  "Threading",
  "Weaving",
  "Kneading",
  "Simmering",
  "Distilling",
  "Polishing",
  "Whittling",
  "Tinkering",
  "Puzzling",
  "Wrangling",
  "Foraging",
  "Sifting",
  "Rummaging",
  "Assembling",
  "Calibrating",
  "Charting",
  "Deciphering",
  "Divining",
  "Excavating",
  "Fermenting",
  "Gathering",
  "Harmonizing",
  "Illuminating",
  "Journaling",
  "Kindling",
  "Layering",
  "Mapping",
  "Nudging",
  "Orbiting",
  "Pondering",
  "Quilting",
  "Refining",
  "Scheming",
  "Stitching",
  "Sculpting",
  "Tuning",
  "Unspooling",
  "Wandering",
  "Yodeling",
  "Zigzagging",
  "Brainstorming",
  "Composing",
  "Etching",
  "Fizzing",
  "Grokking",
  "Hatching",
  "Incubating",
  "Jamming",
];

/** ~8 past-tense verbs for the "turn complete" summary line. Must include "Worked". */
export const TURN_VERBS: string[] = [
  "Worked",
  "Tinkered",
  "Polished",
  "Kneaded",
  "Distilled",
  "Woven",
  "Sculpted",
  "Simmered",
];

/**
 * Deterministically pick an entry from `list` using `seed`. Equal seeds
 * always yield equal results; no Math.random / Date.now inside this module —
 * callers supply the seed (e.g. a turn-start timestamp captured elsewhere).
 */
export function pickVerb(list: string[], seed: number): string {
  if (list.length === 0) {
    throw new Error("pickVerb: list must not be empty");
  }
  const index = Math.abs(seed) % list.length;
  return list[index] as string;
}
