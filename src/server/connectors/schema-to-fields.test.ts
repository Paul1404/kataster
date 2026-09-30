import { describe, expect, it } from "vitest";
import { httpConnector } from "./http/http.connector";
import { schemaToFields } from "./schema-to-fields";

describe("schemaToFields", () => {
  const fields = schemaToFields(httpConnector.configSchema);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  it("derives a field per config entry", () => {
    expect(fields.map((f) => f.key).sort()).toEqual(
      [
        "checkCertificate",
        "degradedAboveMs",
        "expectedStatus",
        "followRedirects",
        "method",
        "timeoutMs",
      ].sort(),
    );
  });

  it("maps picklist to a select with options", () => {
    expect(byKey.method?.type).toBe("select");
    expect(byKey.method?.options).toEqual([
      { label: "GET", value: "GET" },
      { label: "HEAD", value: "HEAD" },
    ]);
  });

  it("maps number and boolean types", () => {
    expect(byKey.timeoutMs?.type).toBe("number");
    expect(byKey.followRedirects?.type).toBe("boolean");
  });

  it("uses titles for labels and carries defaults", () => {
    expect(byKey.expectedStatus?.label).toBe("Erwarteter Statuscode");
    expect(byKey.expectedStatus?.default).toBe(200);
    expect(byKey.method?.default).toBe("GET");
  });

  it("marks all fields optional (they have defaults) and not secret", () => {
    expect(fields.every((f) => f.required === false)).toBe(true);
    expect(fields.every((f) => f.secret === false)).toBe(true);
  });

  it("flags secret when requested", () => {
    const secretFields = schemaToFields(httpConnector.configSchema, { secret: true });
    expect(secretFields.every((f) => f.secret === true)).toBe(true);
  });
});
