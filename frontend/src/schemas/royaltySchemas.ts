/**
 * Zod validation schemas for form inputs.
 * Defines validation rules for Initialize and Distribute forms.
 */

import { z } from "zod";
import { isValidStellarAddress } from "../lib/validation";

/**
 * Schema for a single collaborator in InitializeForm.
 * Accepts string or number for basisPoints since form inputs come as strings.
 */
export const collaboratorSchema = z.object({
  address: z
    .string()
    .min(1, "Stellar address is required")
    .refine(isValidStellarAddress, {
      message: "Invalid Stellar address — must start with G and be 56 characters",
    }),
  basisPoints: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === "string" ? parseFloat(val) : val;
      return !isNaN(num) && num > 0 && num <= 100;
    }, {
      message: "Share must be between 0% and 100%",
    }),
});

/**
 * Schema for InitializeForm.
 * Validates the entire collaborator list and ensures percentages sum to 100%.
 */
export const initializeFormSchema = z.object({
  collaborators: z
    .array(collaboratorSchema)
    .min(1, "At least one collaborator is required"),
}).refine(
  (data) => {
    const total = data.collaborators.reduce((sum, c) => {
      const num = typeof c.basisPoints === "string" ? parseFloat(c.basisPoints) : c.basisPoints;
      return sum + (num || 0);
    }, 0);
    // Allow for floating point rounding
    return Math.round(total * 100) === 10_000;
  },
  {
    message: "Collaborator percentages must sum to exactly 100%",
    path: ["collaborators"],
  }
);

/**
 * Schema for DistributeForm.
 * Validates token ID (contract address) and amount.
 * Accepts string or number for amount since form inputs come as strings.
 */
export const distributeFormSchema = z.object({
  tokenId: z
    .string()
    .min(1, "Token contract address is required")
    .refine((addr) => /^C[A-Z2-7]{55}$/.test(addr), {
      message: "Invalid Stellar contract address — must start with C and be 56 characters",
    }),
  amount: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === "string" ? parseFloat(val) : val;
      return !isNaN(num) && num > 0;
    }, {
      message: "Amount must be a valid positive number",
    }),
});

export type InitializeFormData = z.infer<typeof initializeFormSchema>;
export type DistributeFormData = z.infer<typeof distributeFormSchema>;
