import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSupportedTranscript,
  MAX_FILE_BYTES,
  ReportEnvelopeSchema,
  reportItems,
} from "../../shared/report.js";
import { DocumentSchema, DOWNLOAD_FORMATS, reportToDocument } from "../../shared/document.js";
import { downloadDocument, requestJson } from "./api.js";
import DocumentEditor from "./DocumentEditor.jsx";
import {
  ReportListSchema,
  SavedReportSchema,
  UploadListSchema,
} from "../../shared/saved-report.js";

function GenerationStatus() {
  return (
    <p className="processing" role="status">
      <span className="generation-spinner" aria-hidden="true" />
      Generating report…
    </p>
  );
}

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
  const [savedReports, setSavedReports] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [opening, setOpening] = useState(false);
  const [activeTab, setActiveTab] = useState("report");
  const [loadingList, setLoadingList] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const locked = busy || downloading || saving || opening || loadingList || deleting;

  const rememberReport = useCallback((record) => {
    if (!record.id) {
      return;
    }
    const summary = {
      id: record.id,
      title:
        record.document.content
          .find(node => node.type === "heading" && node.attrs.level === 1)
          ?.content?.map(node => node.text || "")
          .join("")
          .trim()
          .slice(0, 160) || record.report.title,
      sourceName: record.sourceName,
      generatedAt: record.generatedAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
    setSavedReports(current => [summary, ...current.filter(item => item.id !== record.id)]);
  }, []);

  const presentReport = useCallback(
    (result) => {
      const parsed = result.id
        ? SavedReportSchema.safeParse(result)
        : ReportEnvelopeSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error("The server returned an incomplete report. Please try again.");
      }
      setEnvelope(parsed.data);
      setInitialDocument(parsed.data.document || reportToDocument(parsed.data));
      setDocumentVersion(value => value + 1);
      setEditing(false);
      setDirty(false);
      setActiveTab("report");
      setDeleteTarget(null);
      rememberReport(parsed.data);
    },
    [rememberReport],
  );
  useEffect(() => {
    const controller = new AbortController();
    requestJson("/api/config", { signal: controller.signal })
      .then(async (result) => {
        if (result.persistence) {
          const reports = ReportListSchema.parse(
            await requestJson("/api/reports", { signal: controller.signal }),
          );
          if (controller.signal.aborted) {
            return;
          }
          setSavedReports(reports);
          if (reports.length) {
            const latest = await requestJson("/api/reports/" + reports[0].id, {
              signal: controller.signal,
            });
            if (controller.signal.aborted) {
              return;
            }
            presentReport(latest);
          }
        }
        setConfig(result);
        setConnectionError("");
      })
      .catch((failure) => {
        if (failure.name !== "AbortError") {
          setConnectionError("Cannot reach the server. Check that the app is running, then retry.");
        }
      });
    return () => controller.abort();
  }, [connectionAttempt, presentReport]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function saveCurrent() {
    if (!envelope?.id || !dirty) {
      return;
    }
    const document = DocumentSchema.safeParse(editorRef.current?.getDocument());
    if (!document.success) {
      throw new Error(
        "The document contains unsupported formatting or is too large to save. Review your edits.",
      );
    }
    setSaving(true);
    try {
      const saved = SavedReportSchema.parse(
        await requestJson("/api/reports/" + envelope.id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: document.data, version: envelope.version }),
        }),
      );
      setEnvelope(saved);
      setDirty(false);
      rememberReport(saved);
    }
    finally {
      setSaving(false);
    }
  }

  async function toggleEditing() {
    setError("");
    if (!editing) {
      setEditing(true);
      return;
    }
    try {
      await saveCurrent();
      setEditing(false);
    }
    catch (failure) {
      setError(failure.message);
    }
  }

  async function deleteReport() {
    if (!deleteTarget || locked) {
      return;
    }
    const id = deleteTarget.id;
    setDeleting(true);
    setError("");
    try {
      await requestJson("/api/reports/" + id, { method: "DELETE" });
      setSavedReports(current => current.filter(item => item.id !== id));
      if (envelope?.id === id) {
        setEnvelope(null);
        setInitialDocument(null);
        setEditing(false);
        setDirty(false);
        setLastFile(null);
      }
      setDeleteTarget(null);
    }
    catch (failure) {
      setError(failure.message);
    }
    finally {
      setDeleting(false);
    }
  }

  async function switchTab(tab) {
    if (locked || tab === activeTab) {
      return;
    }
    setError("");
    setDeleteTarget(null);
    if (tab === "report") {
      setActiveTab(tab);
      return;
    }
    setLoadingList(true);
    try {
      await saveCurrent();
      if (tab === "uploads") {
        setUploads(UploadListSchema.parse(await requestJson("/api/uploads")));
      }
      else {
        const reports = ReportListSchema.parse(await requestJson("/api/reports"));
        setSavedReports(
          reports.sort((first, second) => second.generatedAt.localeCompare(first.generatedAt)),
        );
      }
      setActiveTab(tab);
    }
    catch (failure) {
      setError(failure.message);
    }
    finally {
      setLoadingList(false);
    }
  }

  function handleTabKey(event) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.querySelectorAll("[role=\"tab\"]"));
    const current = tabs.indexOf(event.target);
    const next
      = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }

  async function openReport(id) {
    if (!id || locked) {
      return;
    }
    setOpening(true);
    setError("");
    setLastFile(null);
    try {
      await saveCurrent();
      presentReport(await requestJson("/api/reports/" + id));
    }
    catch (failure) {
      setError(failure.message);
    }
    finally {
      setOpening(false);
    }
  }

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
    const body = new FormData();
    body.append("transcript", file);
    await requestReport("/api/reports", body);
  }

  async function regenerateReport(id) {
    if (locked) {
      return;
    }
    setLastFile(null);
    await requestReport("/api/uploads/" + id + "/reports");
  }

  async function requestReport(url, body) {
    setError("");
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 395000);
    try {
      await saveCurrent();
      const result = await requestJson(url, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      presentReport(result);
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
      await saveCurrent();
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
        {config?.persistence && (
          <div className="report-tabs" role="tablist" aria-label="Reports" onKeyDown={handleTabKey}>
            <button
              type="button"
              role="tab"
              id="report-tab"
              aria-selected={activeTab === "report"}
              aria-controls="report-panel"
              tabIndex={activeTab === "report" ? 0 : -1}
              disabled={locked}
              onClick={() => switchTab("report")}
            >
              Report
            </button>
            <button
              type="button"
              role="tab"
              id="uploads-tab"
              aria-selected={activeTab === "uploads"}
              aria-controls="uploads-panel"
              tabIndex={activeTab === "uploads" ? 0 : -1}
              disabled={locked}
              onClick={() => switchTab("uploads")}
            >
              Uploads
            </button>
            <button
              type="button"
              role="tab"
              id="history-tab"
              aria-selected={activeTab === "history"}
              aria-controls="history-panel"
              tabIndex={activeTab === "history" ? 0 : -1}
              disabled={locked}
              onClick={() => switchTab("history")}
            >
              History
            </button>
          </div>
        )}
        <div
          id="report-panel"
          role={config?.persistence ? "tabpanel" : undefined}
          aria-labelledby={config?.persistence ? "report-tab" : undefined}
          hidden={activeTab !== "report"}
        >
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
            Uploaded text is sent to DeepSeek. Reports and uploaded files are saved locally on this
            computer.
          </p>
          {opening && <p role="status">Opening report…</p>}
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
          {busy && <GenerationStatus />}
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
                <span className="source-name">{"Generated report · " + envelope.sourceName}</span>
                <div className="report-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={toggleEditing}
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
                        {option.label} (.
                        {option.extension})
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
              {envelope.id && (
                <p className="save-status" role="status">
                  {saving ? "Saving…" : dirty ? "Unsaved edits" : "Saved locally"}
                </p>
              )}
              {editing && (
                <p className="editor-hint">
                  Edit the text directly. Select text to bold it or change its size.
                  {envelope.id && " Choose Done editing to save your edits."}
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
                onChange={() => setDirty(true)}
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
        </div>
        {config?.persistence && (
          <section
            id="history-panel"
            role="tabpanel"
            aria-labelledby="history-tab"
            hidden={activeTab !== "history"}
          >
            <h2>History</h2>
            {deleteTarget && (
              <div
                className="delete-confirmation"
                role="group"
                aria-label="Delete report confirmation"
              >
                <p>{"Delete \"" + deleteTarget.title + "\"? This cannot be undone."}</p>
                <div className="upload-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={deleteReport}
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => setDeleteTarget(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {opening && <p role="status">Opening report…</p>}
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            {savedReports.length
              ? (
                  <div className="history-table-wrapper">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th scope="col">Report</th>
                          <th scope="col">Transcript</th>
                          <th scope="col">Generated</th>
                          <th scope="col">Last saved</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {savedReports.map(item => (
                          <tr key={item.id}>
                            <th scope="row">
                              <button
                                className="text-button"
                                type="button"
                                disabled={locked}
                                aria-label={"Open " + item.title}
                                onClick={() => openReport(item.id)}
                              >
                                {item.title}
                              </button>
                            </th>
                            <td>{item.sourceName}</td>
                            <td>
                              <time dateTime={item.generatedAt}>
                                {new Date(item.generatedAt).toLocaleString()}
                              </time>
                            </td>
                            <td>
                              <time dateTime={item.updatedAt}>
                                {new Date(item.updatedAt).toLocaleString()}
                              </time>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="text-button"
                                aria-label={"Delete " + item.title}
                                disabled={locked}
                                onClick={() => {
                                  setError("");
                                  setDeleteTarget(item);
                                }}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              : (
                  <p>No saved reports yet.</p>
                )}
          </section>
        )}
        {config?.persistence && (
          <section
            id="uploads-panel"
            role="tabpanel"
            aria-labelledby="uploads-tab"
            hidden={activeTab !== "uploads"}
          >
            <h2>Uploads</h2>
            <p className="privacy-note">
              Regenerating a report sends the saved transcript to DeepSeek and creates a new History
              entry.
            </p>
            {busy && <GenerationStatus />}
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            {!config.configured && (
              <p className="setup-note">Add your DeepSeek key to .env to regenerate reports.</p>
            )}
            {uploads.length
              ? (
                  <div className="history-table-wrapper">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th scope="col">File</th>
                          <th scope="col">Size</th>
                          <th scope="col">Uploaded</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uploads.map(item => (
                          <tr key={item.id}>
                            <th scope="row">{item.name}</th>
                            <td>{Math.ceil(item.size / 1024) + " KB"}</td>
                            <td>
                              <time dateTime={item.uploadedAt}>
                                {new Date(item.uploadedAt).toLocaleString()}
                              </time>
                            </td>
                            <td>
                              <div className="upload-actions">
                                <button
                                  type="button"
                                  className="secondary-button"
                                  aria-label={"Regenerate report from " + item.name}
                                  disabled={locked || !config.configured}
                                  onClick={() => regenerateReport(item.id)}
                                >
                                  Regenerate report
                                </button>
                                <a
                                  className="text-button"
                                  href={"/api/uploads/" + item.id + "/file"}
                                  download={item.name}
                                >
                                  Download file
                                </a>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              : (
                  <p>No saved uploads yet.</p>
                )}
          </section>
        )}
      </main>
    </div>
  );
}
