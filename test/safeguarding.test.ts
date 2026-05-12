import { describe, expect, it } from "vitest";
import { detectSafeguarding } from "../src/safety/safeguarding.js";

/**
 * The safeguarding pre-filter is the single highest-stakes piece of logic
 * in this system. We test it as a labelled gold set rather than via
 * snapshot, because the cost of a false negative (missed safeguarding
 * case) is far higher than the cost of a false positive. Adding new rows
 * to either list is the cheap way to harden the system over time.
 */

const POSITIVES: Array<{ name: string; text: string }> = [
  {
    name: "visible-8 item_2 phrase",
    text: "He has been more clingy since his dad started getting rough with him during weekends.",
  },
  {
    name: "explicit abuse",
    text: "I think my husband is abusing our daughter.",
  },
  {
    name: "neglect",
    text: "I'm worried the child is being neglected at home.",
  },
  { name: "afraid of dad", text: "She is afraid of her dad coming home." },
  {
    name: "unsafe at home",
    text: "She's said it isn't safe at home and asked to stay with grandma.",
  },
  { name: "hits him", text: "Mom hits him when he doesn't listen." },
  {
    name: "bruises",
    text: "He came in last week with bruises on his arms; the parent's explanation didn't add up.",
  },
  {
    name: "self-harm",
    text: "He told the SLP he wanted to hurt himself; please flag for clinical review.",
  },
  {
    name: "scared of stepfather",
    text: "Lately he says he's scared of his stepfather.",
  },
  // Regressions: passive constructions found by Boris-review edge testing.
  // Earlier versions missed these because the active patterns required a
  // direct object like "hit him" / "hit the kid".
  {
    name: "passive 'getting hit at home'",
    text: "Also my child has been getting hit at home but it's fine.",
  },
  {
    name: "passive 'being beat'",
    text: "He's been being beat by his stepfather for months.",
  },
  {
    name: "caregiver-subject 'dad hits'",
    text: "Dad hits the boys when he drinks.",
  },
];

const NEGATIVES: Array<{ name: string; text: string }> = [
  { name: "rough weekend", text: "We had a rough weekend with the move." },
  {
    name: "rough surface (OT context)",
    text: "She has trouble tolerating rough textures during feeding.",
  },
  {
    name: "afraid (generic anxiety)",
    text: "She gets afraid of loud noises at preschool.",
  },
  {
    name: "rough day (no caregiver subject)",
    text: "He had a rough day at school yesterday.",
  },
  {
    name: "clingy without caregiver-conduct phrasing",
    text: "He has been more clingy lately and is having trouble with transitions.",
  },
  {
    name: "kicked the ball",
    text: "He kicked the soccer ball into the net.",
  },
  {
    name: "abuse in product-description sense (not present, control)",
    text: "We are reaching out about scheduling for our 4-year-old daughter.",
  },
];

describe("safeguarding detector — positives", () => {
  for (const { name, text } of POSITIVES) {
    it(`flags "${name}"`, () => {
      const hit = detectSafeguarding(text);
      expect(hit.hit).toBe(true);
      expect(hit.matchedPhrase).not.toBeNull();
    });
  }
});

describe("safeguarding detector — negatives", () => {
  for (const { name, text } of NEGATIVES) {
    it(`does NOT flag "${name}"`, () => {
      const hit = detectSafeguarding(text);
      expect(hit.hit).toBe(false);
    });
  }
});
