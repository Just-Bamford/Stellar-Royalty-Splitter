/**
 * Generates HTML and plaintext onboarding reminder emails for contributors.
 * Includes complete progress percentage, list of incomplete items,
 * direct action links, and next step instructions.
 */
export function renderOnboardingReminderEmail({
  walletAddress,
  email,
  completionPercentage,
  items,
  nextStep,
}) {
  const shortAddress =
    walletAddress && walletAddress.length > 10
      ? `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`
      : walletAddress || "Contributor";

  const incompleteItems = items.filter((item) => !item.completed);
  const completedItems = items.filter((item) => item.completed);

  const itemsListHtml = items
    .map((item) => {
      const icon = item.completed ? "✅" : "⏳";
      const statusText = item.completed
        ? "Completed"
        : item.required
        ? "Action Required (Blocking)"
        : "Pending Milestone";
      const badgeClass = item.completed ? "#10b981" : item.required ? "#ef4444" : "#f59e0b";

      return `
        <li style="margin-bottom: 12px; padding: 10px; border-radius: 6px; background-color: #f9fafb; border-left: 4px solid ${badgeClass};">
          <strong style="color: #111827;">${icon} ${item.label}</strong>
          <span style="font-size: 12px; margin-left: 8px; color: ${badgeClass}; font-weight: 600;">(${statusText})</span>
          <p style="margin: 4px 0 0 0; font-size: 13px; color: #4b5563;">${item.description}</p>
        </li>
      `;
    })
    .join("");

  const itemsListText = items
    .map((item) => {
      const status = item.completed ? "[X]" : "[ ]";
      const type = item.required ? "(Required)" : "(Optional)";
      return `${status} ${item.label} ${type} - ${item.description}`;
    })
    .join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Your Contributor Onboarding</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 20px; color: #1f2937;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e5e7eb;">
    
    <!-- Header -->
    <div style="background-color: #4f46e5; padding: 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700;">Stellar Royalty Splitter</h1>
      <p style="color: #e0e7ff; margin: 6px 0 0 0; font-size: 14px;">Contributor Onboarding Reminder</p>
    </div>

    <!-- Body -->
    <div style="padding: 24px;">
      <p style="font-size: 16px; margin-top: 0;">Hello <strong>${shortAddress}</strong>,</p>
      
      <p style="font-size: 15px; color: #374151; line-height: 1.5;">
        You are currently <strong>${completionPercentage}%</strong> complete with your Stellar Royalty Splitter onboarding setup. Complete all required steps to unlock automated royalty payouts and distribution actions.
      </p>

      <!-- Progress Bar -->
      <div style="margin: 20px 0; background-color: #e5e7eb; border-radius: 9999px; height: 16px; overflow: hidden;">
        <div style="width: ${completionPercentage}%; background-color: #4f46e5; height: 100%; border-radius: 9999px;"></div>
      </div>

      ${
        nextStep
          ? `
      <!-- Next Step Callout -->
      <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 6px 0; color: #1e40af; font-size: 15px;">👉 Next Recommended Step: ${nextStep.label}</h3>
        <p style="margin: 0; font-size: 14px; color: #1e3a8a;">${nextStep.description}</p>
      </div>
      `
          : ""
      }

      <h3 style="color: #111827; font-size: 16px; margin-bottom: 12px;">Checklist Summary</h3>
      <ul style="list-style: none; padding: 0; margin: 0 0 24px 0;">
        ${itemsListHtml}
      </ul>

      <!-- CTA Button -->
      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="https://stellar-royalty-splitter.app/onboarding" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; display: inline-block; font-size: 15px;">
          Complete Onboarding Now
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">
      <p style="margin: 0;">This email was sent to ${email || shortAddress} regarding your Stellar Royalty Splitter contributor account.</p>
      <p style="margin: 4px 0 0 0;">Need help? Check our documentation or contact support.</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Stellar Royalty Splitter - Contributor Onboarding Reminder

Hello ${shortAddress},

You are currently ${completionPercentage}% complete with your contributor onboarding.

${nextStep ? `NEXT RECOMMENDED STEP: ${nextStep.label}\n${nextStep.description}\n` : ""}

CHECKLIST SUMMARY:
${itemsListText}

Complete your onboarding at: https://stellar-royalty-splitter.app/onboarding

Need help? Contact support or inspect our documentation.
  `.trim();

  return {
    subject: `Action Required: Complete your Stellar Royalty Splitter contributor onboarding (${completionPercentage}% complete)`,
    html,
    text,
    incompleteCount: incompleteItems.length,
    completedCount: completedItems.length,
  };
}
