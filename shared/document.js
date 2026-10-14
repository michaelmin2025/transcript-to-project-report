import { z } from "zod";
import { displayText } from "./report.js";

export const FONT_SIZES = [10, 11, 12, 14, 16, 18, 24, 32, 40, 48];
export const DOWNLOAD_FORMATS = {
  docx: {
    label: "Word",
    extension: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  md: { label: "Markdown", extension: "md", mime: "text/markdown; charset=utf-8" },
  pdf: { label: "PDF", extension: "pdf", mime: "application/pdf" },
};

export function fontSizePoints(value, fallback = 12) {
  const match = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(value || "");
  return match ? Number(match[1]) * (match[2] === "px" ? 0.75 : 1) : fallback;
}

const size = z
  .string()
  .max(20)
  .refine(
    value =>
      /^(\d+(?:\.\d+)?)(pt|px)$/.test(value)
      && fontSizePoints(value) >= 6
      && fontSizePoints(value) <= 72,
  );
const marks = z
  .array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("bold") }).strict(),
      z
        .object({
          type: z.literal("textStyle"),
          attrs: z.object({ fontSize: size.nullable().optional() }).strict(),
        })
        .strict(),
    ]),
  )
  .max(2)
  .optional();
const inline = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(120000), marks }).strict(),
  z.object({ type: z.literal("hardBreak"), marks }).strict(),
]);
const content = z.array(inline).max(5000).optional();
const paragraphNode = z.object({ type: z.literal("paragraph"), content }).strict();
const bulletListNode = z
  .object({
    type: z.literal("bulletList"),
    content: z
      .array(
        z
          .object({ type: z.literal("listItem"), content: z.array(paragraphNode).min(1).max(20) })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
const block = z.discriminatedUnion("type", [
  paragraphNode,
  bulletListNode,
  z
    .object({
      type: z.literal("heading"),
      attrs: z.object({ level: z.number().int().min(1).max(3) }).strict(),
      content,
    })
    .strict(),
]);
export const DocumentSchema = z
  .object({ type: z.literal("doc"), content: z.array(block).min(1).max(1500) })
  .strict()
  .superRefine((document, context) => {
    const text = documentText(document);
    if (!text.trim()) {
      context.addIssue({ code: "custom", message: "The document is empty." });
    }
    if (text.length > 200000) {
      context.addIssue({ code: "custom", message: "The document is too long." });
    }
  });
export const DocumentExportSchema = z
  .object({ document: DocumentSchema, format: z.enum(["docx", "md", "pdf"]) })
  .strict();

export function documentText(document) {
  return documentBlocks(document)
    .map(node =>
      (node.content || []).map(run => (run.type === "hardBreak" ? "\n" : run.text)).join(""),
    )
    .join("\n");
}

export function documentBlocks(document) {
  return document.content.flatMap((node, index) => {
    if (node.type === "bulletList") {
      return node.content.flatMap(item =>
        item.content.map((paragraph, paragraphIndex) => ({
          ...paragraph,
          bullet: paragraphIndex === 0,
          listContinuation: paragraphIndex > 0,
        })),
      );
    }
    return [
      {
        ...node,
        keepNext: document.content[index + 1]?.type === "bulletList",
        ownerHeading: document.content[index + 1]?.type === "bulletList",
        ownerSpacing: document.content[index - 1]?.type === "bulletList",
      },
    ];
  });
}

export function blockFontSize(node) {
  return node.type === "heading" ? { 1: 24, 2: 16, 3: 13 }[node.attrs.level] : 12;
}

export function runStyle(run, node) {
  const explicitSize = run.marks?.find(mark => mark.type === "textStyle")?.attrs.fontSize;
  return {
    bold: node.type === "heading" || Boolean(run.marks?.some(mark => mark.type === "bold")),
    size: fontSizePoints(explicitSize, blockFontSize(node)),
  };
}

export function reportToDocument({ report, sourceName }) {
  const content = [];

  const text = (value, bold = false) => ({
    type: "text",
    text: displayText(value),
    ...(bold ? { marks: [{ type: "bold" }] } : {}),
  });

  const paragraph = (...runs) => content.push({ type: "paragraph", content: runs });

  const heading = (value, level = 2) =>
    content.push({ type: "heading", attrs: { level }, content: [text(value)] });

  const labeled = (label, value) => paragraph(text(label + ": ", true), text(value));

  const uncertainty = (item) => {
    if (item.uncertainty.trim()) {
      labeled("Uncertainty", item.uncertainty);
    }
  };

  heading(report.title, 1);
  labeled("Source", sourceName);
  heading("Executive summary");
  for (const item of report.executiveSummary) {
    paragraph(text(item.text));
  }
  heading("Action Items");
  content.at(-1).content[0].marks = [{ type: "textStyle", attrs: { fontSize: "12pt" } }];
  if (!report.tasks.length) {
    paragraph(text(""));
  }
  const owners = new Map();
  for (const task of report.tasks) {
    const owner = displayText(task.owner).trim();
    if (!owners.has(owner)) {
      owners.set(owner, []);
    }
    owners.get(owner).push(task);
  }
  for (const [owner, tasks] of owners) {
    paragraph(text(owner, true));
    content.push({
      type: "bulletList",
      content: tasks.map((task) => {
        const details = [];
        if (task.status !== "Not specified") {
          details.push(task.status);
        }
        if (task.date.trim() && task.date !== "Not specified") {
          details.push("due " + task.date);
        }
        if (task.commitment === "Proposed") {
          details.push("Proposed, not approved");
        }
        if (task.dependency.trim() && task.dependency !== "Not specified") {
          details.push("dependency: " + task.dependency);
        }
        if (task.uncertainty.trim()) {
          details.push(task.uncertainty);
        }
        return {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                text(
                  displayText(task.description)
                  + (details.length ? " (" + details.join("; ") + ")" : ""),
                ),
              ],
            },
          ],
        };
      }),
    });
  }
  heading("Milestones");
  if (!report.milestones.length) {
    paragraph(text(""));
  }
  report.milestones.forEach((item, index) => {
    paragraph(text(index + 1 + ". " + displayText(item.description), true));
    paragraph(
      text("Target date: ", true),
      text(item.date),
      text(" | Status: ", true),
      text(item.status),
      text(" | Commitment: ", true),
      text(item.commitment),
    );
    uncertainty(item);
  });
  heading("Timeline");
  if (!report.timeline.length) {
    paragraph(text(""));
  }
  report.timeline.forEach((item) => {
    paragraph(text(displayText(item.date) + " - ", true), text(item.description));
    labeled("Dependency", item.dependency);
    uncertainty(item);
  });
  heading("Project scope");
  if (!report.projectScope.overview.length) {
    paragraph(text(""));
  }
  for (const item of report.projectScope.overview) {
    paragraph(text(item.text));
  }
  return { type: "doc", content };
}
