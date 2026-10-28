import { z } from "zod";
import { MAX_FILE_BYTES, ReportEnvelopeSchema } from "./report.js";
import { DocumentSchema } from "./document.js";

export const SavedReportSchema = ReportEnvelopeSchema.extend({
  id: z.uuid(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
  document: DocumentSchema,
  uploadId: z.uuid().nullable().optional(),
});
export const ReportListSchema = z.array(
  z.object({
    id: z.uuid(),
    title: z.string().min(1).max(160),
    sourceName: z.string(),
    generatedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  }),
);
export const ReportUpdateSchema = z
  .object({
    document: DocumentSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const UploadSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  mime: z.enum(["text/plain", "application/pdf"]),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  uploadedAt: z.iso.datetime(),
});
export const UploadListSchema = z.array(UploadSchema);
