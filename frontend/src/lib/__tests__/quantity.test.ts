import { describe, expect, test } from "bun:test";
import { parseQty, formatQty, scaleQty } from "../quantity";

describe("parseQty", () => {
  test("integers", () => {
    expect(parseQty("1")).toBe(1);
    expect(parseQty("12")).toBe(12);
    expect(parseQty("0")).toBe(0);
  });

  test("leading zeros", () => {
    expect(parseQty("01")).toBe(1);
    expect(parseQty("03")).toBe(3);
  });

  test("decimals", () => {
    expect(parseQty("1.5")).toBe(1.5);
    expect(parseQty("0.25")).toBe(0.25);
    expect(parseQty("10.75")).toBe(10.75);
  });

  test("comma decimals", () => {
    expect(parseQty("1,5")).toBe(1.5);
    expect(parseQty("0,25")).toBe(0.25);
  });

  test("simple fractions", () => {
    expect(parseQty("1/2")).toBe(0.5);
    expect(parseQty("1/4")).toBe(0.25);
    expect(parseQty("3/4")).toBe(0.75);
    expect(parseQty("2/3")).toBeCloseTo(0.667, 2);
  });

  test("mixed fractions", () => {
    expect(parseQty("1 1/2")).toBe(1.5);
    expect(parseQty("2 1/4")).toBe(2.25);
    expect(parseQty("3 3/4")).toBe(3.75);
  });

  test("approximate prefix", () => {
    expect(parseQty("~2")).toBe(2);
    expect(parseQty("~ 1.5")).toBe(1.5);
    expect(parseQty("~1/2")).toBe(0.5);
  });

  test("whitespace handling", () => {
    expect(parseQty("  2  ")).toBe(2);
    expect(parseQty(" 1/2 ")).toBe(0.5);
    expect(parseQty("")).toBeNull();
    expect(parseQty("   ")).toBeNull();
  });

  test("non-numeric returns null", () => {
    expect(parseQty("a pinch")).toBeNull();
    expect(parseQty("some")).toBeNull();
    expect(parseQty("to taste")).toBeNull();
  });
});

describe("formatQty", () => {
  test("whole numbers", () => {
    expect(formatQty(1)).toBe("1");
    expect(formatQty(4)).toBe("4");
    expect(formatQty(10)).toBe("10");
  });

  test("common fractions", () => {
    expect(formatQty(0.25)).toBe("1/4");
    expect(formatQty(0.5)).toBe("1/2");
    expect(formatQty(0.75)).toBe("3/4");
    expect(formatQty(0.333)).toBe("1/3");
    expect(formatQty(0.667)).toBe("2/3");
  });

  test("mixed numbers", () => {
    expect(formatQty(1.5)).toBe("1 1/2");
    expect(formatQty(2.25)).toBe("2 1/4");
    expect(formatQty(3.75)).toBe("3 3/4");
  });

  test("decimals that don't match fractions", () => {
    expect(formatQty(1.43)).toBe("1.43");
    expect(formatQty(2.17)).toBe("2.17");
  });

  test("zero or negative", () => {
    expect(formatQty(0)).toBe("");
    expect(formatQty(-1)).toBe("");
  });
});

describe("scaleQty", () => {
  test("no scaling at 1x", () => {
    expect(scaleQty("2", 1)).toBe("2");
    expect(scaleQty("1/2", 1)).toBe("1/2");
    expect(scaleQty("1-3", 1)).toBe("1-3");
  });

  test("scaling integers", () => {
    expect(scaleQty("2", 2)).toBe("4");
    expect(scaleQty("3", 0.5)).toBe("1 1/2");
    expect(scaleQty("1", 3)).toBe("3");
  });

  test("scaling decimals", () => {
    expect(scaleQty("1.5", 2)).toBe("3");
    expect(scaleQty("0.5", 2)).toBe("1");
  });

  test("scaling comma decimals", () => {
    expect(scaleQty("1,5", 2)).toBe("3");
  });

  test("scaling fractions", () => {
    expect(scaleQty("1/2", 2)).toBe("1");
    expect(scaleQty("1/4", 2)).toBe("1/2");
    expect(scaleQty("3/4", 2)).toBe("1 1/2");
  });

  test("scaling mixed fractions", () => {
    expect(scaleQty("1 1/2", 2)).toBe("3");
    expect(scaleQty("2 1/4", 2)).toBe("4 1/2");
  });

  test("hyphen ranges preserve diff", () => {
    expect(scaleQty("1-3", 2)).toBe("2-4");
    expect(scaleQty("2-4", 2)).toBe("4-6");
    expect(scaleQty("1-3", 3)).toBe("3-5");
    expect(scaleQty("1-2", 0.5)).toBe("1/2-1 1/2");
  });

  test("en-dash and em-dash ranges normalize to hyphen", () => {
    expect(scaleQty("2\u20133", 2)).toBe("4-5");
    expect(scaleQty("1\u20143", 2)).toBe("2-4");
  });

  test("word ranges: 'to' and 'or'", () => {
    expect(scaleQty("2 to 3", 2)).toBe("4 to 5");
    expect(scaleQty("1 or 2", 2)).toBe("2 or 3");
    expect(scaleQty("2 to 4", 3)).toBe("6 to 8");
  });

  test("approximate prefix preserved", () => {
    expect(scaleQty("~2", 2)).toBe("~4");
    expect(scaleQty("~1/2", 2)).toBe("~1");
    expect(scaleQty("~ 3", 0.5)).toBe("~1 1/2");
  });

  test("locked with * prefix not scaled", () => {
    expect(scaleQty("*2", 2)).toBe("2");
    expect(scaleQty("*1/2", 3)).toBe("1/2");
    expect(scaleQty("*1-3", 2)).toBe("1-3");
  });

  test("unicode vulgar fractions", () => {
    expect(scaleQty("\u00bd", 2)).toBe("1");
    expect(scaleQty("\u00bc", 4)).toBe("1");
    expect(scaleQty("1\u00bd", 2)).toBe("3");
  });

  test("non-numeric passthrough", () => {
    expect(scaleQty("a pinch", 2)).toBe("a pinch");
    expect(scaleQty("to taste", 3)).toBe("to taste");
    expect(scaleQty("", 2)).toBe("");
  });
});
