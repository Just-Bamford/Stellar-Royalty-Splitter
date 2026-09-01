export const STELLAR_ACCOUNT_ADDRESS_REGEX: RegExp;
export const STELLAR_ACCOUNT_ADDRESS_LENGTH: number;
export const INVALID_STELLAR_ACCOUNT_ADDRESS_MESSAGE: string;
export function normalizeStellarAccountAddress(value: unknown): string;
export function isValidStellarAccountAddress(value: unknown): boolean;
export function getStellarAccountAddressError(value: unknown): string | null;
