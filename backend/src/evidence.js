// The model cites identifiers; only the backend supplies the displayed transcript excerpts.
export function indexTranscript(transcript) {
  const sources = new Map();
  for (const line of transcript.split(/\r\n?|\n/)) {
    let remaining = line.trim();
    while (remaining) {
      let end = Math.min(remaining.length, 1000);
      if (remaining.length > end) {
        const boundary = remaining.lastIndexOf(" ", end);
        if (boundary > 0) {
          end = boundary;
        }
      }
      const excerpt = remaining.slice(0, end).trim();
      const id = "S" + String(sources.size + 1).padStart(6, "0");
      sources.set(id, excerpt);
      remaining = remaining.slice(end).trim();
    }
  }
  return {
    sources,
    input: [...sources].map(([id, excerpt]) => `[${id}] ${excerpt}`).join("\n"),
  };
}
