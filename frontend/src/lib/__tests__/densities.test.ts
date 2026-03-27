import { describe, expect, test } from "bun:test";
import { findDensity, volumeToWeight, weightToVolume } from "../densities";

describe("findDensity", () => {
  test("matches exact ingredient names", () => {
    expect(findDensity("all-purpose flour")).not.toBeNull();
    expect(findDensity("sugar")).not.toBeNull();
    expect(findDensity("butter")).not.toBeNull();
    expect(findDensity("milk")).not.toBeNull();
  });

  test("case insensitive", () => {
    expect(findDensity("All-Purpose Flour")).not.toBeNull();
    expect(findDensity("SUGAR")).not.toBeNull();
    expect(findDensity("Butter")).not.toBeNull();
  });

  test("matches when keyword is part of a longer item name", () => {
    expect(findDensity("all-purpose flour, sifted")).not.toBeNull();
    expect(findDensity("unsalted butter, softened")).not.toBeNull();
    expect(findDensity("granulated sugar")).not.toBeNull();
    expect(findDensity("cold buttermilk")).not.toBeNull();
  });

  test("prefers more specific match", () => {
    // "almond flour" should match as "almond flour" (96g), not "flour" (120g)
    const almond = findDensity("almond flour")!;
    expect(almond.matchedAs).toBe("almond flour");

    // "coconut flour" should match as "coconut flour" (112g), not "flour"
    const coconut = findDensity("coconut flour")!;
    expect(coconut.matchedAs).toBe("coconut flour");

    // "brown sugar" should match as "brown sugar" (213g), not "sugar" (198g)
    const brown = findDensity("brown sugar")!;
    expect(brown.matchedAs).toBe("brown sugar");

    // "oat flour" should match as "oat flour" (92g), not "oats" (80g)
    const oat = findDensity("oat flour")!;
    expect(oat.matchedAs).toBe("oat flour");
  });

  test("whole-word matching avoids false positives", () => {
    // "flour" should not match "cauliflower"
    expect(findDensity("cauliflower")).toBeNull();
    // "rice" should not match "price" or "licorice"
    expect(findDensity("licorice")).toBeNull();
    // "oil" should not match "foil" or "soil"
    expect(findDensity("aluminum foil")).toBeNull();
  });

  test("returns null for unknown ingredients", () => {
    expect(findDensity("chicken breast")).toBeNull();
    expect(findDensity("garlic cloves")).toBeNull();
    expect(findDensity("onion")).toBeNull();
    expect(findDensity("eggs")).toBeNull();
    expect(findDensity("")).toBeNull();
  });

  test("matches all flour types", () => {
    const flours = [
      "all-purpose flour", "bread flour", "cake flour", "pastry flour",
      "whole wheat flour", "oat flour", "almond flour", "coconut flour",
      "rye flour", "rice flour", "semolina flour", "buckwheat flour",
      "tapioca flour", "chickpea flour",
    ];
    for (const f of flours) {
      expect(findDensity(f)).not.toBeNull();
    }
  });

  test("matches sugars and syrups", () => {
    for (const s of ["sugar", "brown sugar", "powdered sugar", "honey", "maple syrup", "molasses"]) {
      expect(findDensity(s)).not.toBeNull();
    }
  });

  test("matches fats", () => {
    for (const f of ["butter", "olive oil", "vegetable oil", "coconut oil", "shortening", "lard"]) {
      expect(findDensity(f)).not.toBeNull();
    }
  });

  test("matches powders and leaveners", () => {
    for (const p of ["baking powder", "baking soda", "cocoa powder", "cinnamon", "salt"]) {
      expect(findDensity(p)).not.toBeNull();
    }
  });

  test("matches nuts", () => {
    for (const n of ["almonds", "walnuts", "pecans", "cashews", "hazelnuts", "peanuts", "peanut butter"]) {
      expect(findDensity(n)).not.toBeNull();
    }
  });

  test("matches dairy", () => {
    for (const d of ["milk", "heavy cream", "sour cream", "yogurt", "cream cheese"]) {
      expect(findDensity(d)).not.toBeNull();
    }
  });

  test("matches starches and grains", () => {
    for (const s of ["cornstarch", "cornmeal", "rice", "oats", "breadcrumbs", "panko"]) {
      expect(findDensity(s)).not.toBeNull();
    }
  });
});

