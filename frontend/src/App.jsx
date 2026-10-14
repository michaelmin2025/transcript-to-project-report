import { useEffect, useRef, useState } from "react";
import {
  isSupportedTranscript,
  MAX_FILE_BYTES,
  ReportEnvelopeSchema,
  reportItems,
} from "../../shared/report.js";
import { DocumentSchema, DOWNLOAD_FORMATS, reportToDocument } from "../../shared/document.js";
import { downloadDocument, requestJson } from "./api.js";
import DocumentEditor from "./DocumentEditor.jsx";

export default function App() {
  const [config, setConfig] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [envelope, setEnvelope] = useState(null);
  const [initialDocument, setInitialDocument] = useState(null);
  const editorRef = useRef(null);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [lastFile, setLastFile] = useState(null);
  const [editing, setEditing] = useState(false);
  const [format, setFormat] = useState("docx");
  const controllerRef = useRef(null);
  const locked = busy || downloading;
  useEffect(() => {
    const controller = new AbortController();
    requestJson("/api/config", { signal: controller.signal })
      .then((result) => {
        setConfig(result);
        setConnectionError("");
      })
      .catch((failure) => {
        if (failure.name !== "AbortError") {
          setConnectionError("Cannot reach the server. Check that the app is running, then retry.");
        }
      });
    return () => controller.abort();
  }, [connectionAttempt]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function loadReport(file) {
    if (locked) {
      return;
    }
    setError("");
    setLastFile(null);
    if (file) {
      if (!isSupportedTranscript(file.name)) {
        setError("Only .txt and .pdf transcript files are supported.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError("The transcript must be 1 MB or smaller.");
        return;
      }
      if (!file.size) {
        setError("The transcript is empty.");
        return;
      }
      setLastFile(file);
    }
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 155000);
    try {
      const body = new FormData();
      body.append("transcript", file);
      const result = await requestJson("/api/reports", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const parsed = ReportEnvelopeSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error("The server returned an incomplete report. Please try again.");
      }
      const nextDocument = reportToDocument(parsed.data);
      setEnvelope(parsed.data);
      setInitialDocument(nextDocument);
      setDocumentVersion(value => value + 1);
      setEditing(false);
    }
    catch (failure) {
      setError(
        failure.name === "AbortError"
          ? "Report generation took too long. Please try again."
          : failure.message,
      );
    }
    finally {
      clearTimeout(timeout);
      setBusy(false);
      controllerRef.current = null;
    }
  }

  async function download() {
    setError("");
    const parsed = DocumentSchema.safeParse(editorRef.current?.getDocument());
    if (!parsed.success) {
      setError(
        "The document is empty, too large, or contains unsupported formatting. Review your edits before downloading.",
      );
      return;
    }
    setDownloading(true);
    try {
      await downloadDocument(parsed.data, format);
    }
    catch (failure) {
      setError(failure.message);
    }
    finally {
      setDownloading(false);
    }
  }

  const excerpts = envelope
    ? [...new Set(reportItems(envelope.report).flatMap(item => item.sources))]
    : [];
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Transcript to Project Report</h1>
      </header>
      <main>
        <section className="upload-panel" aria-label="Transcript upload">
          <label
            className={
              "primary-button upload-button " + (locked || !config?.configured ? "disabled" : "")
            }
          >
            Upload transcript
            <input
              type="file"
              aria-label="Upload transcript"
              accept=".txt,.pdf,text/plain,application/pdf"
              disabled={locked || !config?.configured}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  loadReport(file);
                }
              }}
            />
          </label>
          <span className="file-limit">.txt or text-based .pdf · Up to 1 MB</span>
        </section>
        <p className="privacy-note">
          Uploaded text is sent to DeepSeek. Reports are temporary and may be lost on refresh.
        </p>
        {config && !config.configured && (
          <p className="setup-note">Add your DeepSeek key to .env to enable uploads.</p>
        )}
        {connectionError && (
          <div className="alert" role="alert">
            {connectionError}
            <button
              type="button"
              className="text-button"
              onClick={() => setConnectionAttempt(value => value + 1)}
            >
              Retry connection
            </button>
          </div>
        )}
        {busy && (
          <p className="processing" role="status">
            Generating report…
          </p>
        )}
        {error && (
          <div className="alert" role="alert">
            {error}
            {lastFile && !locked && (
              <button type="button" className="text-button" onClick={() => loadReport(lastFile)}>
                Retry upload
              </button>
            )}
          </div>
        )}
        {!envelope && !busy && (
          <div className="empty-state">
            <h2>Your report will appear here</h2>
            <p>Upload a transcript to generate your report.</p>
          </div>
        )}
        {envelope && (
          <section className="report-workspace" aria-label="Project report">
            <div className="report-toolbar">
              <span className="source-name">
                {"Generated report · " + envelope.sourceName}
              </span>
              <div className="report-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => setEditing(value => !value)}
                >
                  {editing ? "Done editing" : "Edit report"}
                </button>
                <select
                  aria-label="Download format"
                  value={format}
                  disabled={locked}
                  onChange={event => setFormat(event.target.value)}
                >
                  {Object.entries(DOWNLOAD_FORMATS).map(([value, option]) => (
                    <option value={value} key={value}>
                      {option.label}
                      {" "}
                      (.
                      {option.extension}
                      )
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="primary-button"
                  disabled={locked}
                  onClick={download}
                >
                  {downloading ? "Downloading…" : "Download " + DOWNLOAD_FORMATS[format].label}
                </button>
              </div>
            </div>
            {editing && (
              <p className="editor-hint">
                Edit the text directly. Select text to bold it or change its size.
              </p>
            )}
            {format === "md" && (
              <p className="editor-hint">
                Markdown saves text sizes as HTML spans; support varies by Markdown viewer.
              </p>
            )}
            <DocumentEditor
              key={documentVersion}
              initialDocument={initialDocument}
              editing={editing}
              disabled={locked}
              ref={editorRef}
            />
            <details className="supporting-excerpts">
              <summary>Supporting excerpts</summary>
              <p>Original transcript excerpts. Review edited claims against the source.</p>
              {envelope.report.notes.length > 0 && (
                <div>
                  <p>
                    <strong>Review notes</strong>
                  </p>
                  {envelope.report.notes.map((note, index) => (
                    <p key={index}>{note}</p>
                  ))}
                </div>
              )}
              {excerpts.length
                ? (
                    excerpts.map((excerpt, index) => <blockquote key={index}>{excerpt}</blockquote>)
                  )
                : (
                    <p>Not specified</p>
                  )}
            </details>
          </section>
        )}
      </main>
    </div>
  );
}
