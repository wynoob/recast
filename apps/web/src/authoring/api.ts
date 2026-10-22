import { z } from "zod";
import {
  ApiSuccessSchema,
  JobSnapshotSchema,
  ProviderConfigInputSchema,
  ProviderConfigViewSchema,
  type JobSnapshot,
  type ProviderConfigInput,
  type ProviderConfigView,
} from "@dmall/contracts";
import { parseResponse } from "../api.js";

const ProviderListSchema = z.strictObject({ items: z.array(ProviderConfigViewSchema) });

export function providersQuery() {
  return {
    queryKey: ["authoring", "providers"] as const,
    queryFn: async (): Promise<ProviderConfigView[]> => {
      const response = await fetch("/api/v1/settings/providers", { credentials: "same-origin" });
      return (await parseResponse(response, ApiSuccessSchema(ProviderListSchema))).data.items;
    },
  };
}

export async function saveProviderConfig(input: {
  csrfToken: string;
  request: ProviderConfigInput;
}): Promise<ProviderConfigView> {
  const result = await write(
    "PUT",
    "/api/v1/settings/providers",
    input.csrfToken,
    ProviderConfigInputSchema.parse(input.request),
    z.strictObject({ item: ProviderConfigViewSchema }),
  );
  return result.item;
}

export async function probeTextProvider(input: {
  csrfToken: string;
}): Promise<JobSnapshot> {
  return write(
    "POST",
    "/api/v1/settings/providers/text/probe",
    input.csrfToken,
    { schemaVersion: 1, role: "text" },
    JobSnapshotSchema,
  );
}

async function write<T>(
  method: "POST" | "PUT" | "PATCH",
  url: string,
  csrfToken: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return (await parseResponse(response, ApiSuccessSchema(schema))).data;
}
