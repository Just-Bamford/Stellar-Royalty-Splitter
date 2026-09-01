export function renderWeeklyDigestHtml({ walletAddress, earnings, weekStart, weekEnd, unsubscribeUrl }) {
  const { totalEarned, payoutCount, topContract, contracts } = earnings;

  const contractRows = contracts
    .map(
      (c) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:13px;">
          ${c.contractId.slice(0, 8)}...${c.contractId.slice(-6)}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">
          ${c.totalEarned.toFixed(7)}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">
          ${c.payoutCount}
        </td>
      </tr>`,
    )
    .join("");

  const topContractLabel = topContract
    ? `${topContract.contractId.slice(0, 8)}...${topContract.contractId.slice(-6)} (${topContract.totalEarned.toFixed(7)} earned)`
    : "N/A";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#1a1a2e;padding:24px 32px;">
              <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;">Weekly Earnings Summary</h1>
              <p style="color:#a0a0b0;margin:4px 0 0;font-size:13px;">
                ${weekStart} to ${weekEnd}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;">
              <p style="color:#333;margin:0 0 16px;font-size:14px;">
                Here is your royalty earnings summary for the past week.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="padding:16px;background-color:#f8f9fa;border-radius:6px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <p style="color:#666;margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Total Earned</p>
                          <p style="color:#1a1a2e;margin:4px 0 0;font-size:28px;font-weight:700;">${totalEarned.toFixed(7)}</p>
                        </td>
                        <td align="right">
                          <p style="color:#666;margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Payouts</p>
                          <p style="color:#1a1a2e;margin:4px 0 0;font-size:28px;font-weight:700;">${payoutCount}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="color:#333;margin:0 0 8px;font-size:14px;font-weight:600;">Top Earning Contract</p>
              <p style="color:#555;margin:0 0 20px;font-size:13px;font-family:monospace;">${topContractLabel}</p>
              ${
                contracts.length > 1
                  ? `
              <p style="color:#333;margin:0 0 8px;font-size:14px;font-weight:600;">All Contracts</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin-bottom:16px;">
                <thead>
                  <tr style="background-color:#f8f9fa;">
                    <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600;">Contract</th>
                    <th style="padding:8px 12px;text-align:right;font-size:12px;color:#666;font-weight:600;">Earned</th>
                    <th style="padding:8px 12px;text-align:right;font-size:12px;color:#666;font-weight:600;">Payouts</th>
                  </tr>
                </thead>
                <tbody>${contractRows}</tbody>
              </table>`
                  : ""
              }
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
              <p style="color:#999;margin:0;font-size:12px;">
                Wallet: <span style="font-family:monospace;">${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background-color:#f8f9fa;text-align:center;">
              <p style="color:#999;margin:0;font-size:11px;">
                <a href="${unsubscribeUrl}" style="color:#999;text-decoration:underline;">Unsubscribe from weekly digests</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderWeeklyDigestText({ walletAddress, earnings, weekStart, weekEnd, unsubscribeUrl }) {
  const { totalEarned, payoutCount, topContract, contracts } = earnings;

  const topContractLabel = topContract
    ? `${topContract.contractId.slice(0, 8)}...${topContract.contractId.slice(-6)} (${topContract.totalEarned.toFixed(7)} earned)`
    : "N/A";

  let text = `
Weekly Earnings Summary
${weekStart} to ${weekEnd}
${"=".repeat(40)}

Total Earned:  ${totalEarned.toFixed(7)}
Payout Count:  ${payoutCount}
Top Contract:  ${topContractLabel}
`;

  if (contracts.length > 1) {
    text += `
Contract Breakdown:
${"-".repeat(40)}
`;
    for (const c of contracts) {
      text += `  ${c.contractId.slice(0, 8)}...${c.contractId.slice(-6)}  ${c.totalEarned.toFixed(7)}  (${c.payoutCount} payouts)\n`;
    }
  }

  text += `
Wallet: ${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}

Unsubscribe: ${unsubscribeUrl}
`;

  return text;
}
