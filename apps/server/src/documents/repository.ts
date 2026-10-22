import type Database from "better-sqlite3";
import { z } from "zod";
import {
  DocumentBlockViewSchema,
  DocumentSectionViewSchema,
  DocumentSnapshotViewSchema,
  LocatorSchema,
  SourceDocumentViewSchema,
  type DocumentBlockView,
  type DocumentSectionView,
  type SourceDocumentView,
} from "@dmall/contracts";
import { ApiError } from "../errors.js";

const VersionRowSchema = z.strictObject({
  source_id: z.uuid(),
  source_title: z.string(),
  fingerprint: z.string(),
  snapshot_blob_hash: z.string(),
  processor_version: z.string(),
  extraction_snapshot_json: z.string(),
});

const SectionRowSchema = z.strictObject({
  id: z.uuid(),
  ordinal: z.int().positive(),
  title: z.string(),
  heading_path: z.string(),
  text: z.string(),
  locator_json: z.string(),
  notes: z.string(),
});

const BlockRowSchema = z.strictObject({
  id: z.uuid(),
  section_id: z.uuid(),
  ordinal: z.int().positive(),
  text: z.string(),
  locator_json: z.string(),
});

export class DocumentRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getSourceDocument(sourceVersionId: string): SourceDocumentView | null {
    const raw = this.db
      .prepare(
        `SELECT sv.source_id, s.title AS source_title, sv.fingerprint,
                sv.snapshot_blob_hash, sv.processor_version, sv.extraction_snapshot_json
         FROM source_versions sv
         JOIN sources s ON s.id = sv.source_id
         WHERE sv.id = ? AND sv.extraction_snapshot_json IS NOT NULL`,
      )
      .get(sourceVersionId);
    if (raw === undefined) return null;
    const row = VersionRowSchema.parse(raw);
    const snapshot = DocumentSnapshotViewSchema.parse(
      JSON.parse(row.extraction_snapshot_json),
    );
    return SourceDocumentViewSchema.parse({
      snapshot,
      sections: this.sections(sourceVersionId),
      sourceVersionId,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      originalFileUrl: `/api/v1/files/${row.snapshot_blob_hash}`,
    });
  }

  requireSourceDocument(sourceVersionId: string): SourceDocumentView {
    const document = this.getSourceDocument(sourceVersionId);
    if (document === null) {
      throw new ApiError({
        statusCode: 404,
        code: "NOT_FOUND",
        message: "来源没有已持久化的文档结构",
      });
    }
    return document;
  }

  sections(sourceVersionId: string): DocumentSectionView[] {
    const sectionRows = z
      .array(SectionRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT id, ordinal, title, heading_path, text, locator_json, notes
             FROM document_sections
             WHERE source_version_id = ?
             ORDER BY ordinal ASC, id ASC`,
          )
          .all(sourceVersionId),
      );
    const blocksBySection = new Map<string, DocumentBlockView[]>();
    const blockRows = z
      .array(BlockRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT id, section_id, ordinal, text, locator_json
             FROM document_blocks
             WHERE source_version_id = ?
             ORDER BY section_id ASC, ordinal ASC, id ASC`,
          )
          .all(sourceVersionId),
      );
    for (const row of blockRows) {
      const block = DocumentBlockViewSchema.parse({
        id: row.id,
        ordinal: row.ordinal,
        text: row.text,
        locator: LocatorSchema.parse(JSON.parse(row.locator_json)),
      });
      const list = blocksBySection.get(row.section_id);
      if (list === undefined) blocksBySection.set(row.section_id, [block]);
      else list.push(block);
    }
    return sectionRows.map((row) =>
      DocumentSectionViewSchema.parse({
        id: row.id,
        ordinal: row.ordinal,
        title: row.title,
        headingPath: row.heading_path,
        text: row.text,
        locator: LocatorSchema.parse(JSON.parse(row.locator_json)),
        blocks: blocksBySection.get(row.id) ?? [],
        notes: row.notes,
      }),
    );
  }

  getSection(sectionId: string): DocumentSectionView | null {
    const row = z
      .strictObject({ source_version_id: z.uuid() })
      .parse(
        this.db
          .prepare("SELECT source_version_id FROM document_sections WHERE id = ?")
          .get(sectionId),
      );
    return this.sections(row.source_version_id).find((section) => section.id === sectionId) ?? null;
  }

  blocksByIds(blockIds: readonly string[]): DocumentBlockView[] {
    if (blockIds.length === 0) return [];
    const placeholders = blockIds.map(() => "?").join(", ");
    const rows = z
      .array(BlockRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT id, section_id, ordinal, text, locator_json
             FROM document_blocks WHERE id IN (${placeholders})`,
          )
          .all(...blockIds),
      );
    const byId = new Map(
      rows.map((row) => [
        row.id,
        DocumentBlockViewSchema.parse({
          id: row.id,
          ordinal: row.ordinal,
          text: row.text,
          locator: LocatorSchema.parse(JSON.parse(row.locator_json)),
        }),
      ]),
    );
    return blockIds.flatMap((id) => {
      const block = byId.get(id);
      return block === undefined ? [] : [block];
    });
  }
}
