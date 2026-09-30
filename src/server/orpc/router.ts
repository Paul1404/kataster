import { assetsRouter } from "./routers/assets.router";
import { billingRouter } from "./routers/billing.router";
import { checksRouter } from "./routers/checks.router";
import { connectionsRouter } from "./routers/connections.router";
import { connectorsRouter } from "./routers/connectors.router";
import { contractsRouter } from "./routers/contracts.router";
import { costsRouter } from "./routers/costs.router";
import { customersRouter } from "./routers/customers.router";
import { dashboardRouter } from "./routers/dashboard.router";
import { domainsRouter } from "./routers/domains.router";
import { incidentsRouter } from "./routers/incidents.router";
import { invoicesRouter } from "./routers/invoices.router";
import { mailRouter } from "./routers/mail.router";
import { maintenanceRouter } from "./routers/maintenance.router";
import { mcpRouter } from "./routers/mcp.router";
import { notificationsRouter } from "./routers/notifications.router";
import { relationsRouter } from "./routers/relations.router";
import { resourcesRouter } from "./routers/resources.router";
import { searchRouter } from "./routers/search.router";

export const router = {
  assets: assetsRouter,
  billing: billingRouter,
  checks: checksRouter,
  connectors: connectorsRouter,
  connections: connectionsRouter,
  contracts: contractsRouter,
  costs: costsRouter,
  dashboard: dashboardRouter,
  domains: domainsRouter,
  incidents: incidentsRouter,
  invoices: invoicesRouter,
  customers: customersRouter,
  mail: mailRouter,
  maintenance: maintenanceRouter,
  mcp: mcpRouter,
  notifications: notificationsRouter,
  relations: relationsRouter,
  resources: resourcesRouter,
  search: searchRouter,
};

export type AppRouter = typeof router;
