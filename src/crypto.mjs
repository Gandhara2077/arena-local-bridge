// crypto.mjs — AES-256-GCM field encryption, byte-compatible with the
// omni-route vault ("enc:v1:iv:ct:tag") so existing credentials migrate cleanly.
import crypto from "node:crypto";

export const KDF_SALT = "omniroute-field-encryption-v1";

export function deriveKey(secret) {
  if (!secret) throw new Error("STORAGE_ENCRYPTION_KEY is missing");
  return crypto.scryptSync(String(secret), KDF_SALT, 32);
}

export function encrypt(value, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("hex")}:${encrypted.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

export function decrypt(value, key) {
  const v = String(value ?? "");
  if (!v.startsWith("enc:v1:")) return v;
  const [, , ivHex, cipherHex, tagHex] = v.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(cipherHex, "hex", "utf8") + decipher.final("utf8");
}

export function isEncrypted(value) {
  return String(value ?? "").startsWith("enc:v1:");
}
