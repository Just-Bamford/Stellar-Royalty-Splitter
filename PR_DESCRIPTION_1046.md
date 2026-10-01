# PR: Advanced Notification System with User Preferences (#1046)

## Summary

Implements an advanced notification system with granular user preferences, expanded notification types, and enhanced notification center features including archive, search, and mark-as-unread functionality.

## Changes

### New Notification Types
- `distribution_completed`
- `dispute_created` / `dispute_resolved`
- `reputation_changed`
- `governance_proposal`
- `security_alert`

### Database Layer (`backend/src/database/`)
- **core.js**: Migration v24 adds `archived` and `channel` columns to `notifications`, and `channel_preferences` JSON column + `frequency`/`quiet_hours` fields to `notification_preferences`
- **notifications.js**: Rewritten with new notification types and functions:
  - `archiveNotification` / `unarchiveNotification`
  - `searchNotifications`
  - `markNotificationUnread`
  - `getNotificationsByType` / `getUnreadCountByType`
  - `getChannelPreferences` / `getQuietHours`
  - `resolveFrequency` / `resolveQuietHours` / `isWithinQuietHours` / `shouldSendNotification`
  - `getArchivedNotifications`
- **index.js**: Exports all new notification functions

### API Layer (`backend/src/routes/`)
- **notifications.js**: New endpoints:
  - `POST /:id/unread` - Mark notification as unread
  - `GET /:walletAddress/search` - Search notifications
  - `GET /:walletAddress/by-type/:type` - Get notifications by type
  - `GET /:walletAddress/unread-by-type` - Get unread counts by type
  - `POST /:id/archive` / `POST /:id/unarchive` - Archive management
  - `GET /:walletAddress/archived` - Get archived notifications
  - `POST /send` updated to check `shouldSendNotification` (frequency, quiet hours, type toggles)
- **notifications/preferences.js**: New router for granular preferences:
  - `GET /api/v1/notifications/preferences/:walletAddress`
  - `POST /api/v1/notifications/preferences`

### Frontend Layer (`frontend/src/`)
- **context/NotificationContext.tsx**: New state for archived notifications, mark-as-unread, archive/unarchive, search, and preferences. Preference-checking logic (quiet hours, frequency, type toggles) integrated into `addNotification`.
- **components/NotificationCenter.tsx**: Search bar, archive/unarchive buttons, mark-as-unread, new notification type icons/filters, archived notification view
- **components/NotificationCenter.css**: New stylesheet for notification center
- **components/NotificationPreferences.tsx**: Per-type toggles for all notification types, frequency dropdown (immediate/daily_digest/weekly_digest), quiet hours configuration
- **api.ts**: New API endpoints and preference endpoints

### Tests
- **backend/tests/notifications-extended.test.js**: 16 Jest tests covering all new functionality (all passing)
- **backend/tests/notifications.test.js**: Updated mock module to include new exports
- **frontend/src/components/__tests__/NotificationCenter.test.tsx**: 14 vitest tests covering rendering, actions, search, filtering, and archived notification view (all passing)

## Test Results
- Backend: 42/42 notification tests pass (16 new extended + 13 existing + 13 SMS)
- Frontend: 14/14 NotificationCenter tests pass
- TypeScript: No new type errors introduced
- Backend ESLint: No new errors (10 pre-existing errors in src/index.js unrelated to this PR)

## Branch
- `feature/1046-advanced-notification-system` (branched from `dev`)
