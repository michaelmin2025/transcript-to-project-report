# Transcript to Project Report

A local React and Node.js prototype: upload a meeting transcript, generate one project report with DeepSeek, preview and edit the document, and download Word, Markdown, or PDF.

## Run locally

Requires Node.js 24 or newer. Run these commands from the project root:

```powershell
npm install
npm run dev
```

Open the **Local** URL printed in the terminal. The frontend starts at port 5173 and automatically tries the next available port if it is occupied. Frontend changes refresh automatically; backend and shared-code changes restart the API automatically. No build is needed while developing. Stop both processes with Ctrl+C. Restart `npm run dev` manually after changing `.env`.

The API uses `PORT` and `HOST` from `.env` (or your terminal environment); the frontend forwards API requests to that address. Stop any other copy of this app using the same API port before running development mode.

For the built version:

```powershell
npm run build
npm start
```

Open <http://localhost:8080> (or the `PORT` you configured). One Node.js process serves the built frontend and API. This mode requires rebuilding and restarting after changes.

The local `.env` file starts with an empty API key. Uploaded transcripts require a DeepSeek API key and an account with API credit.

Add your key to `.env` locally, then restart the app:

```dotenv
DEEPSEEK_API_KEY=your-key-here
DEEPSEEK_MODEL=deepseek-flash
PORT=8080
HOST=127.0.0.1
```

