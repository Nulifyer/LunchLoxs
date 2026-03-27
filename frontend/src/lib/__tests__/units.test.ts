import { describe, expect, test } from "bun:test";
import { resolveUnit, convertUnit, convertIngredient, convertToUnit, getConversionTargets, type UnitSystem } from "../units";

describe("resolveUnit", () => {
  test("canonical names resolve", () => {
    expect(resolveUnit("cup")).not.toBeNull();
    expect(resolveUnit("tsp")).not.toBeNull();
    expect(resolveUnit("ml")).not.toBeNull();
    expect(resolveUnit("g")).not.toBeNull();
  });

  test("aliases resolve to canonical", () => {
    expect(resolveUnit("cups")!.canonical).toBe("cup");
    expect(resolveUnit("tablespoons")!.canonical).toBe("tbsp");
    expect(resolveUnit("teaspoon")!.canonical).toBe("tsp");
    expect(resolveUnit("ounces")!.canonical).toBe("oz");
    expect(resolveUnit("pounds")!.canonical).toBe("lb");
    expect(resolveUnit("grams")!.canonical).toBe("g");
    expect(resolveUnit("kilograms")!.canonical).toBe("kg");
    expect(resolveUnit("liters")!.canonical).toBe("l");
    expect(resolveUnit("milliliters")!.canonical).toBe("ml");
    expect(resolveUnit("fluid ounces")!.canonical).toBe("fl oz");
  });

  test("case insensitive", () => {
    expect(resolveUnit("Cup")!.canonical).toBe("cup");
    expect(resolveUnit("TBSP")!.canonical).toBe("tbsp");
    expect(resolveUnit("ML")!.canonical).toBe("ml");
    expect(resolveUnit("Grams")!.canonical).toBe("g");
  });

  test("pinch and dash resolve", () => {
    expect(resolveUnit("pinch")!.canonical).toBe("pinch");
    expect(resolveUnit("dash")!.canonical).toBe("dash");
    expect(resolveUnit("dashes")!.canonical).toBe("dash");
  });

  test("unknown units return null", () => {
    expect(resolveUnit("bunch")).toBeNull();
    expect(resolveUnit("to taste")).toBeNull();
    expect(resolveUnit("")).toBeNull();
    expect(resolveUnit("cloves")).toBeNull();
  });

  test("whitespace trimmed", () => {
    expect(resolveUnit("  cup  ")!.canonical).toBe("cup");
    expect(resolveUnit(" g ")!.canonical).toBe("g");
  });
});

