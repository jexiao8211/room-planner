import { describe, expect, it } from "vitest";
import { inferSearchFilters, withInferredFilters } from "./queryFilters";

describe("inferSearchFilters", () => {
  it("reads a budget written in words", () => {
    expect(inferSearchFilters("hanging lamp for the corner, Japanese, under $200").maxPrice).toBe(200);
    expect(inferSearchFilters("rug below 1,250 dollars").maxPrice).toBe(1250);
    expect(inferSearchFilters("desk less than $99.50").maxPrice).toBe(99.5);
    expect(inferSearchFilters("sofa max $1.5k").maxPrice).toBe(1500);
    expect(inferSearchFilters("lamp up to 80").maxPrice).toBe(80);
    expect(inferSearchFilters("60 inch wide desk").maxPrice).toBeUndefined();
  });

  it("reads the mount from the wording", () => {
    expect(inferSearchFilters("hanging lamp for the corner").mount).toBe("ceiling");
    expect(inferSearchFilters("paper pendant").mount).toBe("ceiling");
    expect(inferSearchFilters("brass wall sconce").mount).toBe("wall");
    expect(inferSearchFilters("woven wall hanging").mount).toBe("wall");
    expect(inferSearchFilters("mid-century nightstand").mount).toBeUndefined();
  });

  it("reads 'in the corner' as a placement", () => {
    expect(inferSearchFilters("I want to add a hanging lamp in the corner, Japanese, under $200")).toEqual({
      maxPrice: 200,
      mount: "ceiling",
      placement: "corner",
    });
    expect(inferSearchFilters("corner shelf").placement).toBe("corner");
    expect(inferSearchFilters("paper pendant").placement).toBeUndefined();
  });

  it("only fills fields the request leaves empty", () => {
    expect(withInferredFilters({ query: "pendant under $200" })).toMatchObject({ maxPrice: 200, mount: "ceiling" });
    expect(withInferredFilters({ query: "pendant under $200", maxPrice: 50, mount: "floor" as const })).toMatchObject({ maxPrice: 50, mount: "floor" });
  });
});
