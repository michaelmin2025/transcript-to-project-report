export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let result;
  try {
    result = await response.json();
  }
  catch {
    throw new Error("The server returned an unreadable response. Please try again.");
  }
  if (!response.ok) {
    throw new Error(result.error?.message || "The request failed. Please try again.");
  }
  return result;
}

export async function downloadDocument(documentContent, format) {
  const response = await fetch("/api/reports/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: documentContent, format }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result.error?.message || "The document could not be downloaded. Please try again.",
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `project-report.${format}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
