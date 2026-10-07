import fs from "node:fs/promises";
import path from "node:path";
import { STELLAR_ACCOUNT_REGEX, STELLAR_CONTRACT_REGEX } from "./constants.js";

/**
 * Validates contract configuration data.
 * @param {object} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateContractData(data) {
  const errors = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Contract data must be a JSON object"] };
  }

  if (data.contractId && !STELLAR_CONTRACT_REGEX.test(data.contractId)) {
    errors.push(`Invalid Stellar Contract ID: ${data.contractId}`);
  }

  if (data.royaltyRate !== undefined) {
    const rate = Number(data.royaltyRate);
    if (isNaN(rate) || rate < 0 || rate > 10000) {
      errors.push("Royalty rate must be between 0 and 10000 basis points (0-100%)");
    }
  }

  if (data.recipients !== undefined) {
    if (!Array.isArray(data.recipients)) {
      errors.push("Recipients must be an array");
    } else {
      let totalShare = 0;
      data.recipients.forEach((r, idx) => {
        if (!r.address || !STELLAR_ACCOUNT_REGEX.test(r.address)) {
          errors.push(`Recipient #${idx + 1} has invalid Stellar address: ${r.address}`);
        }
        const share = Number(r.share);
        if (isNaN(share) || share <= 0 || share > 10000) {
          errors.push(`Recipient #${idx + 1} has invalid share percentage`);
        } else {
          totalShare += share;
        }
      });
      if (data.recipients.length > 0 && totalShare !== 10000) {
        errors.push(`Total recipient shares must sum to 10000 basis points (100%), got ${totalShare}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Reads and parses a .contract or .stellar configuration file.
 * @param {string} filePath
 * @returns {Promise<{ success: boolean, data?: object, error?: string, filePath: string }>}
 */
export async function readContractFile(filePath) {
  try {
    if (!filePath || typeof filePath !== "string") {
      return { success: false, error: "Invalid file path", filePath: filePath || "" };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".contract" && ext !== ".stellar" && ext !== ".json") {
      return {
        success: false,
        error: `Unsupported file extension: ${ext}. Expected .contract or .stellar`,
        filePath,
      };
    }

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const validation = validateContractData(parsed);

    if (!validation.valid) {
      return {
        success: false,
        error: `Validation failed: ${validation.errors.join("; ")}`,
        data: parsed,
        filePath,
      };
    }

    return {
      success: true,
      data: parsed,
      filePath,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read contract file: ${err.message}`,
      filePath,
    };
  }
}

/**
 * Writes contract configuration data to a file.
 * @param {string} filePath
 * @param {object} contractData
 * @returns {Promise<{ success: boolean, error?: string, filePath: string }>}
 */
export async function writeContractFile(filePath, contractData) {
  try {
    const validation = validateContractData(contractData);
    if (!validation.valid) {
      return {
        success: false,
        error: `Validation failed: ${validation.errors.join("; ")}`,
        filePath,
      };
    }

    const jsonString = JSON.stringify(contractData, null, 2);
    await fs.writeFile(filePath, jsonString, "utf-8");
    return { success: true, filePath };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write contract file: ${err.message}`,
      filePath,
    };
  }
}
