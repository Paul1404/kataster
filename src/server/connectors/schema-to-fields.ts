import type { GenericSchema } from "valibot";

export type FieldType = "string" | "number" | "boolean" | "select" | "url";

export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  secret: boolean;
  default?: unknown;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
}

// Valibot schemas are inspected structurally. We avoid importing valibot's
// internal types and treat nodes as loose records.
type Node = Record<string, any>;

const OPTIONAL_WRAPPERS = new Set(["optional", "exact_optional", "nullish", "undefinedable"]);

/** Strip optional/nullish wrappers; collect required flag and default value. */
function unwrap(schema: Node): { inner: Node; required: boolean; def: unknown } {
  let inner = schema;
  let required = true;
  let def: unknown;
  while (inner && typeof inner.type === "string") {
    if (OPTIONAL_WRAPPERS.has(inner.type)) {
      required = false;
      if (inner.default !== undefined) {
        def = typeof inner.default === "function" ? inner.default() : inner.default;
      }
      inner = inner.wrapped;
      continue;
    }
    if (inner.type === "nullable" || inner.type === "nullish") {
      // nullable keeps requiredness; nullish already handled above
      inner = inner.wrapped;
      continue;
    }
    break;
  }
  return { inner, required, def };
}

/** Pull title/description/url hints out of a piped schema. */
function readMeta(schema: Node): { title?: string; description?: string; isUrl: boolean } {
  let title: string | undefined;
  let description: string | undefined;
  let isUrl = false;
  const pipe = Array.isArray(schema.pipe) ? schema.pipe : [];
  for (const item of pipe) {
    if (item?.type === "title") title = item.title;
    else if (item?.type === "description") description = item.description;
    else if (item?.type === "url") isUrl = true;
  }
  return { title, description, isUrl };
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldTypeOf(
  inner: Node,
  isUrl: boolean,
): { type: FieldType; options?: FieldDescriptor["options"] } {
  switch (inner.type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "picklist":
    case "enum": {
      const raw: unknown[] = inner.options ?? Object.values(inner.enum ?? {});
      return {
        type: "select",
        options: raw.map((v) => ({ label: String(v), value: String(v) })),
      };
    }
    default:
      return { type: isUrl ? "url" : "string" };
  }
}

/**
 * Convert a Valibot object schema into serializable field descriptors that the
 * UI can render as a form. Pass { secret: true } for credential schemas.
 */
export function schemaToFields(
  schema: GenericSchema,
  opts: { secret?: boolean } = {},
): FieldDescriptor[] {
  const entries = (schema as Node).entries as Record<string, Node> | undefined;
  if (!entries) return [];

  const fields: FieldDescriptor[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    const { inner, required, def } = unwrap(raw);
    const meta = readMeta(raw.type && raw.pipe ? raw : inner);
    const { type, options } = fieldTypeOf(inner, meta.isUrl);
    fields.push({
      key,
      label: meta.title ?? humanize(key),
      type,
      required,
      secret: opts.secret ?? false,
      ...(def !== undefined ? { default: def } : {}),
      ...(options ? { options } : {}),
      ...(meta.description ? { placeholder: meta.description } : {}),
    });
  }
  return fields;
}
