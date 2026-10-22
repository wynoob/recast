import {
  ApiSuccessSchema,
  AssetListSchema,
  ContentDetailSchema,
  ContentListSchema,
  HealthSchema,
  SettingsSchema,
  TemplateListSchema,
  type AssetList,
  type ContentDetail,
  type ContentList,
  type Health,
  type Settings,
  type TemplateList,
} from "@dmall/contracts";

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ApiClientError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
    this.details = input.details ?? {};
  }
}

export const healthQuery = {
  queryKey: ["health"] as const,
  queryFn: async (): Promise<Health> => {
    const response = await fetch("/api/v1/health", { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(HealthSchema))).data;
  },
};

export const settingsQuery = {
  queryKey: ["settings"] as const,
  queryFn: async (): Promise<Settings> => {
    const response = await fetch("/api/v1/settings", { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(SettingsSchema))).data;
  },
};

export const contentsQuery = {
  queryKey: ["contents"] as const,
  queryFn: async (): Promise<ContentList> => {
    const response = await fetch("/api/v1/contents?limit=100", { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(ContentListSchema))).data;
  },
};

export const assetsQuery = {
  queryKey: ["assets"] as const,
  queryFn: async (): Promise<AssetList> => {
    const response = await fetch("/api/v1/assets?limit=100", { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(AssetListSchema))).data;
  },
};

export const templatesQuery = {
  queryKey: ["templates"] as const,
  queryFn: async (): Promise<TemplateList> => {
    const response = await fetch("/api/v1/templates?limit=100", { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(TemplateListSchema))).data;
  },
};

export function contentQuery(id: string) {
  return {
    queryKey: ["content", id] as const,
    queryFn: async (): Promise<ContentDetail> => {
      const response = await fetch(`/api/v1/contents/${encodeURIComponent(id)}`, {
        credentials: "same-origin",
      });
      return (await parseResponse(response, ApiSuccessSchema(ContentDetailSchema))).data;
    },
  };
}

export async function parseResponse<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = raw as
      | {
          error?: {
            code?: string;
            message?: string;
            retryable?: boolean;
            details?: Record<string, unknown>;
          };
        }
      | null;
    throw new ApiClientError({
      status: response.status,
      code: parsed?.error?.code ?? "INTERNAL_ERROR",
      message: parsed?.error?.message ?? "请求失败，请稍后重试",
      retryable: parsed?.error?.retryable ?? false,
      details: parsed?.error?.details ?? {},
    });
  }
  return schema.parse(raw);
}
