# SRS Plugins Directory

Place your plugin files here. Each plugin must be a `.js` file with an ES module default export.

## Plugin Shape

```js
// backend/plugins/my-plugin.js
export default {
  name: "my-plugin",          // unique kebab-case identifier
  version: "1.0.0",           // semver version string
  description: "What it does",

  hooks: {
    // Called before a distribution XDR is built.
    // ctx: { contractId, walletAddress, tokenId }
    async beforeDistribute(ctx) {
      console.log("About to distribute for", ctx.contractId);
    },

    // Called after a distribution succeeds.
    // ctx: { contractId, walletAddress, transactionId, xdr }
    async afterDistribute(ctx) {
      // e.g. send a webhook, write to an external DB, etc.
    },

    // Called when a new dispute is created.
    // ctx: the full dispute object ({ ticketId, walletAddress, category, ... })
    async onDispute(ctx) {
      // e.g. open a Jira ticket, send a Slack message, etc.
    },

    // Called when a payment/distribution is initiated.
    // ctx: { contractId, walletAddress, tokenId }
    async onPayment(ctx) {
      // e.g. log to an external billing system
    },
  },
};
```

## Rules

- Files starting with `_` are ignored (use for shared helpers).
- Plugins must complete each hook within **5 seconds**; slower hooks are timed out.
- Errors inside a hook are caught and logged — they will **never crash** the server.
- Plugins hot-reload automatically when files change (no restart needed).

## Management API

```
GET  /api/v1/plugins                   list all plugins
GET  /api/v1/plugins/:name             plugin details
POST /api/v1/plugins/:name/enable      enable a plugin
POST /api/v1/plugins/:name/disable     disable a plugin
GET  /api/v1/plugins/:name/logs        execution logs
GET  /api/v1/plugins/audit             cross-plugin audit log
POST /api/v1/plugins/reload            trigger manual reload
```

All endpoints require an API key with at least the `operator` role.
