import { asc, eq, isNull, sql } from "drizzle-orm";
import {
  applyOwnerSuggestions,
  loadMarginReport,
  loadReadiness,
  loadStatements,
} from "../billing/service";
import { periodOf } from "../costs/margin";
import { db } from "../db";
import { assets, checkResults } from "../db/schema/assets";
import { contractPositions, customerPricing, providerCosts } from "../db/schema/costs";
import { customers } from "../db/schema/customers";
import { incidents } from "../db/schema/incidents";
import { type McpScope, mcpAuditLog } from "../db/schema/mcp-tokens";
import { resources } from "../db/schema/resources";
import { createInvoice, listInvoices } from "../invoices/service";
import { readWorkerHeartbeat } from "../queue/heartbeat";
import { assignOwnerWithHistory } from "../resources/history";

// A small, stateless MCP (Model Context Protocol) server exposing Kataster's inventory,
// margin and monitoring over JSON-RPC so an agent can inspect and drive the app.
// Streamable-HTTP, request/response only (no SSE) -- enough for tools.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "kataster", version: "0.2.0" };

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  scope?: McpScope;
  run(args: Json): Promise<unknown>;
}

export interface McpRequestContext {
  id: string | null;
  name: string;
  scopes: McpScope[];
}

const obj = (properties: Json, required: string[] = []): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const int = (description?: string) => ({
  type: "integer",
  ...(description ? { description } : {}),
});

