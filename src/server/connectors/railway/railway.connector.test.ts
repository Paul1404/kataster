import { describe, expect, it } from "vitest";
import { parseRailwayProjects, priceRailwayUsage } from "./railway.connector";

describe("parseRailwayProjects", () => {
  it("pulls projects and services out of the GraphQL response", () => {
    const data = {
      data: {
        projects: {
          edges: [
            {
              node: {
                id: "p1",
                name: "svufo",
                services: { edges: [{ node: { id: "s1", name: "web" } }] },
              },
            },
            { node: { id: "p2", name: "kontor2", services: { edges: [] } } },
          ],
        },
      },
    };
    const projects = parseRailwayProjects(data);
    expect(projects).toHaveLength(2);
    expect(projects[0]).toEqual({
      id: "p1",
      name: "svufo",
      services: [{ id: "s1", name: "web" }],
    });
    expect(projects[1]!.services).toEqual([]);
  });

  it("returns [] for an error or empty response", () => {
    expect(parseRailwayProjects({ errors: [{ message: "unauthorized" }] })).toEqual([]);
    expect(parseRailwayProjects(null)).toEqual([]);
    expect(parseRailwayProjects({})).toEqual([]);
  });
});

describe("priceRailwayUsage", () => {
  it("sums each project's measurements at the published rate into cents", () => {
    const rows = [
      { projectId: "a", measurement: "MEMORY_USAGE_GB", estimatedValue: 10000 }, // *0.000231 = $2.31
      { projectId: "a", measurement: "CPU_USAGE", estimatedValue: 1000 }, // *0.000463 = $0.463
      { projectId: "a", measurement: "NETWORK_TX_GB", estimatedValue: 2 }, // *0.05 = $0.10
      { projectId: "b", measurement: "DISK_USAGE_GB", estimatedValue: 100000 }, // *0.000003472.. = $0.347
    ];
    const out = priceRailwayUsage(rows);
    const byId = new Map(out.map((r) => [r.projectId, r.amountCents]));
    // a: 2.31 + 0.463 + 0.10 = 2.873 -> 287 cents
    expect(byId.get("a")).toBe(287);
    // b: 0.3472 -> 35 cents
    expect(byId.get("b")).toBe(35);
  });

  it("ignores unknown or non-finite measurements", () => {
    const rows = [
      { projectId: "a", measurement: "CPU_LIMIT", estimatedValue: 999999 }, // not billed
      { projectId: "a", measurement: "MEMORY_USAGE_GB", estimatedValue: Number.NaN },
      { projectId: "a", measurement: "NETWORK_TX_GB", estimatedValue: 1 }, // $0.05
    ];
    expect(priceRailwayUsage(rows)).toEqual([{ projectId: "a", amountCents: 5 }]);
  });
});
