/**
 * Granular notification preferences route — closes #1046.
 *
 * GET  /api/v1/notifications/preferences/:walletAddress
 *   Returns the full preference set: channel flags, per-type toggles,
 *   frequency (immediate / daily_digest / weekly_digest), and quiet hours.
 *
 * POST /api/v1/notifications/preferences
 *   Body: { walletAddress, email_enabled, in_app_enabled, sms_enabled, push_enabled,
 *           notify_distribution, notify_payment, notify_failure, notify_hold,
 *           notify_dispute_created, notify_dispute_resolved,
 *           notify_reputation_changed, notify_governance, notify_security_alert,
 *           frequency, quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
 *           channel_preferences }
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress } from "../../validation.js";
import { sendError, sendValidationError } from "../../error-response.js";
import {
  getNotificationPreference,
  upsertNotificationPreference,
  resolveFrequency,
  resolveQuietHours,
  getChannelPreferences,
  getQuietHours,
  DEFAULT_CHANNEL_PREFERENCES,
} from "../../database/notifications.js";

export const granularPreferencesRouter = Router();

const FREQUENCY_OPTIONS = ["immediate", "daily_digest", "weekly_digest"];

const channelSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  push: z.boolean().optional(),
  in_app: z.boolean().optional(),
});

const channelPreferencesSchema = z.record(z.string(), channelSchema).optional();

const savePreferencesSchema = z.object({
  walletAddress: stellarAddress,
  email_enabled: z.boolean().optional(),
  in_app_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
  push_enabled: z.boolean().optional(),
  notify_distribution: z.boolean().optional(),
  notify_payment: z.boolean().optional(),
  notify_failure: z.boolean().optional(),
  notify_hold: z.boolean().optional(),
  notify_dispute_created: z.boolean().optional(),
  notify_dispute_resolved: z.boolean().optional(),
  notify_reputation_changed: z.boolean().optional(),
  notify_governance: z.boolean().optional(),
  notify_security_alert: z.boolean().optional(),
  frequency: z.enum(FREQUENCY_OPTIONS).optional(),
  quiet_hours_enabled: z.boolean().optional(),
  quiet_hours_start: z.number().int().min(0).max(23).optional(),
  quiet_hours_end: z.number().int().min(0).max(23).optional(),
  channel_preferences: channelPreferencesSchema,
});

// ─── GET /api/v1/notifications/preferences/:walletAddress ──

granularPreferencesRouter.get("/:walletAddress", (req, res) => {
  try {
    if (!/^G[A-Z2-7]{55}$/.test(req.params.walletAddress)) {
      return sendError(
        res,
        400,
        "invalid_stellar_address",
        "Invalid Stellar address format"
      );
    }

    const pref = getNotificationPreference(req.params.walletAddress);
    const channelPrefs = getChannelPreferences(req.params.walletAddress);
    const quietHours = getQuietHours(req.params.walletAddress);

    const response = {
      walletAddress: pref.walletAddress,
      channels: {
        email: Boolean(pref.email_enabled),
        in_app: Boolean(pref.in_app_enabled),
        sms: Boolean(pref.sms_enabled),
        push: Boolean(pref.push_enabled),
      },
      typeToggles: {
        distribution: Boolean(pref.notify_distribution),
        payment: Boolean(pref.notify_payment),
        failure: Boolean(pref.notify_failure),
        hold: Boolean(pref.notify_hold),
        dispute_created: Boolean(pref.notify_dispute_created),
        dispute_resolved: Boolean(pref.notify_dispute_resolved),
        reputation_changed: Boolean(pref.notify_reputation_changed),
        governance: Boolean(pref.notify_governance),
        security_alert: Boolean(pref.notify_security_alert),
      },
      frequency: pref.frequency ?? "immediate",
      quietHours: {
        enabled: quietHours.enabled,
        start: quietHours.start,
        end: quietHours.end,
      },
      channelPreferences: channelPrefs,
    };

    res.json({ success: true, data: response });
  } catch (err) {
    sendError(res, 500, "prefs_fetch_error", err.message);
  }
});

// ─── POST /api/v1/notifications/preferences ──

granularPreferencesRouter.post("/", (req, res) => {
  try {
    const result = savePreferencesSchema.safeParse(req.body);

    if (!result.success) {
      return sendValidationError(
        res,
        result.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }))
      );
    }

    const {
      walletAddress,
      email_enabled,
      in_app_enabled,
      sms_enabled,
      push_enabled,
      notify_distribution,
      notify_payment,
      notify_failure,
      notify_hold,
      notify_dispute_created,
      notify_dispute_resolved,
      notify_reputation_changed,
      notify_governance,
      notify_security_alert,
      frequency,
      quiet_hours_enabled,
      quiet_hours_start,
      quiet_hours_end,
      channel_preferences,
    } = result.data;

    const normalizedFrequency = resolveFrequency(frequency);
    resolveQuietHours(quiet_hours_start, quiet_hours_end);

    const mergedChannelPrefs = {
      ...DEFAULT_CHANNEL_PREFERENCES,
      ...(channel_preferences ?? {}),
    };

    const saved = upsertNotificationPreference({
      walletAddress,
      email_enabled: email_enabled ?? true,
      in_app_enabled: in_app_enabled ?? true,
      sms_enabled: sms_enabled ?? false,
      push_enabled: push_enabled ?? false,
      notify_distribution: notify_distribution ?? true,
      notify_payment: notify_payment ?? true,
      notify_failure: notify_failure ?? true,
      notify_hold: notify_hold ?? true,
      notify_dispute_created: notify_dispute_created ?? true,
      notify_dispute_resolved: notify_dispute_resolved ?? true,
      notify_reputation_changed: notify_reputation_changed ?? false,
      notify_governance: notify_governance ?? true,
      notify_security_alert: notify_security_alert ?? true,
      frequency: normalizedFrequency,
      quiet_hours_enabled: quiet_hours_enabled ?? false,
      quiet_hours_start: quiet_hours_start !== undefined ? quiet_hours_start : 21,
      quiet_hours_end: quiet_hours_end !== undefined ? quiet_hours_end : 9,
      channel_preferences:
        channel_preferences !== undefined
          ? JSON.stringify(mergedChannelPrefs)
          : JSON.stringify(DEFAULT_CHANNEL_PREFERENCES),
    });

    res.json({ success: true, data: saved });
  } catch (err) {
    sendError(res, 500, "prefs_save_error", err.message);
  }
});