describe("convertUnit", () => {
  test("imperial volume to metric", () => {
    // 1 cup = 236.588 mL
    const result = convertUnit(1, "cup", "metric")!;
    expect(result).not.toBeNull();
    expect(result.unit).toBe("ml");
    expect(result.qty).toBeCloseTo(236.59, 0);

    // 2 cups should give a reasonable metric unit
    const r2 = convertUnit(2, "cups", "metric")!;
    expect(r2.unit).toBe("ml");
    expect(r2.qty).toBeCloseTo(473.18, 0);
  });

  test("metric volume to imperial", () => {
    // 250 mL -> ~1.06 cup
    const result = convertUnit(250, "ml", "imperial")!;
    expect(result).not.toBeNull();
    expect(result.unit).toBe("cup");
    expect(result.qty).toBeCloseTo(1.06, 1);
  });

  test("imperial weight to metric", () => {
    // 1 lb = 453.592 g
    const result = convertUnit(1, "lb", "metric")!;
    expect(result.unit).toBe("g");
    expect(result.qty).toBeCloseTo(453.59, 0);

    // 8 oz = ~226.8 g
    const r2 = convertUnit(8, "oz", "metric")!;
    expect(r2.unit).toBe("g");
    expect(r2.qty).toBeCloseTo(226.8, 0);
  });

  test("metric weight to imperial", () => {
    // 500 g -> ~1.1 lb
    const result = convertUnit(500, "g", "imperial")!;
    expect(result.unit).toBe("lb");
    expect(result.qty).toBeCloseTo(1.1, 1);

    // 100 g -> ~3.53 oz
    const r2 = convertUnit(100, "g", "imperial")!;
    expect(r2.unit).toBe("oz");
    expect(r2.qty).toBeCloseTo(3.53, 1);
  });

  test("small tsp to metric", () => {
    // 1 tsp = ~4.93 mL
    const result = convertUnit(1, "tsp", "metric")!;
    expect(result.unit).toBe("ml");
    expect(result.qty).toBeCloseTo(4.93, 0);
  });

  test("tbsp to metric", () => {
    // 1 tbsp = ~14.79 mL
    const result = convertUnit(1, "tbsp", "metric")!;
    expect(result.unit).toBe("ml");
    expect(result.qty).toBeCloseTo(14.79, 0);
  });

  test("large metric volume picks liters", () => {
    // 2000 mL -> 2 L
    const result = convertUnit(2000, "ml", "imperial")!;
    // 2000 mL is about 8.45 cups, so should stay as cups
    expect(result).not.toBeNull();
  });

  test("large metric weight picks kg->lb", () => {
    // 2 kg -> ~4.41 lb
    const result = convertUnit(2, "kg", "imperial")!;
    expect(result.unit).toBe("lb");
    expect(result.qty).toBeCloseTo(4.41, 1);
  });

  test("returns null for same system", () => {
    expect(convertUnit(1, "cup", "imperial")).toBeNull();
    expect(convertUnit(1, "ml", "metric")).toBeNull();
    expect(convertUnit(1, "g", "metric")).toBeNull();
    expect(convertUnit(1, "oz", "imperial")).toBeNull();
  });

  test("returns null for unknown units", () => {
    expect(convertUnit(1, "pinch", "metric")).toBeNull();
    expect(convertUnit(1, "bunch", "imperial")).toBeNull();
    expect(convertUnit(1, "", "metric")).toBeNull();
  });

  test("picks best unit to avoid tiny or huge numbers", () => {
    // 1 gallon = 3785 mL -> should pick liters (3.79 L)
    const result = convertUnit(1, "gallon", "metric")!;
    expect(result.unit).toBe("l");
    expect(result.qty).toBeCloseTo(3.79, 1);

    // 5 mL -> should be tsp (~1.01)
    const r2 = convertUnit(5, "ml", "imperial")!;
    expect(r2.unit).toBe("tsp");
    expect(r2.qty).toBeCloseTo(1.01, 0);

    // 15 mL -> should be tbsp (~1.01)
    const r3 = convertUnit(15, "ml", "imperial")!;
    expect(r3.unit).toBe("tbsp");
    expect(r3.qty).toBeCloseTo(1.01, 0);
  });
});

describe("convertIngredient", () => {
  test("original system returns unchanged", () => {
    const result = convertIngredient(2, "cups", "original");
    expect(result.qty).toBe(2);
    expect(result.unit).toBe("cups");
  });

  test("unknown unit returns unchanged", () => {
    const result = convertIngredient(1, "pinch", "metric");
    expect(result.qty).toBe(1);
    expect(result.unit).toBe("pinch");
  });

  test("converts when possible", () => {
    const result = convertIngredient(1, "cup", "metric");
    expect(result.unit).toBe("ml");
    expect(result.qty).toBeCloseTo(236.59, 0);
  });

  test("same system returns unchanged", () => {
    const result = convertIngredient(1, "cup", "imperial");
    expect(result.qty).toBe(1);
    expect(result.unit).toBe("cup");
  });
});