For a fresh clone, first copy `.env.example` to `.env`. Never commit `.env`; it is ignored by Git and excluded from the Docker build. The API key is never sent to the browser. `deepseek-flash` is the default; change `DEEPSEEK_MODEL` to another model supported by your DeepSeek account if needed. See the [DeepSeek model documentation](https://api-docs.deepseek.com/quick_start/pricing/).

If port 8080 is occupied, choose another `PORT` in `.env` and open that port. Stop the app with Ctrl+C in its terminal.

## Use the prototype

1. With a key configured, choose **Upload transcript** and select a `.txt` or text-based `.pdf` file. Generation begins automatically.
2. Preview one complete document containing the executive summary, Action Items, milestones, timeline, and project scope. Action Items are grouped under bold owner names with bullet lists, matching the Fusion Migration reference layout. Known dates, status, dependencies, and uncertainty appear in parentheses; proposed work is marked as unapproved. The executive summary is one or two short narrative paragraphs, at most 200 words total, covering the key information from the transcript.
3. Choose **Edit report** and edit directly in the document. Select text to apply bold or change the text size. Undo and redo are available. Choose **Done editing** to preview the result.
4. Select Word, Markdown, or PDF and download. Every format uses the current document, including your edits. Word and PDF preserve bold and text sizes; Markdown uses standard headings and bold plus HTML spans for explicit text sizes, whose display varies by viewer.

Project scope is an organized description of what the project is, using up to three short paragraphs: purpose and intended result, included work, and stated boundaries. Brief transcripts get brief descriptions. Interviews are summarized only when they describe a project or initiative; missing scope is shown as **Not specified**.

Supporting excerpts and review notes are available in a collapsed panel below the document. They reflect the original extraction and are not automatically rewritten to match edits. They are not added to the five-section document or its exports.

Each generated report is saved automatically in a local SQLite database. The app reopens the most recently saved report after refresh or restart. Use the **History** tab to view every saved generated report, its source filename, generation time, and last-saved time. Select a report title to reopen it in the **Report** tab without another AI call. Edits are saved when you choose **Done editing**, download, upload another transcript, open another saved report, or visit History; finish editing before refreshing. Uploaded transcript text is sent to DeepSeek. Routine server logs do not include transcript or report contents.

Choose **Delete** beside a report in History and confirm to permanently remove it. Deleting a report leaves its uploaded source file and other reports intact.

Use the **Uploads** tab to download an original file or choose **Regenerate report**. Regeneration uses the saved file, makes a new DeepSeek request, and saves a separate report in History without replacing earlier reports. It requires a configured API key and uses API credit.

## Local storage

Reports are stored in `backend/data/reports.sqlite`, using Node.js's built-in SQLite support. Each entry keeps the original generated report, source filename, timestamps, and latest editable document JSON. Word, Markdown, and PDF are generated on demand, so there is no need to store three duplicate exported files.

The data folder is excluded from Git and Docker build inputs. Set `REPORTS_DB_PATH` in your local environment to use another location. The database contains report content, supporting excerpts, and original uploaded .txt or .pdf files (stored as SQLite BLOBs). Valid uploads are retained even when AI generation fails. Invalid files are rejected before saving. Previously generated reports and files from before their respective persistence features cannot be recovered automatically. Re-upload older files to add them to Uploads.

This is local persistence, not an off-device backup or edit-version archive. To back it up simply, stop the app and copy `reports.sqlite` to another location. Object storage can be added later to archive exported files on a hosted service.

## Limits and generation

- One UTF-8 `.txt` file or text-based `.pdf` per report, at most 1 MB and 120,000 extracted characters. PDFs may contain up to 100 pages. Text is extracted locally on the backend before being sent to DeepSeek; the PDF file itself is not sent to the provider. Empty, binary, invalid UTF-8, corrupt, password-protected, and oversized files are rejected. Scanned PDFs without selectable text need OCR first; OCR is not included.
- Missing information is shown as **Not specified**. Relative dates are preserved unless the transcript provides an explicit anchor. Suggestions are marked separately from agreed work.
- The backend numbers transcript passages and asks DeepSeek to cite those identifiers in its JSON report. The backend resolves references to the original excerpts, validates the shared schema, and rejects unknown references or unsupported quotes. This avoids failures caused by the model reproducing quotes with changed punctuation or PDF formatting. These checks do not prove semantic accuracy: review the claims before sharing.
- Report generation uses thinking mode with high reasoning effort and a 64,000-token output budget. This works with both `deepseek-flash` and `deepseek-v4-pro`; change `DEEPSEEK_MODEL` in `.env` to choose the model. The budget is a maximum, not a fixed token charge.
- There is one automatic retry for transient provider failures, timeouts, malformed responses, and invalid excerpts. Each attempt has a 180-second timeout. The browser allows 395 seconds for extraction, both attempts, and overhead. Authentication and account-credit failures are not retried.
- A maximum of three concurrent generations is allowed. Uploads use bounded memory storage, with no temporary transcript files written to disk.

## Project layout

```text
frontend/        React interface and frontend tests
backend/         Node.js API, generation, document exports, and API tests
shared/          Report and document schemas used by both sides
_docs/           Original build plan
```

Dependencies and project commands are managed by one root `package.json` and lockfile.

```powershell
npm run check    # Lint and formatting checks, without modifying files
npm run dev      # Frontend refresh and automatic backend restart
npm test         # One-shot API, provider, export, and frontend tests
npm run build    # Build the frontend
npm run format   # Apply the shared formatting style when requested
```

JavaScript and JSX use ESLint Stylistic for two-space indentation, consistent spacing, double quotes, semicolons, multiline conditional blocks, and a blank line between function definitions (including arrow functions and class methods). Put `else` and `else if` on the line after the closing brace. Prettier formats JSON, CSS, HTML, and Markdown. Run `npm run format` to apply the style and `npm run check` to enforce it.

GitHub Actions runs checks, tests, and the build. The tests use mocked DeepSeek responses and synthetic transcripts; they do not make paid API calls. The backend tests use short-lived test listeners, not a development server.

## Monitoring

Set `APP_TELEMETRY_PATH` at runtime to enable optional content-free telemetry.
The lab uses `/app/backend/data/telemetry.json` in its existing data volume.
The file contains cumulative success/failure/cancellation/rejection counters and
a timestamp, written atomically with private permissions. `/health` refreshes
the snapshot so a collector can detect stale or unwritable telemetry. No new
HTTP endpoint exposes these counters.

Generation logs contain only a fixed event name and outcome. They exclude file
names, transcripts, reports, API keys, and provider error messages. Input
validation failures and client cancellation are separate from generation failures.
Telemetry I/O errors do not fail report requests. Monitoring is disabled unless
the path is configured. Single-process writes are required for the shared file.

The separate Terraform repository provides a one-shot collector that probes the
ALB health URL and reads this snapshot with a read-only data mount. It does not
need the DeepSeek key. Build/restart and scheduling remain operator-controlled.

## API

- `GET /health` — process health
- `GET /api/config` — provider readiness and upload limits; no secrets
- `GET /api/uploads` — saved file metadata
- `GET /api/uploads/:id/file` — download the original uploaded file
- `POST /api/uploads/:id/reports` — generate and save a new report from a saved file
- `GET /api/reports` — saved report titles and metadata
- `GET /api/reports/:id` — original report and current editable document
- `DELETE /api/reports/:id` — permanently delete one report; keeps its upload
- `PUT /api/reports/:id` — save edits as `{ document, version }`; stale versions return a conflict
- `POST /api/reports` — multipart upload with one file named `transcript`; generated results are saved automatically
- `POST /api/reports/export` — export the current editor JSON as `{ document, format }`, where `format` is `docx`, `md`, or `pdf`. The backend validates document nodes, marks, text sizes, and size limits; raw HTML is not accepted.

## Container

The Dockerfile packages the built frontend and backend into one image, listens on port 8080, and exposes `/health`. Runtime credentials are supplied through environment variables:

```powershell
docker build -t transcript-to-project-report .
docker run --rm -p 8080:8080 -v report-data:/app/backend/data --env-file .env -e HOST=0.0.0.0 transcript-to-project-report
```

MiniStack/Terraform deployment is a later step. The prototype has no authentication and is intended for local use or a controlled lab.

## Single-user deployment access

The server now requires APP_AUTH_USERNAME, APP_AUTH_PASSWORD_HASH and
APP_AUTH_ORIGIN at startup and refuses to start if they are missing or invalid.
Use the private configuration helper and rollout instructions in the sibling
ministack-terraform repository: docs/TRANSCRIPT_AUTH.md. Existing local .env files
also need these settings before npm run dev or npm start will run the backend.
APP_AUTH_ORIGIN is the browser's exact scheme/host/port, with no trailing slash;
for Vite development this is the actual frontend URL, not the backend port.

The built app uses a browser HTTP Basic sign-in prompt. All content and API
routes require the single owner's credentials except GET/HEAD /health. Passwords
are stored as a random salt and scrypt hash, never plaintext. Browsers cache
Basic credentials; use a private window and close all private windows when done.
Keep lab access through the SSH tunnel and establish real HTTPS before broader
exposure. The Vite development UI itself is not protected by the backend's access
control; keep development servers private. This feature adds no multi-user data
ownership or self-service registration/reset.