const TOOLS: Tool[] = [
  {
    name: "list_customers",
    description:
      "List customers (CRM records: businesses, individuals, providers, internal) with how many resources each owns.",
    inputSchema: obj({}),
    async run() {
      return db
        .select({
          id: customers.id,
          name: customers.name,
          kind: customers.kind,
          status: customers.status,
          resourceCount: sql<number>`(select count(*)::int from ${resources} where ${resources.ownerCustomerId} = ${customers}."id" and ${resources.status} = 'active')`,
        })
        .from(customers)
        .orderBy(asc(customers.name));
    },
  },
  {
    name: "list_resources",
    description:
      "List the unified cross-provider inventory (domains, DNS zones, SES identities/tenants, CloudFront, ACM certs, mailboxes, containers, Railway projects/services) with each resource's owning customer. Optional filters.",
    inputSchema: obj({
      provider: str("aws | hetzner | railway | mailcow | other"),
      type: str("e.g. mailbox, dns_zone, container, ses_tenant"),
      customerId: str("only resources owned by this customer"),
      unownedOnly: { type: "boolean", description: "only resources with no owner" },
      includeDecommissioned: {
        type: "boolean",
        description: "also list decommissioned resources (default: active only)",
      },
    }),
    async run(args) {
      const rows = await db
        .select({
          id: resources.id,
          type: resources.type,
          provider: resources.provider,
          externalId: resources.externalId,
          name: resources.name,
          status: resources.status,
          ownerCustomerId: resources.ownerCustomerId,
          ownerName: customers.name,
        })
        .from(resources)
        .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
        .orderBy(asc(resources.provider), asc(resources.type), asc(resources.name));
      return rows.filter(
        (r) =>
          (args.includeDecommissioned === true || r.status === "active") &&
          (!args.provider || r.provider === args.provider) &&
          (!args.type || r.type === args.type) &&
          (!args.customerId || r.ownerCustomerId === args.customerId) &&
          (!args.unownedOnly || r.ownerCustomerId == null),
      );
    },
  },
  {
    name: "margin_summary",
    description:
      "Per-customer cost vs charge vs margin for a period (YYYY-MM, default current month), plus totals and unallocated overhead. Charges use the recurring price (carried forward from the latest earlier period when the month has none).",
    inputSchema: obj({ period: str("YYYY-MM; defaults to the current month") }),
    async run(args) {
      return loadMarginReport(typeof args.period === "string" ? args.period : periodOf(new Date()));
    },
  },
  {
    name: "billing_readiness",
    description:
      "Pre-invoice check for a period: resources without an owner (with the cost they draw and a suggested owner), billable customers without a price, prices carried forward from older months, and cost pools nobody draws from.",
    inputSchema: obj({ period: str("YYYY-MM; defaults to the current month") }),
    async run(args) {
      return loadReadiness(typeof args.period === "string" ? args.period : periodOf(new Date()));
    },
  },
  {
    name: "customer_statements",
    description:
      "Per-customer billing statements for a period: every owned resource with the cost it drew, the revenue lines that bill (contract positions and one-off adjustments), and the margin. Optional customerId to fetch one.",
    inputSchema: obj({
      period: str("YYYY-MM; defaults to the current month"),
      customerId: str("only this customer"),
    }),
    async run(args) {
      const { period, statements } = await loadStatements(
        typeof args.period === "string" ? args.period : periodOf(new Date()),
      );
      return {
        period,
        statements: args.customerId
          ? statements.filter((s) => s.customerId === args.customerId)
          : statements,
      };
    },
  },
  {
    name: "list_incidents",
    description:
      "Open incidents (unhealthy assets) with the asset name and the latest check message.",
    inputSchema: obj({}),
    async run() {
      return db
        .select({
          assetName: assets.name,
          connectorId: assets.connectorId,
          status: incidents.status,
          startedAt: incidents.startedAt,
          message: sql<
            string | null
          >`(select message from ${checkResults} where ${checkResults.assetId} = ${incidents}."asset_id" order by ${checkResults.checkedAt} desc limit 1)`,
        })
        .from(incidents)
        .leftJoin(assets, eq(incidents.assetId, assets.id))
        .where(isNull(incidents.endedAt))
        .orderBy(asc(incidents.startedAt));
    },
  },
  {
    name: "overview",
    description:
      "High-level status: asset status counts, open incident count, resource total, and whether the worker is alive.",
    inputSchema: obj({}),
    async run() {
      const [statusCounts, openInc, resourceTotal, heartbeat] = await Promise.all([
        db
          .select({ status: assets.lastStatus, count: sql<number>`count(*)::int` })
          .from(assets)
          .groupBy(assets.lastStatus),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(incidents)
          .where(isNull(incidents.endedAt)),
        db.select({ n: sql<number>`count(*)::int` }).from(resources),
        readWorkerHeartbeat(),
      ]);
      return {
        assetStatus: Object.fromEntries(statusCounts.map((r) => [r.status, r.count])),
        openIncidents: openInc[0]?.n ?? 0,
        resources: resourceTotal[0]?.n ?? 0,
        workerAlive: heartbeat != null && Date.now() - heartbeat < 60_000,
      };
    },
  },
  {
    name: "assign_resource_owner",
    scope: "write",
    description:
      "Set (or clear, with null) the owning customer of one or more resources by their ids.",
    inputSchema: obj(
      {
        resourceIds: { type: "array", items: str(), minItems: 1 },
        customerId: { type: ["string", "null"], description: "customer id, or null to unassign" },
      },
      ["resourceIds", "customerId"],
    ),
    async run(args) {
      const ids = Array.isArray(args.resourceIds) ? (args.resourceIds as string[]) : [];
      const customerId = (args.customerId as string | null) ?? null;
      if (ids.length === 0) throw new Error("resourceIds is required");
      if (customerId) {
        const [c] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, customerId));
        if (!c) throw new Error("customer not found");
      }
      const updated = await assignOwnerWithHistory({ resourceIds: ids, customerId, actor: "mcp" });
      return { ok: true, updated };
    },
  },
  {
    name: "apply_owner_suggestions",
    scope: "write",
    description:
      "Assign suggested owners to unowned resources. Without resourceIds, applies every high-confidence suggestion (owned parent or owned domain); pass minConfidence 'medium' to include name matches.",
    inputSchema: obj({
      resourceIds: { type: "array", items: str() },
      minConfidence: str("high (default) | medium"),
    }),
    async run(args) {
      const applied = await applyOwnerSuggestions({
        resourceIds: Array.isArray(args.resourceIds) ? (args.resourceIds as string[]) : undefined,
        minConfidence: args.minConfidence === "medium" ? "medium" : "high",
        actor: "mcp",
      });
      return { ok: true, applied };
    },
  },
  {
    name: "set_customer_price",
    scope: "write",
    description:
      "Add a one-off adjustment (setup fee, credit as negative cents, correction) to what a customer is charged in one period (YYYY-MM). Recurring prices are contract positions; use upsert_contract_position for those.",
    inputSchema: obj(
      {
        customerId: str(),
        period: str("YYYY-MM"),
        amountCents: int("may be negative for a credit"),
        note: str("shown as the line label"),
      },
      ["customerId", "period", "amountCents"],
    ),
    async run(args) {
      const { customerId, period, amountCents } = args as {
        customerId: string;
        period: string;
        amountCents: number;
      };
      await db
        .insert(customerPricing)
        .values({ customerId, period, amountCents, note: (args.note as string) ?? null })
        .onConflictDoUpdate({
          target: [customerPricing.customerId, customerPricing.period],
          set: { amountCents, note: (args.note as string) ?? null },
        });
      return { ok: true };
    },
  },
  {
    name: "list_contract_positions",
    description:
      "Contract positions (what each customer buys: label, quantity, unit price in cents, interval monthly|yearly|once, start and optional end period YYYY-MM). Optional customerId.",
    inputSchema: obj({ customerId: str() }),
    async run(args) {
      const rows = await db
        .select()
        .from(contractPositions)
        .orderBy(asc(contractPositions.customerId), asc(contractPositions.label));
      return args.customerId ? rows.filter((r) => r.customerId === args.customerId) : rows;
    },
  },
  {
    name: "upsert_contract_position",
    scope: "write",
    description:
      "Create or update a contract position. Pass id to update. unitPriceCents times quantity bills every period for monthly, one twelfth per period for yearly, and only in startsPeriod for once.",
    inputSchema: obj(
      {
        id: str("existing position id to update"),
        customerId: str(),
        resourceId: str("optional resource the position covers"),
        label: str(),
        quantity: { type: "number" },
        unitPriceCents: int(),
        interval: str("monthly (default) | yearly | once"),
        startsPeriod: str("YYYY-MM"),
        endsPeriod: str("YYYY-MM, optional"),
        note: str(),
      },
      ["customerId", "label", "unitPriceCents", "startsPeriod"],
    ),
    async run(args) {
      const a = args as {
        id?: string;
        customerId: string;
        resourceId?: string;
        label: string;
        quantity?: number;
        unitPriceCents: number;
        interval?: "monthly" | "yearly" | "once";
        startsPeriod: string;
        endsPeriod?: string;
        note?: string;
      };
      const values = {
        customerId: a.customerId,
        resourceId: a.resourceId ?? null,
        label: a.label,
        quantity: a.quantity ?? 1,
        unitPriceCents: a.unitPriceCents,
        interval: a.interval ?? ("monthly" as const),
        startsPeriod: a.startsPeriod,
        endsPeriod: a.endsPeriod ?? null,
        note: a.note ?? null,
      };
      if (a.id) {
        const [row] = await db
          .update(contractPositions)
          .set(values)
          .where(eq(contractPositions.id, a.id))
          .returning();
        if (!row) throw new Error("position not found");
        return row;
      }
      const [row] = await db.insert(contractPositions).values(values).returning();
      return row;
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoice documents (number YYYY-NNNN, customer, billed period, status draft|issued|paid|void, net, VAT and gross in cents). Optional filters by period (YYYY-MM), status or customerId.",
    inputSchema: obj({
      period: str("YYYY-MM, the billed period"),
      status: str("draft | issued | paid | void"),
      customerId: str(),
    }),
    async run(args) {
      return listInvoices({
        period: typeof args.period === "string" ? args.period : undefined,
        status:
          typeof args.status === "string"
            ? (args.status as "draft" | "issued" | "paid" | "void")
            : undefined,
        customerId: typeof args.customerId === "string" ? args.customerId : undefined,
      });
    },
  },
  {
    name: "create_invoice",
    scope: "write",
    description:
      "Create a draft invoice for one customer and billed period from the contract positions and one-off adjustments that bill in it. The document is a snapshot and is never recomputed. vatRatePercent defaults to 0 (small-business rule, Paragraph 19 UStG). Fails when the customer owes nothing in the period.",
    inputSchema: obj(
      {
        customerId: str(),
        period: str("YYYY-MM"),
        vatRatePercent: int("0 (default) to 100"),
        note: str("free text printed on the document"),
      },
      ["customerId", "period"],
    ),
    async run(args) {
      const a = args as {
        customerId: string;
        period: string;
        vatRatePercent?: number;
        note?: string;
      };
      if (!/^\d{4}-\d{2}$/.test(a.period)) throw new Error("period must be YYYY-MM");
      return createInvoice({
        customerId: a.customerId,
        period: a.period,
        vatRatePercent: a.vatRatePercent,
        note: a.note ?? null,
      });
    },
  },
  {
    name: "upsert_provider_cost",
    scope: "write",
    description:
      "Record what you pay a provider for a period (a cost pool), in cents. Keyed by provider+period+label.",
    inputSchema: obj(
      {
        provider: str("aws | hetzner | railway | mailcow | other"),
        period: str("YYYY-MM"),
        label: str(),
        amountCents: int(),
      },
      ["provider", "period", "label", "amountCents"],
    ),
    async run(args) {
      const { provider, period, label, amountCents } = args as {
        provider: "aws" | "hetzner" | "railway" | "mailcow" | "other";
        period: string;
        label: string;
        amountCents: number;
      };
      await db
        .insert(providerCosts)
        .values({ provider, period, label, amountCents, source: "fixed" })
        .onConflictDoUpdate({
          target: [providerCosts.provider, providerCosts.period, providerCosts.label],
          set: { amountCents },
        });
      return { ok: true };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}
type RpcResult = { jsonrpc: "2.0"; id: string | number | null; result: unknown };
type RpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
};

/** Handle one JSON-RPC message. Returns null for notifications (no response). */
async function auditMutation(
  context: McpRequestContext,
  toolName: string,
  phase: "attempt" | "result",
  details: Json,
  success: boolean | null,
): Promise<void> {
  await db.insert(mcpAuditLog).values({
    tokenId: context.id,
    tokenName: context.name,
    toolName,
    phase,
    success,
    details,
  });
}

export async function handleMcpMessage(
  msg: RpcRequest,
  context: McpRequestContext,
): Promise<RpcResult | RpcError | null> {
  const id = msg.id ?? null;
  const method = msg.method ?? "";
  // Notifications (no id) get no response.
  if (msg.id === undefined && method.startsWith("notifications/")) return null;
  const ok = (result: unknown): RpcResult => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcError => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: TOOLS.filter((t) => !t.scope || context.scopes.includes(t.scope)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = msg.params?.name as string;
        const tool = TOOL_BY_NAME.get(name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = (msg.params?.arguments as Json) ?? {};
        if (tool.scope && !context.scopes.includes(tool.scope)) {
          return fail(-32001, `Token is missing the ${tool.scope} scope`);
        }
        try {
          if (tool.scope === "write") {
            // Fail closed. If the append-only attempt cannot be recorded, the
            // mutation is not allowed to run.
            await auditMutation(context, tool.name, "attempt", { arguments: args }, null);
          }
          const result = await tool.run(args);
          if (tool.scope === "write") {
            await auditMutation(context, tool.name, "result", { result }, true).catch((error) => {
              console.error("[mcp] result audit failed", tool.name, (error as Error)?.message);
            });
          }
          return ok({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (error) {
          if (tool.scope === "write") {
            await auditMutation(
              context,
              tool.name,
              "result",
              { error: error instanceof Error ? error.message : "tool failed" },
              false,
            ).catch(() => {});
          }
          // Tool errors are reported in-band so the model can react.
          return ok({
            content: [
              { type: "text", text: error instanceof Error ? error.message : "tool failed" },
            ],
            isError: true,
          });
        }
      }
      default:
        if (msg.id === undefined) return null; // unknown notification
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error instanceof Error ? error.message : "internal error");
  }
}
