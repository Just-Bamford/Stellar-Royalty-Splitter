import express from "express";
import { z } from "zod";
import { getContributorOnboarding, upsertContributorOnboarding } from "../database.js";
import { renderOnboardingReminderEmail } from "../email-template.js";
import logger from "../logger.js";
import { isValidStellarAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";

const router = express.Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const updateSchema = z.object({
  email: z
    .string()
    .optional()
    .refine((val) => !val || emailRegex.test(val), {
      message: "Invalid email address format",
    }),
  kycStatus: z.enum(["unverified", "pending", "verified"]).optional(),
  paymentPreferencesSet: z.boolean().optional(),
  payoutToken: z.string().min(1).max(12).optional(),
  taxInfoSubmitted: z.boolean().optional(),
});

const remindSchema = z.object({
  email: z
    .string({
      required_error: "Valid email is required for reminder",
      invalid_type_error: "Valid email is required for reminder",
    })
    .min(1, "Valid email is required for reminder")
    .refine((val) => emailRegex.test(val), {
      message: "Valid email is required for reminder",
    }),
});

export function calculateOnboardingSummary(record, walletAddress) {
  const isWalletConnected = Boolean(walletAddress && isValidStellarAddress(walletAddress));
  const isKycVerified = record.kycStatus === "verified";
  const isPaymentPreferencesSet = Boolean(record.paymentPreferencesSet);
  const isTaxInfoSubmitted = Boolean(record.taxInfoSubmitted);
  const isFirstDistributionReceived = Boolean(record.firstDistributionReceived);

  const items = [
    {
      id: "wallet_connected",
      label: "Wallet connected",
      description: "Connect a valid Stellar account address to interact with smart contracts.",
      completed: isWalletConnected,
      required: true,
      category: "setup",
    },
    {
      id: "kyc_verified",
      label: "KYC verified",
      description: "Complete identity verification for protocol compliance.",
      completed: isKycVerified,
      required: true,
      category: "compliance",
    },
    {
      id: "payment_preferences_set",
      label: "Payment preferences set",
      description: "Configure preferred payout token/asset for receiving distribution payments.",
      completed: isPaymentPreferencesSet,
      required: true,
      category: "finance",
    },
    {
      id: "tax_info_submitted",
      label: "Tax info submitted",
      description: "Provide tax documentation (e.g., W-8BEN/W-9) for tax compliance.",
      completed: isTaxInfoSubmitted,
      required: true,
      category: "compliance",
    },
    {
      id: "first_distribution_received",
      label: "First distribution received",
      description: "Receive your first royalty split distribution from a registered contract.",
      completed: isFirstDistributionReceived,
      required: false,
      category: "milestone",
    },
  ];

  const completedCount = items.filter((i) => i.completed).length;
  const totalCount = items.length;
  const completionPercentage = Math.round((completedCount / totalCount) * 100);

  const requiredItems = items.filter((i) => i.required);
  const requiredComplete = requiredItems.every((i) => i.completed);
  const actionsLocked = !requiredComplete;

  const nextStepItem = items.find((i) => !i.completed);
  const nextStep = nextStepItem
    ? {
        id: nextStepItem.id,
        label: nextStepItem.label,
        description: nextStepItem.description,
      }
    : null;

  return {
    walletAddress,
    email: record.email || "",
    kycStatus: record.kycStatus || "pending",
    payoutToken: record.payoutToken || "XLM",
    paymentPreferencesSet: Boolean(record.paymentPreferencesSet),
    taxInfoSubmitted: Boolean(record.taxInfoSubmitted),
    items,
    completedCount,
    totalCount,
    completionPercentage,
    requiredComplete,
    actionsLocked,
    nextStep,
  };
}

// GET /api/onboarding/:walletAddress
router.get("/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "validation_failed", "Invalid Stellar wallet address format");
  }

  try {
    const record = getContributorOnboarding(walletAddress);
    const summary = calculateOnboardingSummary(record, walletAddress);
    return res.json(summary);
  } catch (err) {
    logger.error(`Error fetching onboarding for ${walletAddress}:`, err);
    return sendError(
      res,
      500,
      "internal_server_error",
      "Internal server error fetching onboarding checklist",
    );
  }
});

// PATCH /api/onboarding/:walletAddress
router.patch("/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "validation_failed", "Invalid Stellar wallet address format");
  }

  const parseResult = updateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return sendValidationError(res, parseResult.error.issues);
  }

  try {
    const updatedRecord = upsertContributorOnboarding(walletAddress, parseResult.data);
    const summary = calculateOnboardingSummary(updatedRecord, walletAddress);
    return res.json({
      message: "Contributor onboarding checklist updated successfully",
      summary,
    });
  } catch (err) {
    logger.error(`Error updating onboarding for ${walletAddress}:`, err);
    return sendError(
      res,
      500,
      "internal_server_error",
      "Internal server error updating onboarding checklist",
    );
  }
});

// POST /api/onboarding/:walletAddress/remind
router.post("/:walletAddress/remind", (req, res) => {
  const { walletAddress } = req.params;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "validation_failed", "Invalid Stellar wallet address format");
  }

  const parseResult = remindSchema.safeParse(req.body);
  if (!parseResult.success) {
    return sendValidationError(res, parseResult.error.issues);
  }

  try {
    const email = parseResult.data.email;
    const record = upsertContributorOnboarding(walletAddress, { email });
    const summary = calculateOnboardingSummary(record, walletAddress);

    const emailPayload = renderOnboardingReminderEmail({
      walletAddress,
      email,
      completionPercentage: summary.completionPercentage,
      items: summary.items,
      nextStep: summary.nextStep,
    });

    logger.info(`Onboarding reminder email dispatched to ${email} for ${walletAddress}`);

    return res.json({
      success: true,
      message: `Onboarding reminder email successfully sent to ${email}`,
      emailDetails: {
        to: email,
        subject: emailPayload.subject,
        completionPercentage: summary.completionPercentage,
        incompleteCount: emailPayload.incompleteCount,
        previewText: emailPayload.text,
      },
    });
  } catch (err) {
    logger.error(`Error sending onboarding reminder for ${walletAddress}:`, err);
    return sendError(
      res,
      500,
      "internal_server_error",
      "Internal server error sending onboarding reminder",
    );
  }
});

export default router;
