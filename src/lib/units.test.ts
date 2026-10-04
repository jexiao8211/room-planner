import { describe, expect, it } from "vitest";
import {
  M_PER_FT,
  M_PER_IN,
  formatDims,
  formatLength,
  fromInputValue,
  inputUnitLabel,
  parseLength,
  toInputValue,
} from "./units";

const ft = (n: number) => n * M_PER_FT;
const inch = (n: number) => n * M_PER_IN;

describe("formatLength (imperial)", () => {
  it("formats whole feet with 0 inches", () => {
    expect(formatLength(ft(8), "imperial")).toBe(`8' 0"`);
    expect(formatLength(2.44, "imperial")).toBe(`8' 0"`); // 96.06 in
  });

  it("formats feet and inches", () => {
    expect(formatLength(ft(8) + inch(2), "imperial")).toBe(`8' 2"`);
    expect(formatLength(ft(12) + inch(11), "imperial")).toBe(`12' 11"`);
  });

  it("shows inches only below one foot", () => {
    expect(formatLength(inch(4), "imperial")).toBe(`4"`);
    expect(formatLength(0.1, "imperial")).toBe(`4"`); // 3.94 in
    expect(formatLength(inch(11), "imperial")).toBe(`11"`);
  });

  it("formats zero", () => {
    expect(formatLength(0, "imperial")).toBe(`0"`);
  });

  it("rounds 11.6 inches up to a whole foot instead of showing 12\"", () => {
    expect(formatLength(inch(11.6), "imperial")).toBe(`1' 0"`);
    expect(formatLength(0.3, "imperial")).toBe(`1' 0"`); // 11.81 in
    expect(formatLength(ft(11) + inch(11.6), "imperial")).toBe(`12' 0"`);
    expect(formatLength(ft(5) + inch(11.5), "imperial")).toBe(`6' 0"`);
  });

  it("never renders 12 inches in the inches slot", () => {
    for (let i = 0; i < 2000; i++) {
      const s = formatLength(i * 0.00317, "imperial");
      expect(s).not.toMatch(/(^|\s)12"/);
    }
  });

  it("rounds 0.4 inch down", () => {
    expect(formatLength(ft(3) + inch(0.4), "imperial")).toBe(`3' 0"`);
  });

  it("formats negative lengths with a leading minus sign", () => {
    expect(formatLength(-ft(1), "imperial")).toBe(`-1' 0"`);
    expect(formatLength(-(ft(2) + inch(3)), "imperial")).toBe(`-2' 3"`);
    expect(formatLength(-inch(5), "imperial")).toBe(`-5"`);
    // Rounds to zero → no "-0"
    expect(formatLength(-0.001, "imperial")).toBe(`0"`);
  });

  it("returns an em dash for non-finite values", () => {
    expect(formatLength(NaN, "imperial")).toBe("—");
    expect(formatLength(Infinity, "imperial")).toBe("—");
    expect(formatLength(-Infinity, "metric")).toBe("—");
  });
});

describe("formatLength (metric)", () => {
  it("uses meters with two decimals at or above 1 m", () => {
    expect(formatLength(2.44, "metric")).toBe("2.44 m");
    expect(formatLength(1, "metric")).toBe("1.00 m");
    expect(formatLength(3.666, "metric")).toBe("3.67 m");
  });

  it("uses whole centimeters below 1 m", () => {
    expect(formatLength(0.5, "metric")).toBe("50 cm");
    expect(formatLength(0.124, "metric")).toBe("12 cm");
    expect(formatLength(0.004, "metric")).toBe("0 cm");
    expect(formatLength(0, "metric")).toBe("0 cm");
  });

  it("does not show 100 cm for values that round up to a meter", () => {
    expect(formatLength(0.996, "metric")).toBe("1.00 m");
  });

  it("formats negative lengths", () => {
    expect(formatLength(-0.5, "metric")).toBe("-50 cm");
    expect(formatLength(-2, "metric")).toBe("-2.00 m");
    expect(formatLength(-0.001, "metric")).toBe("0 cm");
  });
});

describe("formatDims", () => {
  it("formats W × D × H in order", () => {
    expect(formatDims({ w: ft(2), d: ft(1), h: ft(3) }, "imperial")).toBe(`2' 0" W × 1' 0" D × 3' 0" H`);
    expect(formatDims({ w: 1.2, d: 0.6, h: 0.75 }, "metric")).toBe("1.20 m W × 60 cm D × 75 cm H");
  });
});

describe("input value helpers", () => {
  it("converts to inches / centimeters with one decimal", () => {
    expect(toInputValue(ft(8), "imperial")).toBe(96);
    expect(toInputValue(0.5, "imperial")).toBe(19.7);
    expect(toInputValue(2.44, "metric")).toBe(244);
    expect(toInputValue(0.1234, "metric")).toBe(12.3);
  });

  it("converts back to meters", () => {
    expect(fromInputValue(96, "imperial")).toBeCloseTo(2.4384, 10);
    expect(fromInputValue(244, "metric")).toBeCloseTo(2.44, 10);
  });

  it("round-trips within display precision", () => {
    for (const m of [0.05, 0.4, 1.6, 2.44, 3.66]) {
      expect(fromInputValue(toInputValue(m, "imperial"), "imperial")).toBeCloseTo(m, 2);
      expect(fromInputValue(toInputValue(m, "metric"), "metric")).toBeCloseTo(m, 3);
    }
  });

  it("labels the input unit", () => {
    expect(inputUnitLabel("imperial")).toBe("in");
    expect(inputUnitLabel("metric")).toBe("cm");
  });
});

describe("parseLength", () => {
  const cases: Array<[string, number]> = [
    ["8'", ft(8)],
    ["8 '", ft(8)],
    ["8ft", ft(8)],
    ["8 ft", ft(8)],
    ["8 feet", ft(8)],
    ["1 foot", ft(1)],
    ["8 ft 2 in", ft(8) + inch(2)],
    ["8ft2in", ft(8) + inch(2)],
    [`8' 2"`, ft(8) + inch(2)],
    [`8'2"`, ft(8) + inch(2)],
    ["8' 2", ft(8) + inch(2)],
    ["6 feet 2.5 inches", ft(6) + inch(2.5)],
    ["5.5 ft", ft(5.5)],
    [`96"`, inch(96)],
    [`96 "`, inch(96)],
    ["96 in", inch(96)],
    ["96in", inch(96)],
    ["1 inch", inch(1)],
    ["30 inches", inch(30)],
    ["2.4m", 2.4],
    ["2.4 m", 2.4],
    ["2 meters", 2],
    ["1 meter", 1],
    ["1.5 metres", 1.5],
    ["240 cm", 2.4],
    ["240cm", 2.4],
    ["2400mm", 2.4],
    ["2400 mm", 2.4],
    ["0", 0],
  ];
  for (const [text, meters] of cases) {
    it(`parses ${JSON.stringify(text)}`, () => {
      const imp = parseLength(text, "imperial");
      const met = parseLength(text, "metric");
      expect(imp).not.toBeNull();
      expect(imp!).toBeCloseTo(meters, 9);
      // An explicit unit wins over the default unit system.
      expect(met!).toBeCloseTo(meters, 9);
    });
  }

  it("is case- and whitespace-insensitive", () => {
    expect(parseLength("  96 IN  ", "metric")!).toBeCloseTo(inch(96), 9);
    expect(parseLength("8   FT   2   IN", "metric")!).toBeCloseTo(ft(8) + inch(2), 9);
    expect(parseLength("2.4 M", "imperial")!).toBeCloseTo(2.4, 9);
    expect(parseLength("\t240\tcm\n", "imperial")!).toBeCloseTo(2.4, 9);
  });

  it("treats a bare number as inches in imperial", () => {
    expect(parseLength("96", "imperial")!).toBeCloseTo(inch(96), 9);
    expect(parseLength("12.5", "imperial")!).toBeCloseTo(inch(12.5), 9);
  });

  it("without context, reads a small bare number as meters and a large one as centimeters in metric", () => {
    expect(parseLength("240", "metric")!).toBeCloseTo(2.4, 9);
    expect(parseLength("12.5", "metric")!).toBeCloseTo(0.125, 9);
    expect(parseLength("2.4", "metric")!).toBeCloseTo(2.4, 9);
  });

  it("in metric, reads a bare number in the unit the field currently shows", () => {
    // Field shows "1.22 m": "1.25" means 1.25 m (it used to become 1.25 cm), but "120" is still 120 cm.
    expect(parseLength("1.25", "metric", 1.22)!).toBeCloseTo(1.25, 9);
    expect(parseLength("3", "metric", 3.66)!).toBeCloseTo(3, 9);
    expect(parseLength("2.5", "metric", 3.66)!).toBeCloseTo(2.5, 9);
    expect(parseLength("120", "metric", 1.22)!).toBeCloseTo(1.2, 9);
    // Field shows "45 cm": "60" is 60 cm, a decimal like "0.6" is meters.
    expect(parseLength("60", "metric", 0.45)!).toBeCloseTo(0.6, 9);
    expect(parseLength("0.6", "metric", 0.45)!).toBeCloseTo(0.6, 9);
    // A negative displayed value (positions) uses its magnitude; explicit units always win.
    expect(parseLength("1.2", "metric", -1.5)!).toBeCloseTo(1.2, 9);
    expect(parseLength("1.25 cm", "metric", 1.22)!).toBeCloseTo(0.0125, 9);
    // Imperial is unaffected: a bare number is inches.
    expect(parseLength("48", "imperial", 1.22)!).toBeCloseTo(inch(48), 9);
  });

  const garbage = ["", "   ", "abc", "ft", "m", "8 yards", "8 ft abc", "8 ft 2 cm", "-3", "-3 m", "1,5 m", "2.4.1 m", "8' 2' ", "two meters", "m 2"];
  for (const text of garbage) {
    it(`returns null for ${JSON.stringify(text)}`, () => {
      expect(parseLength(text, "imperial")).toBeNull();
      expect(parseLength(text, "metric")).toBeNull();
    });
  }
});
