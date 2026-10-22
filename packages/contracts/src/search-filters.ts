import { z } from "zod";
import { SchemaVersionSchema } from "./ids.js";

export const SearchMediaKindSchema = z.enum(["document", "image", "gif", "video", "audio"]);
export type SearchMediaKind = z.infer<typeof SearchMediaKindSchema>;

export const SearchAvailabilitySchema = z.enum(["available", "missing", "unsupported"]);
export type SearchAvailability = z.infer<typeof SearchAvailabilitySchema>;

export const ObsoleteFilterSchema = z.enum(["exclude", "include", "only"]);
export type ObsoleteFilter = z.infer<typeof ObsoleteFilterSchema>;

export const HardFiltersSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    merchantId: z.uuid().nullable().default(null),
    dateFrom: z.iso.date().nullable().default(null),
    dateTo: z.iso.date().nullable().default(null),
    mediaKinds: z.array(SearchMediaKindSchema).default([]),
    audience: z.array(z.string().min(1).max(100)).default([]),
    functions: z.array(z.string().min(1).max(100)).default([]),
    obsolete: ObsoleteFilterSchema.default("exclude"),
    availability: z.array(SearchAvailabilitySchema).default([]),
  })
  .refine(
    (value) => value.dateFrom === null || value.dateTo === null || value.dateFrom <= value.dateTo,
    "dateFrom 不能晚于 dateTo",
  );
export type HardFilters = z.infer<typeof HardFiltersSchema>;
