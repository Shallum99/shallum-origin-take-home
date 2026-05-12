import { describe, expect, it } from "vitest";
import {
  detectSafeguarding,
  type SafeguardingCategory,
} from "../src/safety/safeguarding.js";

/**
 * The safeguarding pre-filter is the single highest-stakes piece of logic
 * in this system. We test it as a labelled gold set rather than via
 * snapshot, because the cost of a false negative (missed safeguarding
 * case) is far higher than the cost of a false positive.
 *
 * Coverage is organized around the PedHITSS clinical screening tool's
 * five domains (physical harm, insults, threats, yelling, sexual abuse)
 * plus the additional domains we surface (fear of caregiver, unsafe at
 * home, self-harm). Each domain has English AND Spanish positives.
 */

interface Case {
  name: string;
  text: string;
  expectedCategory?: SafeguardingCategory;
  expectedLanguage?: "en" | "es";
}

const POSITIVES: Case[] = [
  // -- visible-8 + earlier regressions ---------------------------------------
  {
    name: "visible-8 item_2 phrase",
    text: "He has been more clingy since his dad started getting rough with him during weekends.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },
  {
    name: "passive 'getting hit at home'",
    text: "Also my child has been getting hit at home but it's fine.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },
  {
    name: "passive 'being beat'",
    text: "He's been being beat by his stepfather for months.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },
  {
    name: "caregiver-subject 'dad hits'",
    text: "Dad hits the boys when he drinks.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },

  // -- PedHITSS: physical_harm (EN) -----------------------------------------
  {
    name: "explicit abuse",
    text: "I think my husband is abusing our daughter.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },
  {
    name: "neglect",
    text: "I'm worried the child is being neglected at home.",
    expectedCategory: "physical_harm",
    expectedLanguage: "en",
  },
  { name: "hits him", text: "Mom hits him when he doesn't listen." },
  {
    name: "bruises",
    text: "He came in last week with bruises on his arms; the parent's explanation didn't add up.",
    expectedCategory: "physical_harm",
  },
  {
    name: "marks observation",
    text: "There are marks all over his arms when he comes to therapy.",
    expectedCategory: "physical_harm",
  },

  // -- PedHITSS: verbal_insults (EN) ----------------------------------------
  {
    name: "caregiver calls child stupid",
    text: "Dad calls him stupid and worthless every day.",
    expectedCategory: "verbal_insults",
    expectedLanguage: "en",
  },
  {
    name: "child reports being called worthless",
    text: "She says she's worthless because her mom told her so.",
    expectedCategory: "verbal_insults",
  },

  // -- PedHITSS: threats (EN) -----------------------------------------------
  {
    name: "threatened to hurt",
    text: "He said he'd hurt her if she told anyone.",
    expectedCategory: "threats",
    expectedLanguage: "en",
  },
  {
    name: "explicit threat verb",
    text: "Her father has been threatening her and the family.",
    expectedCategory: "threats",
  },

  // -- PedHITSS: yelling (EN) -----------------------------------------------
  {
    name: "yells at the kid",
    text: "He yells at the kid for not finishing dinner.",
    expectedCategory: "yelling",
    expectedLanguage: "en",
  },
  {
    name: "screaming at her",
    text: "Stepdad keeps screaming at her at night.",
    expectedCategory: "yelling",
  },

  // -- PedHITSS: sexual_abuse (EN) ------------------------------------------
  {
    name: "inappropriate touching",
    text: "She said her uncle has been touching her in a bad way.",
    expectedCategory: "sexual_abuse",
    expectedLanguage: "en",
  },
  {
    name: "explicit molested",
    text: "I'm worried he was molested by a family friend.",
    expectedCategory: "sexual_abuse",
  },

  // -- fear_of_caregiver / unsafe_at_home / self-harm (EN) ------------------
  {
    name: "afraid of dad",
    text: "She is afraid of her dad coming home.",
    expectedCategory: "fear_of_caregiver",
  },
  {
    name: "scared of stepfather",
    text: "Lately he says he's scared of his stepfather.",
    expectedCategory: "fear_of_caregiver",
  },
  {
    name: "doesn't want to go home",
    text: "She doesn't want to go home after school anymore.",
    expectedCategory: "fear_of_caregiver",
  },
  {
    name: "unsafe at home",
    text: "She's said it isn't safe at home and asked to stay with grandma.",
    expectedCategory: "unsafe_at_home",
  },
  {
    name: "self-harm",
    text: "He told the SLP he wanted to hurt himself; please flag for clinical review.",
    expectedCategory: "self_harm",
  },

  // -- Spanish positives (Spanish-speaking population is real) --------------
  {
    name: "ES physical: le pega",
    text: "Mi esposo le pega a mi hijo cuando se enoja.",
    expectedCategory: "physical_harm",
    expectedLanguage: "es",
  },
  {
    name: "ES abuse: abuso",
    text: "Necesito ayuda, hay abuso en casa.",
    expectedCategory: "physical_harm",
    expectedLanguage: "es",
  },
  {
    name: "ES bruises: moretones",
    text: "Mi hija tiene moretones que no puede explicar.",
    expectedCategory: "physical_harm",
    expectedLanguage: "es",
  },
  {
    name: "ES fear: tiene miedo de su papá",
    text: "Mi hijo le tiene miedo a su padrastro y no quiere ir a casa.",
    expectedCategory: "fear_of_caregiver",
    expectedLanguage: "es",
  },
  {
    name: "ES unsafe at home: no es seguro",
    text: "Creo que ya no es seguro en casa para los niños.",
    expectedCategory: "unsafe_at_home",
    expectedLanguage: "es",
  },
  {
    name: "ES threats: amenazó",
    text: "Su padre la amenazó con lastimarla.",
    expectedCategory: "threats",
    expectedLanguage: "es",
  },
  {
    name: "ES yelling: le grita",
    text: "El papá le grita todo el tiempo a mi hija.",
    expectedCategory: "yelling",
    expectedLanguage: "es",
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
    name: "control message: normal scheduling",
    text: "We are reaching out about scheduling for our 4-year-old daughter.",
  },
  // Spanish hard negatives — generic phrases that share vocabulary but aren't safeguarding.
  {
    name: "ES generic 'mi hija' (not safeguarding)",
    text: "Hola, llamo para preguntar por una cita para mi hija. Gracias.",
  },
  {
    name: "ES bumping into things (not bruise pattern)",
    text: "Mi hijo se cae mucho cuando juega, pero está bien.",
  },
];

describe("safeguarding detector — positives", () => {
  for (const { name, text, expectedCategory, expectedLanguage } of POSITIVES) {
    it(`flags "${name}"`, () => {
      const hit = detectSafeguarding(text);
      expect(hit.hit).toBe(true);
      expect(hit.matchedPhrase).not.toBeNull();
      if (expectedCategory) expect(hit.category).toBe(expectedCategory);
      if (expectedLanguage) expect(hit.language).toBe(expectedLanguage);
    });
  }
});

describe("safeguarding detector — negatives", () => {
  for (const { name, text } of NEGATIVES) {
    it(`does NOT flag "${name}"`, () => {
      const hit = detectSafeguarding(text);
      expect(hit.hit).toBe(false);
      expect(hit.category).toBeNull();
      expect(hit.language).toBeNull();
    });
  }
});
