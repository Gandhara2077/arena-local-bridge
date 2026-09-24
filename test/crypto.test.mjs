import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, encrypt, decrypt, isEncrypted } from "../src/crypto.mjs";

const key = deriveKey("test-secret-123");

test("encrypt/decrypt round-trip", () => {
  const ct = encrypt("hello world", key);
  assert.equal(isEncrypted(ct), true);
  assert.equal(decrypt(ct, key), "hello world");
});

test("encrypt produces enc:v1:iv:ct:tag shape (omni-compatible)", () => {
  const ct = encrypt("value", key);
  const parts = ct.split(":");
  assert.equal(parts[0], "enc");
  assert.equal(parts[1], "v1");
  assert.equal(parts[2].length, 32); // 16-byte IV hex
  assert.equal(parts[4].length, 32); // 16-byte auth tag hex
});

test("decrypt of non-encrypted value returns it unchanged", () => {
  assert.equal(decrypt("plain", key), "plain");
});

test("tampered ciphertext fails auth", () => {
  const ct = encrypt("secret", key);
  const parts = ct.split(":");
  parts[3] = (parseInt(parts[3], 16) ^ 1).toString(16).padStart(parts[3].length, "0"); // flip a bit
  assert.throws(() => decrypt(parts.join(":"), key));
});

test("different secrets yield different keys (decrypt fails)", () => {
  const other = deriveKey("other-secret");
  const ct = encrypt("x", key);
  assert.throws(() => decrypt(ct, other));
});
