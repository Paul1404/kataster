import { describe, expect, it } from "vitest";
import { handleMcpMessage } from "./server";

const readOnly = { id: "token-1", name: "reader", scopes: ["read" as const] };

describe("MCP scopes", () => {
  it("does not advertise write tools to read-only tokens", async () => {
    const response = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      readOnly,
    );
    const result = response && "result" in response ? response.result : null;
    const names = (result as { tools: { name: string }[] }).tools.map((tool) => tool.name);

    expect(names).toContain("overview");
    expect(names).toContain("list_invoices");
    expect(names).not.toContain("set_customer_price");
    expect(names).not.toContain("assign_resource_owner");
    expect(names).not.toContain("create_invoice");
  });

  it("rejects direct calls to write tools before any mutation runs", async () => {
    const response = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "set_customer_price", arguments: {} },
      },
      readOnly,
    );

    expect(response).toMatchObject({ error: { code: -32001 } });
  });
});
