import { z } from "zod";

export const NOT_SPECIFIED = "Not specified";
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_CHARACTERS = 120000;
export const MAX_PDF_PAGES = 100;

export function isSupportedTranscript(name) {
  return /\.(txt|pdf)$/i.test(name);
}

export const STATUSES = ["Not specified", "Not started", "In progress", "Blocked", "Completed"];
export const COMMITMENTS = ["Not specified", "Agreed", "Proposed"];

const text = z.string().max(4000);
const source = z.string().min(1).max(1200);
const evidence = {
  sources: z.array(source).max(8),
  uncertainty: text,
};
const summary = z
  .array(
    z
      .object({
        text: z
          .string()
          .trim()
          .min(1)
          .max(1200)
          .refine(value => !/[\r\n]/.test(value), "Use one paragraph per summary item."),
        ...evidence,
        sources: z.array(source).max(40),
      })
      .strict(),
  )
  .min(1)
  .max(2)
  .refine(
    paragraphs =>
      paragraphs.reduce((count, paragraph) => count + paragraph.text.split(/\s+/).length, 0) <= 200,
    "Keep the executive summary to 200 words or fewer.",
  )
  .describe(
    "One or two short narrative paragraphs summarizing key transcript information, at most 200 words total.",
  );

export const ReportSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    executiveSummary: summary,
    tasks: z
      .array(
        z
          .object({
            description: text,
            owner: text,
            status: z.enum(STATUSES),
            commitment: z.enum(COMMITMENTS),
            date: text,
            dependency: text,
            ...evidence,
          })
          .strict(),
      )
      .max(50),
    milestones: z
      .array(
        z
          .object({
            description: text,
            date: text,
            status: z.enum(STATUSES),
            commitment: z.enum(COMMITMENTS),
            ...evidence,
          })
          .strict(),
      )
      .max(40),
    timeline: z
      .array(z.object({ description: text, date: text, dependency: text, ...evidence }).strict())
      .max(50),
    projectScope: z
      .object({
        overview: z
          .array(
            z
              .object({
                text: z.string().trim().min(1).max(1600),
                ...evidence,
                sources: z.array(source).max(40),
              })
              .strict(),
          )
          .max(3)
          .describe(
            "Up to three short paragraphs explaining the project purpose, included work, and stated boundaries in that order. Empty only when no project or initiative is described.",
          ),
      })
      .strict(),
    notes: z.array(text).max(30),
  })
  .strict();

export const ReportEnvelopeSchema = z.object({
  report: ReportSchema,
  sourceName: z.string(),
  generatedAt: z.string(),
});

export function reportItems(report) {
  return [
    ...report.executiveSummary,
    ...report.tasks,
    ...report.milestones,
    ...report.timeline,
    ...report.projectScope.overview,
  ];
}

export function displayText(value) {
  return typeof value === "string" && value.trim() ? value : NOT_SPECIFIED;
}

export function blankClaim() {
  return { text: "", sources: [], uncertainty: "" };
}
