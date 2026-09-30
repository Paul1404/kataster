import { describe, expect, it } from "vitest";
import { assignEdgeOffsets, type LabelInput, placeLabels, quadraticArc } from "./edge-geometry";

describe("quadraticArc", () => {
  it("returns the straight segment when offset is 0", () => {
    expect(quadraticArc([0, 0], [10, 10], 0)).toEqual([
      [0, 0],
      [10, 10],
    ]);
  });

  it("starts at a, ends at b, and bows away from the chord", () => {
    const arc = quadraticArc([0, 0], [0, 10], 0.2, 10);
    expect(arc).toHaveLength(11);
    expect(arc[0]).toEqual([0, 0]);
    expect(arc[arc.length - 1]).toEqual([0, 10]);
    // Horizontal chord (lng axis) → midpoint should be displaced off the lat=0 line.
    const mid = arc[5]!;
    expect(Math.abs(mid[0])).toBeGreaterThan(0.1);
  });
});

describe("assignEdgeOffsets", () => {
  it("gives a single edge the default gentle bow", () => {
    const offsets = assignEdgeOffsets([{ id: "e1", from: "a", to: "b" }]);
    expect(offsets.get("e1")).toBeCloseTo(0.14);
  });

  it("fans duplicate edges between the same pair to distinct offsets", () => {
    const offsets = assignEdgeOffsets([
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "a", to: "b" },
      { id: "e3", from: "a", to: "b" },
    ]);
    const values = [offsets.get("e1"), offsets.get("e2"), offsets.get("e3")];
    expect(new Set(values).size).toBe(3);
    // Symmetric spread around the base bow.
    expect(values[1]).toBeCloseTo(0.14);
  });

  it("groups by unordered pair so A→B and B→A share a group", () => {
    const offsets = assignEdgeOffsets([
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "a" },
    ]);
    expect(offsets.get("e1")).not.toBeCloseTo(offsets.get("e2")!);
  });
});

describe("placeLabels", () => {
  const viewport = { width: 1000, height: 1000 };

  it("places a lone label visibly to the right of its dot", () => {
    const input: LabelInput[] = [{ id: "a", x: 100, y: 100, width: 80, height: 24, priority: 50 }];
    const [a] = placeLabels(input, viewport);
    expect(a!.visible).toBe(true);
    expect(a!.anchor).toBe("right");
  });

  it("hides the lower-priority label when two would overlap with no free slot", () => {
    // Tight viewport so only the "right" slot fits; both dots sit at the same point,
    // so the higher-priority label takes it and the other has nowhere to go.
    const tight = { width: 200, height: 30 };
    const inputs: LabelInput[] = [
      { id: "low", x: 10, y: 15, width: 150, height: 24, priority: 10 },
      { id: "high", x: 10, y: 15, width: 150, height: 24, priority: 999 },
    ];
    const placed = placeLabels(inputs, tight);
    const high = placed.find((p) => p.id === "high")!;
    const low = placed.find((p) => p.id === "low")!;
    expect(high.visible).toBe(true);
    expect(low.visible).toBe(false);
  });

  it("keeps a forced (selected/hovered) label visible even when it cannot find a slot", () => {
    const tight = { width: 200, height: 30 };
    const inputs: LabelInput[] = [
      { id: "winner", x: 10, y: 15, width: 150, height: 24, priority: 999 },
      { id: "forced", x: 10, y: 15, width: 150, height: 24, priority: 1 },
    ];
    const placed = placeLabels(inputs, tight, new Set(["forced"]));
    expect(placed.find((p) => p.id === "forced")!.visible).toBe(true);
  });
});
