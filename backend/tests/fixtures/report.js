import { NOT_SPECIFIED } from "../../../shared/report.js";

export const SAMPLE_TRANSCRIPT = `Project: Customer portal pilot
Maya: The pilot should let customers view their invoices and download receipts.
Alex: The invoice API is complete. I will finish the receipt download endpoint by Friday.
Sam: I will build the invoice screen after Alex provides the API contract. No delivery date yet.
Maya: Agreed: the pilot will include invoice viewing and receipt downloads. Payments are out of scope.
Alex: The API contract will be ready tomorrow.
Sam: We are blocked on access to the staging environment.
Maya: I will ask leadership to approve staging access. We need that access before integration testing.
Alex: The pilot milestone is next Wednesday, but staging access could delay it.
Sam: Maybe we should add email notifications later. That is a suggestion, not approved work.
Maya: Let's keep email notifications out of the committed scope until we discuss them.
Alex: We said Friday for receipts. I also mentioned Thursday earlier; Friday is the agreed target.
`;

const quote = {
  objective: "The pilot should let customers view their invoices and download receipts.",
  api: "Alex: The invoice API is complete.",
  receipt:
    "Alex: The invoice API is complete. I will finish the receipt download endpoint by Friday.",
  screen:
    "Sam: I will build the invoice screen after Alex provides the API contract. No delivery date yet.",
  scope:
    "Agreed: the pilot will include invoice viewing and receipt downloads. Payments are out of scope.",
  contract: "Alex: The API contract will be ready tomorrow.",
  blocker: "We are blocked on access to the staging environment.",
  leadership:
    "Maya: I will ask leadership to approve staging access. We need that access before integration testing.",
  milestone: "The pilot milestone is next Wednesday, but staging access could delay it.",
  proposal:
    "Maybe we should add email notifications later. That is a suggestion, not approved work.",
  decision: "Let's keep email notifications out of the committed scope until we discuss them.",
  conflict:
    "We said Friday for receipts. I also mentioned Thursday earlier; Friday is the agreed target.",
};

const claim = (text, sources, uncertainty = "") => ({ text, sources, uncertainty });

export const SAMPLE_REPORT = {
  title: "Customer portal pilot",
  executiveSummary: [
    claim(
      "The customer portal pilot will let customers view invoices and download receipts. The invoice API is complete, and Alex will finish the receipt endpoint by Friday. Sam will build the invoice screen after Alex provides the API contract, expected tomorrow. Payments are excluded, and email notifications remain an unapproved suggestion.",
      [
        quote.scope,
        quote.api,
        quote.receipt,
        quote.screen,
        quote.contract,
        quote.proposal,
        quote.decision,
      ],
    ),
    claim(
      "Staging access is blocking the team and could delay the pilot milestone targeted for next Wednesday. Maya will request leadership approval for access before integration testing can begin.",
      [quote.blocker, quote.milestone, quote.leadership],
    ),
  ],
  tasks: [
    {
      description: "Complete the invoice API",
      owner: "Alex",
      status: "Completed",
      commitment: "Not specified",
      date: NOT_SPECIFIED,
      dependency: NOT_SPECIFIED,
      sources: [quote.api],
      uncertainty: "",
    },
    {
      description: "Finish the receipt download endpoint",
      owner: "Alex",
      status: NOT_SPECIFIED,
      commitment: "Agreed",
      date: "Friday",
      dependency: NOT_SPECIFIED,
      sources: [quote.receipt, quote.conflict],
      uncertainty:
        "Thursday was mentioned earlier; Friday is the agreed target. The calendar date is not specified.",
    },
    {
      description: "Build the invoice screen",
      owner: "Sam",
      status: NOT_SPECIFIED,
      commitment: "Agreed",
      date: NOT_SPECIFIED,
      dependency: "Alex provides the API contract",
      sources: [quote.screen],
      uncertainty: "No delivery date was agreed.",
    },
    {
      description: "Provide the API contract",
      owner: "Alex",
      status: NOT_SPECIFIED,
      commitment: "Agreed",
      date: "Tomorrow",
      dependency: NOT_SPECIFIED,
      sources: [quote.contract],
      uncertainty: "The calendar date is not specified.",
    },
    {
      description: "Request approval for staging access",
      owner: "Maya",
      status: NOT_SPECIFIED,
      commitment: "Agreed",
      date: NOT_SPECIFIED,
      dependency: "Leadership approval",
      sources: [quote.leadership],
      uncertainty: "",
    },
    {
      description: "Add email notifications",
      owner: NOT_SPECIFIED,
      status: NOT_SPECIFIED,
      commitment: "Proposed",
      date: NOT_SPECIFIED,
      dependency: "Further scope discussion",
      sources: [quote.proposal, quote.decision],
      uncertainty: "This suggestion has not been approved.",
    },
  ],
  milestones: [
    {
      description: "Customer portal pilot",
      date: "Next Wednesday",
      status: NOT_SPECIFIED,
      commitment: NOT_SPECIFIED,
      sources: [quote.milestone],
      uncertainty: "Staging access may delay the milestone; the calendar date is not specified.",
    },
  ],
  timeline: [
    {
      description: "API contract ready",
      date: "Tomorrow",
      dependency: NOT_SPECIFIED,
      sources: [quote.contract],
      uncertainty: "Relative to an unspecified meeting date.",
    },
    {
      description: "Receipt endpoint target",
      date: "Friday",
      dependency: NOT_SPECIFIED,
      sources: [quote.receipt, quote.conflict],
      uncertainty: "Earlier Thursday target was superseded by Friday.",
    },
    {
      description: "Pilot milestone",
      date: "Next Wednesday",
      dependency: "Staging access before integration testing",
      sources: [quote.milestone, quote.leadership],
      uncertainty: "Relative dates cannot be placed on a calendar without the meeting date.",
    },
    {
      description: "Invoice API complete",
      date: NOT_SPECIFIED,
      dependency: NOT_SPECIFIED,
      sources: [quote.api],
      uncertainty:
        "Completion date is not specified; this item cannot be placed on the dated timeline.",
    },
  ],
  projectScope: {
    overview: [
      claim(
        "The customer portal pilot will give customers a way to view invoices and download receipts.",
        [quote.objective],
      ),
      claim(
        "The agreed pilot includes invoice viewing and receipt downloads. Payments are outside the scope. Email notifications have been suggested but remain unapproved and excluded until further discussion.",
        [quote.scope, quote.proposal, quote.decision],
      ),
    ],
  },
  notes: [
    "The meeting date is not specified. Relative dates are preserved, and the timeline order is indicative where dates cannot be compared.",
    "This is a prepared sample report for the included synthetic transcript. It was not generated by DeepSeek.",
  ],
};
