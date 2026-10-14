import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { blockFontSize, documentBlocks, runStyle } from "../../shared/document.js";

const require = createRequire(import.meta.url);
const normalFont = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff");
const boldFont = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff");

export async function exportWord(document) {
  const children = documentBlocks(document).map(
    node =>
      new Paragraph({
        ...(node.type === "heading"
          ? {
              heading: {
                1: HeadingLevel.TITLE,
                2: HeadingLevel.HEADING_1,
                3: HeadingLevel.HEADING_2,
              }[node.attrs.level],
              keepNext: true,
            }
          : {}),
        ...(node.bullet ? { bullet: { level: 0 } } : {}),
        ...(node.listContinuation ? { indent: { left: 720 } } : {}),
        ...(node.keepNext ? { keepNext: true } : {}),
        spacing: {
          before: node.type === "heading" ? 240 : node.ownerSpacing ? 120 : 0,
          after: node.bullet || node.listContinuation || node.ownerHeading ? 0 : 140,
        },
        children: (node.content || []).map((run) => {
          const style = runStyle(run, node);
          return new TextRun({
            ...(run.type === "hardBreak" ? { break: 1 } : { text: run.text }),
            bold: style.bold,
            size: Math.round(style.size * 2),
            font: "Noto Sans",
          });
        }),
      }),
  );
  return Packer.toBuffer(
    new Document({
      creator: "Transcript to Project Report",
      styles: { default: { document: { run: { font: "Noto Sans", size: 24 } } } },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
            },
          },
          children,
        },
      ],
    }),
  );
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdown(value) {
  return value.replace(/[\\\x60*_{}[\]<>#|]/g, "\\$&");
}

export function exportMarkdown(document) {
  return (
    documentBlocks(document)
      .map((node) => {
        const body = (node.content || [])
          .map((run) => {
            if (run.type === "hardBreak") {
              return "  \n";
            }
            const isBold = run.marks?.some(mark => mark.type === "bold");
            const fontSize = run.marks?.find(mark => mark.type === "textStyle")?.attrs.fontSize;
            if (fontSize) {
              const text = escapeHtml(run.text).replace(/\n/g, "<br />");
              return (
                "<span style=\"font-size:"
                + fontSize
                + "\">"
                + (isBold ? "<strong>" + text + "</strong>" : text)
                + "</span>"
              );
            }
            const text = escapeMarkdown(run.text);
            if (!isBold || !text.trim()) {
              return text;
            }
            return text.match(/^\s*/)[0] + "**" + text.trim() + "**" + text.match(/\s*$/)[0];
          })
          .join("");
        const prefix
          = node.type === "heading"
            ? "#".repeat(node.attrs.level) + " "
            : node.bullet
              ? "- "
              : node.listContinuation
                ? "  "
                : "";
        return prefix + (node.bullet || node.listContinuation ? body.replace(/\n/g, "\n  ") : body);
      })
      .reduce(
        (result, body, index, bodies) =>
          result
          + (index
            ? bodies[index - 1].startsWith("- ") && body.startsWith("- ")
              ? "\n"
              : "\n\n"
            : "")
          + body,
        "",
      ) + "\n"
  );
}

export function exportPdf(document) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "LETTER",
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
      compress: true,
      info: { Creator: "Transcript to Project Report" },
    });
    const chunks = [];
    pdf.on("data", chunk => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      pdf.registerFont("regular", normalFont);
      pdf.registerFont("bold", boldFont);
      for (const node of documentBlocks(document)) {
        const runs = node.content || [];
        if (!runs.length) {
          pdf.moveDown(0.5);
          continue;
        }
        const isHeading = node.type === "heading";
        const maxSize = Math.max(
          blockFontSize(node),
          ...runs.map(run => runStyle(run, node).size),
        );
        if (
          (isHeading || node.keepNext)
          && pdf.y + maxSize * 2 + 36 > pdf.page.height - pdf.page.margins.bottom
        ) {
          pdf.addPage();
        }
        if (isHeading && pdf.y > pdf.page.margins.top) {
          pdf.y += 10;
        }
        if (node.ownerSpacing && pdf.y > pdf.page.margins.top) {
          pdf.y += 8;
        }
        const indent = node.bullet || node.listContinuation ? 36 : 0;
        if (node.bullet) {
          if (pdf.y + maxSize * 1.5 > pdf.page.height - pdf.page.margins.bottom) {
            pdf.addPage();
          }
          const y = pdf.y;
          pdf
            .font("regular")
            .fontSize(runStyle(runs[0], node).size)
            .text("•", 72, y, { lineBreak: false });
          pdf.y = y;
        }
        pdf.x = 54 + indent;
        // End the PDF text wrapper at explicit line breaks so mixed sizes reset to the left margin.
        const lines = [[]];
        for (const run of runs) {
          if (run.type === "hardBreak") {
            lines.push([]);
            continue;
          }
          const parts = run.text.split("\n");
          parts.forEach((part, index) => {
            if (index) {
              lines.push([]);
            }
            if (part) {
              lines.at(-1).push({ ...run, text: part });
            }
          });
        }
        for (const line of lines) {
          if (!line.length) {
            pdf.fontSize(blockFontSize(node)).moveDown(1);
            continue;
          }
          line.forEach((run, index) => {
            const style = runStyle(run, node);
            pdf.font(style.bold ? "bold" : "regular").fontSize(style.size);
            pdf.text(run.text, {
              width: 504 - indent,
              lineGap: node.bullet || node.listContinuation ? 2 : 4,
              continued: index < line.length - 1,
            });
          });
        }
        pdf.y += node.ownerHeading
          ? 0
          : isHeading
            ? 8
            : node.bullet || node.listContinuation
              ? 2
              : 6;
      }
      pdf.end();
    }
    catch (error) {
      pdf.destroy();
      reject(error);
    }
  });
}

export async function exportDocument(document, format) {
  if (format === "md") {
    return exportMarkdown(document);
  }
  if (format === "pdf") {
    return exportPdf(document);
  }
  return exportWord(document);
}
