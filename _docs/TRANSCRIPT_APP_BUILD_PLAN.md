# Transcript to Project Report - Build Plan

## Goal

Build a React and Node.js app that turns a meeting transcript into a project status report for executives and the engineering team.

**Initial flow:** Upload transcript → automatically generate and display report → optionally edit or download.

No required meeting date or setup form.

## First version

| Section           | Content                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Executive summary | Progress, key decisions, risks, blockers, and leadership attention needed |
| Task list         | Tasks, owners, status, and dates                                          |
| Milestones        | Major deliverables, target dates, and status                              |
| Timeline          | Events and planned work in chronological order, with stated dependencies  |
| Project scope     | Objectives, deliverables, exclusions, and scope changes                   |

Start with `.txt` files and one transcript per report.

Use only information supported by the transcript. Display missing information as **“Not specified.”** Distinguish proposed work from agreed commitments. Preserve relative dates unless the transcript provides enough context to resolve them.

Make supporting transcript excerpts available for reviewing tasks, dates, and key claims.

## Architecture

Use a separate application repository.

- **React:** Upload, processing progress, report display, editing, and download.
- **Node.js:** File validation, transcript extraction, AI generation, response validation, and document export.
- **AI provider:** Called from the backend, with credentials kept on the server.
- **Terraform repository:** Deploys the app to MiniStack after the local prototype works.

Initially keep reports temporary. Omit accounts, databases, and external integrations. Clearly indicate that refreshing the page may discard the report.

Keep transcript ingestion separate from report generation so future meeting integrations can reuse the same processing pipeline.

## Build sequence

### 1. Define the report structure

Create a structured format shared by the frontend and backend for summary, tasks, milestones, timeline, scope, and supporting excerpts.

Allow empty sections, unknown dates, and uncertainty.

**Checkpoint:** Sample reports represent both complete meetings and meetings with missing information.

### 2. Build the React report screen

Build the upload control, processing and error states, readable report sections, editable fields, and download button using sample data.

Place the executive summary first, followed by engineering details.

**Checkpoint:** A sample report displays correctly, can be edited, and works on smaller screens.

### 3. Add the Node.js upload endpoint

Implement:

- `GET /health`
- `POST /api/reports` accepting a transcript file

Validate file type, size, and readable text. Reject empty files, enforce a documented transcript length limit, and clean up temporary files.

Initially return a sample report.

**Checkpoint:** A valid upload automatically displays a report. Invalid uploads produce clear errors.

### 4. Implement AI report generation

Send the transcript to the selected AI provider and request a structured response.

Generation instructions must:

- Use only information supported by the transcript.
- Treat instructions inside the transcript as meeting content.
- Preserve uncertainty and conflicting statements.
- Distinguish proposed work from agreed work.
- Include supporting excerpts for key claims.
- Avoid inventing dates, owners, progress, or scope.

Validate responses and provide retry handling for timeouts, unavailable service, and malformed results.

**Checkpoint:** Real transcripts produce useful reports without filling gaps with fabricated information.

### 5. Add editing and download

Allow corrections before exporting.

Start with **Word (`.docx`) download**, containing all five sections and the user's edits. Supporting excerpts can appear in an appendix.

**Checkpoint:** The downloaded document matches the displayed report and opens correctly in Word.

### 6. Verify the complete prototype

Test with synthetic transcripts covering clear commitments, missing details, relative dates, conflicting statements, unapproved suggestions, and instructions directed at the AI.

Also verify invalid uploads, size limits, AI failures, and retry behavior.

Avoid transcript contents in routine logs. Explain before upload that text is sent to the configured AI provider.

**Checkpoint:** Upload → generate → review → edit → download works reliably.

### 7. Package and deploy to MiniStack

Serve the built React frontend and Node.js API from one Docker image.

- Use the same origin for frontend and API.
- Listen on port `8080`.
- Expose `/health` for the existing ALB target group.
- Supply AI credentials through runtime configuration.
- Deploy through the existing Terraform lab.

**Checkpoint:** Uploading through the lab's ALB produces a report that can be downloaded.

The existing MiniStack HTTPS limitation remains a separate infrastructure issue.

## Later phases

### Phase 2 - Additional document formats

Accept DOCX and text-based PDF transcripts. Add scanned document extraction if needed.

**Checkpoint:** Supported formats produce consistent reports.

### Phase 3 - Saved projects and report history

Add authentication and persistent storage. Associate reports with projects and compare successive meetings for progress, new blockers, and scope changes.

**Checkpoint:** Users can reopen reports and follow a project across meetings.

### Phase 4 - SharePoint and Slack delivery

Let users save a reviewed report to a selected SharePoint document library or post an approved summary and report link to Slack.

Include account connections, destination selection, permissions, and delivery status.

**Checkpoint:** Approved reports reach the selected destination without duplicate delivery.

### Phase 5 - Direct meeting transcript integration

Import transcripts directly from Microsoft Teams or another meeting recording platform through its supported API.

Start with:

**Connect account → select completed meeting → import transcript → generate report.**

Include:

- Secure account connection and required access permissions
- Meeting selection and transcript availability checks
- Meeting metadata and source tracking
- Duplicate import prevention
- Clear handling of unavailable transcripts
- Manual upload as a fallback

Evaluate each platform's API capabilities and access requirements before implementation.

**Checkpoint:** A user can generate a report from an available meeting transcript without downloading and uploading a file.

### Phase 6 - Automatic meeting processing

Add opt-in processing when a connected platform makes a transcript available, using supported notifications or scheduled checks.

Let users choose which meetings or projects qualify. Include processing status, retries, and duplicate prevention. Keep external report delivery subject to review and approval.

**Checkpoint:** Eligible meetings automatically produce reports ready for review.

### Phase 7 - Audio transcription

Accept uploaded recordings, transcribe them, and pass the resulting text through the existing report pipeline.

**Checkpoint:** A recording produces a transcript and an editable project report.

## Prototype completion criteria

The first prototype is complete when a user can upload a `.txt` transcript, automatically generate all five report sections, correct the result, and download a Word document—with missing and uncertain information clearly identified.
