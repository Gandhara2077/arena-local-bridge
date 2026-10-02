// Stored fields use enc:v1:<iv hex>:<ciphertext hex>:<tag hex>.
// Keep the historical salt and framing so existing encrypted records still open.
import crypto from "node:crypto";

export const KDF_SALT = "omniroute-field-encryption-v1";

export function deriveKey(secret) {
  if (!secret) throw new Error("STORAGE_ENCRYPTION_KEY is missing");
  return crypto.scryptSync(String(secret), KDF_SALT, 32);
}

export function encrypt(value, key) {
  const nonce = crypto.randomBytes(16);
  const encoder = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const payload = Buffer.concat([encoder.update(String(value), "utf8"), encoder.final()]);
  return ["enc", "v1", ...[nonce, payload, encoder.getAuthTag()].map((bytes) => bytes.toString("hex"))].join(":");
}

export function decrypt(value, key) {
  const stored = String(value ?? "");
  if (!isEncrypted(stored)) return stored;
  const [nonceHex, payloadHex, tagHex] = stored.slice("enc:v1:".length).split(":");
  const decoder = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonceHex, "hex"), { authTagLength: 16 });
  decoder.setAuthTag(Buffer.from(tagHex, "hex"));
  const cleartext = Buffer.concat([decoder.update(payloadHex, "hex"), decoder.final()]);
  return cleartext.toString("utf8");
}

export function isEncrypted(value) {
  return String(value ?? "").startsWith("enc:v1:");
}
