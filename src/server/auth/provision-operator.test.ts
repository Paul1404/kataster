import { describe, expect, it } from "vitest";
import { validateOperatorInput } from "./provision-operator";

const demo = {
  email: "operator@example.test",
  name: "Demo Operator",
  password: "local-demo-password",
};

describe("operator provisioning input", () => {
  it("normalizes the identity without changing the password", () => {
    expect(
      validateOperatorInput({ ...demo, email: " Operator@Example.Test ", name: " Demo Operator " }),
    ).toEqual(demo);
  });
  it.each(["", "invalid", "user@example.test extra"])("rejects invalid email %s", (email) => {
    expect(() => validateOperatorInput({ ...demo, email })).toThrow("valid operator email");
  });
  it.each(["short", "a".repeat(129)])("rejects an out-of-policy password", (password) => {
    expect(() => validateOperatorInput({ ...demo, password })).toThrow("12 to 128");
  });
  it("rejects an empty name", () => {
    expect(() => validateOperatorInput({ ...demo, name: " " })).toThrow("1 to 100");
  });
});
