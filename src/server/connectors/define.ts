import type { GenericSchema } from "valibot";
import type { Connector } from "./types";

/** Identity helper that preserves config/secret schema inference when authoring. */
export function defineConnector<
  TConfig extends GenericSchema,
  TSecret extends GenericSchema | undefined = undefined,
>(connector: Connector<TConfig, TSecret>): Connector<TConfig, TSecret> {
  return connector;
}