describe("volumeToWeight", () => {
  const CUP = 236.588;
  const TBSP = 14.787;
  const TSP = 4.929;

  test("1 cup all-purpose flour = ~120g", () => {
    const grams = volumeToWeight(CUP, findDensity("all-purpose flour")!);
    expect(grams).toBeCloseTo(120, 0);
  });

  test("1 cup bread flour = ~130g", () => {
    const grams = volumeToWeight(CUP, findDensity("bread flour")!);
    expect(grams).toBeCloseTo(130, 0);
  });

  test("1 cup oat flour = ~92g", () => {
    const grams = volumeToWeight(CUP, findDensity("oat flour")!);
    expect(grams).toBeCloseTo(92, 0);
  });

  test("1 cup almond flour = ~96g", () => {
    const grams = volumeToWeight(CUP, findDensity("almond flour")!);
    expect(grams).toBeCloseTo(96, 0);
  });

  test("1 cup sugar = ~198g", () => {
    const grams = volumeToWeight(CUP, findDensity("sugar")!);
    expect(grams).toBeCloseTo(198, 0);
  });

  test("1 cup brown sugar = ~213g", () => {
    const grams = volumeToWeight(CUP, findDensity("brown sugar")!);
    expect(grams).toBeCloseTo(213, 0);
  });

  test("1 cup honey = ~340g", () => {
    const grams = volumeToWeight(CUP, findDensity("honey")!);
    expect(grams).toBeCloseTo(340, 0);
  });

  test("1 tbsp butter = ~14.2g", () => {
    const grams = volumeToWeight(TBSP, findDensity("butter")!);
    expect(grams).toBeCloseTo(14.2, 0);
  });

  test("1 cup butter = ~227g", () => {
    const grams = volumeToWeight(CUP, findDensity("butter")!);
    expect(grams).toBeCloseTo(227, 0);
  });

  test("1 tbsp olive oil = ~13.5g", () => {
    const grams = volumeToWeight(TBSP, findDensity("olive oil")!);
    expect(grams).toBeCloseTo(13.5, 0);
  });

  test("1 tsp baking powder = ~4.8g", () => {
    const grams = volumeToWeight(TSP, findDensity("baking powder")!);
    expect(grams).toBeCloseTo(4.8, 0);
  });

  test("1 tsp baking soda = ~7g", () => {
    const grams = volumeToWeight(TSP, findDensity("baking soda")!);
    expect(grams).toBeCloseTo(7, 0);
  });

  test("1 tsp salt = ~6g", () => {
    const grams = volumeToWeight(TSP, findDensity("salt")!);
    expect(grams).toBeCloseTo(6, 0);
  });

  test("1 tsp cinnamon = ~3g", () => {
    const grams = volumeToWeight(TSP, findDensity("cinnamon")!);
    expect(grams).toBeCloseTo(3, 0);
  });

  test("1 cup cocoa powder = ~82g", () => {
    const grams = volumeToWeight(CUP, findDensity("cocoa powder")!);
    expect(grams).toBeCloseTo(82, 0);
  });

  test("1 cup milk = ~245g", () => {
    const grams = volumeToWeight(CUP, findDensity("milk")!);
    expect(grams).toBeCloseTo(245, 0);
  });

  test("1 cup heavy cream = ~238g", () => {
    const grams = volumeToWeight(CUP, findDensity("heavy cream")!);
    expect(grams).toBeCloseTo(238, 0);
  });

  test("1 cup rice = ~185g", () => {
    const grams = volumeToWeight(CUP, findDensity("rice")!);
    expect(grams).toBeCloseTo(185, 0);
  });

  test("1 cup oats = ~80g", () => {
    const grams = volumeToWeight(CUP, findDensity("oats")!);
    expect(grams).toBeCloseTo(80, 0);
  });

  test("1 cup chocolate chips = ~170g", () => {
    const grams = volumeToWeight(CUP, findDensity("chocolate chips")!);
    expect(grams).toBeCloseTo(170, 0);
  });

  test("1 cup almonds = ~143g", () => {
    const grams = volumeToWeight(CUP, findDensity("almonds")!);
    expect(grams).toBeCloseTo(143, 0);
  });

  test("1 cup peanut butter = ~258g", () => {
    const grams = volumeToWeight(CUP, findDensity("peanut butter")!);
    expect(grams).toBeCloseTo(258, 0);
  });
});

describe("weightToVolume", () => {
  const CUP = 236.588;

  test("120g flour = ~1 cup", () => {
    const ml = weightToVolume(120, findDensity("flour")!);
    expect(ml).toBeCloseTo(CUP, 0);
  });

  test("227g butter = ~1 cup", () => {
    const ml = weightToVolume(227, findDensity("butter")!);
    expect(ml).toBeCloseTo(CUP, 0);
  });

  test("198g sugar = ~1 cup", () => {
    const ml = weightToVolume(198, findDensity("sugar")!);
    expect(ml).toBeCloseTo(CUP, 0);
  });

  test("round-trip: volumeToWeight then weightToVolume", () => {
    const density = findDensity("honey")!;
    const grams = volumeToWeight(CUP, density);
    const ml = weightToVolume(grams, density);
    expect(ml).toBeCloseTo(CUP, 0);
  });

  test("round-trip for cocoa powder", () => {
    const density = findDensity("cocoa powder")!;
    const grams = volumeToWeight(CUP, density);
    const ml = weightToVolume(grams, density);
    expect(ml).toBeCloseTo(CUP, 0);
  });
});

describe("findDensity - realistic recipe item names", () => {
  test("ingredient with modifiers", () => {
    expect(findDensity("sifted all-purpose flour")).not.toBeNull();
    expect(findDensity("packed brown sugar")).not.toBeNull();
    expect(findDensity("melted unsalted butter")).not.toBeNull();
    expect(findDensity("room temperature cream cheese")).not.toBeNull();
    expect(findDensity("extra virgin olive oil")).not.toBeNull();
    expect(findDensity("pure maple syrup")).not.toBeNull();
  });

  test("ingredient with trailing descriptions", () => {
    expect(findDensity("flour (spooned and leveled)")).not.toBeNull();
    expect(findDensity("butter, cut into cubes")).not.toBeNull();
    expect(findDensity("milk, warmed")).not.toBeNull();
    expect(findDensity("walnuts, roughly chopped")).not.toBeNull();
  });

  test("specificity with real recipe names", () => {
    // "whole wheat flour" shouldn't match as just "flour"
    const ww = findDensity("whole wheat flour")!;
    expect(ww.matchedAs).toBe("whole wheat flour");

    // "powdered sugar" shouldn't match as "sugar"
    const ps = findDensity("powdered sugar")!;
    expect(ps.matchedAs).toBe("powdered sugar");

    // "coconut oil" shouldn't match as just "oil"
    const co = findDensity("coconut oil")!;
    expect(co.matchedAs).toBe("coconut oil");
  });
});