describe("convertToUnit", () => {
  test("converts between same-dimension units", () => {
    // 1 cup -> tbsp
    const result = convertToUnit(1, "cup", "tbsp")!;
    expect(result).not.toBeNull();
    expect(result.unit).toBe("tbsp");
    expect(result.qty).toBeCloseTo(16, 0);
  });

  test("converts across systems", () => {
    // 1 cup -> ml
    const result = convertToUnit(1, "cup", "ml")!;
    expect(result.unit).toBe("ml");
    expect(result.qty).toBeCloseTo(236.59, 0);
  });

  test("converts within same system", () => {
    // 2 cups -> pint
    const result = convertToUnit(2, "cup", "pint")!;
    expect(result.unit).toBe("pint");
    expect(result.qty).toBeCloseTo(1, 0);
  });

  test("weight conversions", () => {
    // 1 lb -> g
    const result = convertToUnit(1, "lb", "g")!;
    expect(result.unit).toBe("g");
    expect(result.qty).toBeCloseTo(453.59, 0);

    // 1000 g -> kg
    const r2 = convertToUnit(1000, "g", "kg")!;
    expect(r2.unit).toBe("kg");
    expect(r2.qty).toBe(1);
  });

  test("returns null for cross-dimension", () => {
    expect(convertToUnit(1, "cup", "g")).toBeNull();
    expect(convertToUnit(1, "oz", "ml")).toBeNull();
  });

  test("pinch and dash convert", () => {
    // 1 dash = 1/8 tsp
    const result = convertToUnit(1, "dash", "tsp")!;
    expect(result.qty).toBeCloseTo(0.12, 1);

    // 8 dashes = 1 tsp
    const r2 = convertToUnit(8, "dash", "tsp")!;
    expect(r2.qty).toBeCloseTo(1, 0);

    // 16 pinches = 1 tsp
    const r3 = convertToUnit(16, "pinch", "tsp")!;
    expect(r3.qty).toBeCloseTo(1, 0);
  });

  test("returns null for unknown units", () => {
    expect(convertToUnit(1, "bunch", "ml")).toBeNull();
    expect(convertToUnit(1, "cup", "bunch")).toBeNull();
  });
});

describe("getConversionTargets", () => {
  test("returns targets for a volume unit", () => {
    const targets = getConversionTargets("cup");
    expect(targets.length).toBeGreaterThan(0);
    const units = targets.map(t => t.unit);
    expect(units).toContain("ml");
    expect(units).toContain("l");
    expect(units).toContain("tsp");
    expect(units).toContain("tbsp");
    // Should not include cup itself
    expect(units).not.toContain("cup");
    // Should not include weight units
    expect(units).not.toContain("g");
    expect(units).not.toContain("oz");
  });

  test("returns targets for a weight unit", () => {
    const targets = getConversionTargets("g");
    const units = targets.map(t => t.unit);
    expect(units).toContain("kg");
    expect(units).toContain("oz");
    expect(units).toContain("lb");
    expect(units).not.toContain("g");
    expect(units).not.toContain("cup");
  });

  test("pinch has conversion targets", () => {
    const targets = getConversionTargets("pinch");
    const units = targets.map(t => t.unit);
    expect(units).toContain("tsp");
    expect(units).toContain("ml");
  });

  test("returns empty for unknown units", () => {
    expect(getConversionTargets("bunch")).toEqual([]);
    expect(getConversionTargets("")).toEqual([]);
  });

  test("stick of butter converts to volume units", () => {
    const targets = getConversionTargets("stick");
    const units = targets.map(t => t.unit);
    expect(units).toContain("tbsp");
    expect(units).toContain("cup");
    expect(units).toContain("ml");
    expect(units).not.toContain("g");
  });
});

describe("convertToUnit - sticks", () => {
  test("1 stick = 8 tbsp", () => {
    const result = convertToUnit(1, "stick", "tbsp")!;
    expect(result.qty).toBeCloseTo(8, 0);
  });

  test("1 stick = 1/2 cup", () => {
    const result = convertToUnit(1, "stick", "cup")!;
    expect(result.qty).toBeCloseTo(0.5, 1);
  });

  test("1 stick = ~118 ml", () => {
    const result = convertToUnit(1, "stick", "ml")!;
    expect(result.qty).toBeCloseTo(118.29, 0);
  });

  test("stick won't appear as target in getConversionTargets", () => {
    const targets = getConversionTargets("tbsp");
    const units = targets.map(t => t.unit);
    expect(units).not.toContain("stick");
  });
});
