/**
 * Email templates for dispute / ticket notifications (#607).
 *
 * Exports two builder functions:
 *   - disputeSubmittedEmail   — sent to the contributor after opening a ticket
 *   - disputeStatusUpdateEmail — sent to the contributor when admin updates status/adds a comment
 */

const STATUS_LABELS = {
  open: "Open",
  under_review: "Under Review",
  resolved: "Resolved",
  closed: "Closed",
};

const CATEGORY_LABELS = {
  wrong_amount: "Wrong Amount",
  missing_payment: "Missing Payment",
  other: "Other",
};

// ─── Shared layout helper ─────────────────────────────────────────────────────

function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 32px auto; background: #fff;
                 border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .header { background: #1a1a2e; color: #fff; padding: 24px 32px; }
    .header h1 { margin: 0; font-size: 20px; }
    .body { padding: 24px 32px; color: #333; line-height: 1.6; }
    .field { margin: 12px 0; }
    .label { font-weight: bold; color: #555; font-size: 13px; text-transform: uppercase; }
    .value { margin-top: 2px; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 12px;
                    font-size: 13px; font-weight: bold; background: #e8f4fd; color: #1565c0; }
    .note-box { background: #f9f9f9; border-left: 4px solid #1a1a2e;
                padding: 12px 16px; margin: 16px 0; border-radius: 0 4px 4px 0; }
    .footer { background: #f4f4f4; padding: 16px 32px; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Stellar Royalty Splitter</h1></div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">
      This is an automated message from the Stellar Royalty Splitter platform.
      Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>`;
}

// ─── Template: ticket opened ──────────────────────────────────────────────────

/**
 * Email sent to the contributor immediately after they submit a dispute.
 *
 * @param {object} params
 * @param {string} params.ticketId     e.g. "DSP-A3F2C019"
 * @param {string} params.category     raw category key
 * @param {string} params.description
 * @param {string} [params.contractId]
 * @returns {{ subject: string, html: string, text: string }}
 */
export function disputeSubmittedEmail({ ticketId, category, description, contractId }) {
  const subject = `Dispute Submitted — Ticket ${ticketId}`;
  const categoryLabel = CATEGORY_LABELS[category] ?? category;

  const html = wrapHtml(
    subject,
    `
    <p>Your dispute has been received and assigned ticket ID <strong>${ticketId}</strong>.
       Our team will review it shortly.</p>

    <div class="field">
      <div class="label">Ticket ID</div>
      <div class="value"><strong>${ticketId}</strong></div>
    </div>
    <div class="field">
      <div class="label">Category</div>
      <div class="value">${categoryLabel}</div>
    </div>
    ${
      contractId
        ? `<div class="field">
             <div class="label">Contract ID</div>
             <div class="value" style="font-family:monospace;font-size:13px;">${contractId}</div>
           </div>`
        : ""
    }
    <div class="field">
      <div class="label">Status</div>
      <div class="value"><span class="status-badge">Open</span></div>
    </div>
    <div class="field">
      <div class="label">Your Description</div>
      <div class="note-box">${escapeHtml(description)}</div>
    </div>

    <p>You will receive an email whenever the status changes or an admin responds.
       Please keep your ticket ID for reference.</p>
  `
  );

  const text = [
    subject,
    "",
    `Your dispute has been received. Ticket ID: ${ticketId}`,
    "",
    `Category: ${categoryLabel}`,
    contractId ? `Contract ID: ${contractId}` : "",
    `Status: Open`,
    "",
    "Description:",
    description,
    "",
    "You will be notified when the status changes or an admin responds.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  return { subject, html, text };
}

// ─── Template: status update / admin response ─────────────────────────────────

/**
 * Email sent to the contributor when an admin updates the dispute status
 * or posts a comment.
 *
 * @param {object} params
 * @param {string} params.ticketId
 * @param {string} params.newStatus     raw status key
 * @param {string} [params.adminNote]   optional admin note attached to the status change
 * @param {string} [params.adminComment] optional new comment body from admin
 * @returns {{ subject: string, html: string, text: string }}
 */
export function disputeStatusUpdateEmail({ ticketId, newStatus, adminNote, adminComment }) {
  const statusLabel = STATUS_LABELS[newStatus] ?? newStatus;
  const subject = `Dispute Update — Ticket ${ticketId} is now ${statusLabel}`;

  const noteSection = adminNote
    ? `<div class="field">
         <div class="label">Admin Note</div>
         <div class="note-box">${escapeHtml(adminNote)}</div>
       </div>`
    : "";

  const commentSection = adminComment
    ? `<div class="field">
         <div class="label">Admin Response</div>
         <div class="note-box">${escapeHtml(adminComment)}</div>
       </div>`
    : "";

  const html = wrapHtml(
    subject,
    `
    <p>The status of your dispute ticket <strong>${ticketId}</strong> has been updated.</p>

    <div class="field">
      <div class="label">Ticket ID</div>
      <div class="value"><strong>${ticketId}</strong></div>
    </div>
    <div class="field">
      <div class="label">New Status</div>
      <div class="value"><span class="status-badge">${statusLabel}</span></div>
    </div>
    ${noteSection}
    ${commentSection}

    <p>If you have additional information to provide, please reply using the API
       or contact support with your ticket ID.</p>
  `
  );

  const textParts = [
    subject,
    "",
    `Ticket ${ticketId} has been updated to: ${statusLabel}`,
  ];
  if (adminNote) textParts.push("", "Admin Note:", adminNote);
  if (adminComment) textParts.push("", "Admin Response:", adminComment);
  textParts.push("", "If you have further information, please contact support with your ticket ID.");

  return { subject, html, text: textParts.join("\n") };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
