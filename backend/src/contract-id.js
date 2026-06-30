export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export function isValidContractId(contractId) {
  return typeof contractId === "string" && CONTRACT_ID_PATTERN.test(contractId);
}

export function assertValidContractId(contractId) {
  if (!isValidContractId(contractId)) {
    throw new TypeError("Invalid contract ID format");
  }
  return contractId;
}
