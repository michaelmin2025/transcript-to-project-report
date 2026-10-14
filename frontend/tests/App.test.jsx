import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.jsx";
import { SAMPLE_REPORT } from "../../backend/tests/fixtures/report.js";

const envelope = () => ({
  report: structuredClone(SAMPLE_REPORT),
  sourceName: "meeting.txt",
  generatedAt: "2026-10-12T15:00:00.000Z",
});

const config = (configured = true) => ({
  provider: "DeepSeek",
  configured,
  model: "deepseek-flash",
  maxFileBytes: 1048576,
  maxTranscriptCharacters: 120000,
});

const json = (value, ok = true) => ({ ok, json: async () => value });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async url => (url === "/api/config" ? json(config()) : json(envelope()))),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function uploadTranscript(user, name = "meeting.txt") {
  await waitFor(() => expect(screen.getByLabelText("Upload transcript").disabled).toBe(false));
  await user.upload(
    screen.getByLabelText("Upload transcript"),
    new File(["Meeting text"], name, { type: "text/plain" }),
  );
}

describe("prototype report flow", () => {
  it("previews one document and exports the edited, bold, resized text in every format", async () => {
    const user = userEvent.setup();
    const exported = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/config") {
        return json(config());
      }
      if (url === "/api/reports/export") {
        exported.push(JSON.parse(options.body));
        return { ok: true, blob: async () => new Blob(["word-data"]) };
      }
      return json(envelope());
    });
    const createObjectURL = vi.fn(() => "blob:test-document");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<App />);
    await uploadTranscript(user);
    expect(await screen.findByRole("heading", { name: "Customer portal pilot" })).toBeTruthy();
    for (const name of [
      "Executive summary",
      "Action Items",
      "Milestones",
      "Timeline",
      "Project scope",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("navigation", { name: "Report sections" })).toBeNull();
    const editable = screen.getByRole("textbox", { name: "Report document" });
    const previewParagraphs = Array.from(editable.children);
    const summaryIndex = previewParagraphs.findIndex(
      node => node.textContent === "Executive summary",
    );
    const tasksIndex = previewParagraphs.findIndex(node => node.textContent === "Action Items");
    expect(
      previewParagraphs.slice(summaryIndex + 1, tasksIndex).map(node => node.textContent),
    ).toEqual(SAMPLE_REPORT.executiveSummary.map(item => item.text));
    expect(editable.getAttribute("contenteditable")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Edit report" }));
    expect(editable.getAttribute("contenteditable")).toBe("true");
    const editor = editable.editor;
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Edited phrase" }],
      });
      let position;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "Edited phrase") {
          position = pos;
        }
      });
      editor.commands.setTextSelection({ from: position, to: position + "Edited phrase".length });
    });
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");
    await user.selectOptions(screen.getByRole("combobox", { name: "Text size" }), "18");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.click(screen.getByRole("button", { name: "Redo" }));
    await user.click(screen.getByRole("button", { name: "Done editing" }));
    expect(editable.getAttribute("contenteditable")).toBe("false");
    for (const [format, label] of [
      ["docx", "Word"],
      ["md", "Markdown"],
      ["pdf", "PDF"],
    ]) {
      await user.selectOptions(screen.getByRole("combobox", { name: "Download format" }), format);
      await user.click(screen.getByRole("button", { name: "Download " + label }));
      await waitFor(() => expect(exported.at(-1)?.format).toBe(format));
      expect(exported.at(-1).document.content.at(-1).content[0]).toEqual({
        type: "text",
        text: "Edited phrase",
        marks: expect.arrayContaining([
          { type: "bold" },
          { type: "textStyle", attrs: { fontSize: "18pt" } },
        ]),
      });
    }
    expect(createObjectURL).toHaveBeenCalledTimes(3);
  });

  it("uploads a selected transcript automatically and displays a generated report", async () => {
    const user = userEvent.setup();
    let uploaded;
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/config") {
        return json(config());
      }
      uploaded = options.body;
      return json({ ...envelope(), sourceName: "meeting.txt" });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Upload transcript").disabled).toBe(false));
    await user.upload(
      screen.getByLabelText("Upload transcript"),
      new File(["Alex: The invoice API is complete."], "meeting.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText(/Generated report · meeting.txt/)).toBeTruthy();
    expect(uploaded.get("transcript").name).toBe("meeting.txt");
  });

  it("shows upload errors and supports retrying the same file", async () => {
    const user = userEvent.setup();
    let calls = 0;
    fetch.mockImplementation(async (url) => {
      if (url === "/api/config") {
        return json(config());
      }
      calls += 1;
      return calls === 1
        ? json({ error: { message: "DeepSeek is busy. Please try again." } }, false)
        : json(envelope());
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Upload transcript").disabled).toBe(false));
    await user.upload(
      screen.getByLabelText("Upload transcript"),
      new File(["Meeting text"], "meeting.txt", { type: "text/plain" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("DeepSeek is busy"),
    );
    await user.click(screen.getByRole("button", { name: "Retry upload" }));
    expect(await screen.findByRole("heading", { name: "Customer portal pilot" })).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("rejects an unsupported file before sending it to the server", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Upload transcript").disabled).toBe(false));
    const callsBefore = fetch.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Upload transcript"), {
      target: { files: [new File(["docx"], "meeting.docx")] },
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Only .txt and .pdf"),
    );
    expect(fetch.mock.calls.length).toBe(callsBefore);
  });

  it("requires a configured provider and offers no sample report", async () => {
    fetch.mockImplementation(async () => json(config(false)));
    render(<App />);
    expect(await screen.findByText(/Add your DeepSeek key/)).toBeTruthy();
    expect(screen.getByLabelText("Upload transcript").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Try sample report" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Download format" })).toBeNull();
  });

  it("accepts a PDF selection and uploads it through the same report flow", async () => {
    const user = userEvent.setup();
    let uploaded;
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/config") {
        return json(config());
      }
      uploaded = options.body;
      return json({ ...envelope(), sourceName: "meeting.pdf" });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Upload transcript").disabled).toBe(false));
    expect(screen.getByLabelText("Upload transcript").accept).toContain("application/pdf");
    await user.upload(
      screen.getByLabelText("Upload transcript"),
      new File(["%PDF-1.7"], "meeting.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByText(/Generated report · meeting.pdf/)).toBeTruthy();
    expect(uploaded.get("transcript").name).toBe("meeting.pdf");
  });

  it("shows editable owner-grouped Action Items and exports the modified bullet", async () => {
    const user = userEvent.setup();
    let exported;
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/config") {
        return json(config());
      }
      if (url === "/api/reports/export") {
        exported = JSON.parse(options.body);
        return { ok: true, blob: async () => new Blob(["word-data"]) };
      }
      return json(envelope());
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:action-items",
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<App />);
    await uploadTranscript(user);
    expect(await screen.findByRole("heading", { name: "Action Items" })).toBeTruthy();
    const editable = screen.getByRole("textbox", { name: "Report document" });
    expect(editable.querySelectorAll("ul").length).toBe(4);
    expect(editable.querySelector("ul").querySelectorAll("li").length).toBe(3);
    await user.click(screen.getByRole("button", { name: "Edit report" }));
    act(() => {
      const editor = editable.editor;
      let selection;
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text.startsWith("Complete the invoice API")) {
          selection = { from: position, to: position + node.text.length };
        }
      });
      editor.commands.setTextSelection(selection);
      editor.commands.insertContent("Edited action");
    });
    await user.click(screen.getByRole("button", { name: "Download Word" }));
    await waitFor(() => expect(exported).toBeTruthy());
    expect(
      exported.document.content.find(node => node.type === "bulletList").content[0].content[0]
        .content[0].text,
    ).toBe("Edited action");
  });
  it("downloads the latest generated report and edits after replacing an earlier report", async () => {
    const user = userEvent.setup();
    const exported = [];
    let generations = 0;
    fetch.mockImplementation(async (url, options) => {
      if (url === "/api/config") {
        return json(config());
      }
      if (url === "/api/reports/export") {
        exported.push(JSON.parse(options.body));
        return { ok: true, blob: async () => new Blob(["report-data"]) };
      }
      expect(url).toBe("/api/reports");
      const result = envelope();
      result.report.title
        = ++generations === 1 ? "First generated project" : "Second generated project";
      result.report.executiveSummary[0].text
        = generations === 1 ? "First project information" : "Second project information";
      result.report.milestones = [];
      result.sourceName = options.body.get("transcript").name;
      return json(result);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:generated",
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<App />);
    await uploadTranscript(user, "first.txt");
    expect(await screen.findByRole("heading", { name: "First generated project" })).toBeTruthy();
    await uploadTranscript(user, "second.txt");
    expect(await screen.findByRole("heading", { name: "Second generated project" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit report" }));
    const editor = screen.getByRole("textbox", { name: "Report document" }).editor;
    act(() =>
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Latest user edit" }],
      }),
    );
    for (const [format, label] of [
      ["docx", "Word"],
      ["md", "Markdown"],
      ["pdf", "PDF"],
    ]) {
      await user.selectOptions(screen.getByRole("combobox", { name: "Download format" }), format);
      await user.click(screen.getByRole("button", { name: "Download " + label }));
      await waitFor(() => expect(exported.at(-1)?.format).toBe(format));
      const content = JSON.stringify(exported.at(-1).document);
      expect(content).toContain("Second generated project");
      expect(content).toContain("second.txt");
      expect(content).toContain("Latest user edit");
      expect(content).not.toContain("First generated project");
      expect(content).not.toContain("Customer portal pilot");
      expect(content).toContain("Second project information");
      expect(content).not.toContain("First project information");
    }
  });
});
