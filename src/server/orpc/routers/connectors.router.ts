import { listConnectors } from "../../connectors/registry";
import { schemaToFields } from "../../connectors/schema-to-fields";
import { authed } from "../base";

// Exposes registry metadata + serialized field descriptors to the UI. No Valibot
// schema and no secret value ever crosses the wire.
export const connectorsRouter = {
  list: authed.handler(() => {
    return listConnectors().map((connector) => ({
      id: connector.id,
      name: connector.name,
      description: connector.description,
      icon: connector.icon,
      kind: connector.kind,
      capabilities: connector.capabilities,
      configFields: schemaToFields(connector.configSchema),
      secretFields: connector.secretSchema
        ? schemaToFields(connector.secretSchema, { secret: true })
        : [],
      setup: connector.setup ?? null,
      defaultIntervalSeconds: connector.defaultIntervalSeconds ?? 60,
    }));
  }),
};
