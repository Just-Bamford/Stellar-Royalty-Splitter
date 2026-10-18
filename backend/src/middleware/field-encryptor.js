import { decryptField, encryptField, fieldBlindIndex } from "../crypto/encryption.js";

/** Register field-level encryption functions used by SQLite views and triggers. */
export function registerFieldEncryptor(db) {
  if (typeof db.function !== "function") return false;
  db.function("encrypt_field", (value, contractId, field) =>
    encryptField(value, contractId, field),
  );
  db.function("decrypt_field", (value, contractId, field) =>
    decryptField(value, contractId, field),
  );
  db.function("field_blind_index", (value, contractId, field) =>
    fieldBlindIndex(value, contractId, field),
  );
  return true;
}