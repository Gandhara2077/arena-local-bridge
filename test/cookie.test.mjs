import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cookieHeaderToObjects,
  cookieObjectsToHeader,
  getAuthValue,
  authExpiryMs,
  secondsToExpiry,
} from "../src/cookie.mjs";

test("cookieHeaderToObjects splits header into Playwright objects", () => {
  const header = "a=1; b=two; arena-auth-prod-v1=x";
  const objects = cookieHeaderToObjects(header);
  assert.equal(objects.length, 3);
  assert.equal(objects[0].name, "a");
  assert.equal(objects[0].value, "1");
  assert.equal(objects[0].domain, "arena.ai");
  assert.equal(objects[0].secure, true);
  assert.equal(cookieObjectsToHeader(objects), header);
});

test("getAuthValue joins chunked auth cookie", () => {
  const header = "other=1; arena-auth-prod-v1.0=AB; arena-auth-prod-v1.1=CD";
  assert.equal(getAuthValue(header), "ABCD");
});

test("getAuthValue returns single-value cookie", () => {
  const header = "arena-auth-prod-v1=base64-e30";
  assert.equal(getAuthValue(header), "base64-e30");
});

test("authExpiryMs parses base64 payload expires_at (ms)", () => {
  const expiresAt = 1785655566000;
  const token = "base64-" + Buffer.from(JSON.stringify({ expires_at: expiresAt })).toString("base64");
  const header = `arena-auth-prod-v1=${token}; session=x`;
  assert.equal(authExpiryMs(header), expiresAt);
  assert.equal(secondsToExpiry(header, expiresAt - 30_000), 30);
});

test("authExpiryMs normalizes seconds-based expires_at to ms", () => {
  const expiresAtSec = 1785655566;
  const token = "base64-" + Buffer.from(JSON.stringify({ expires_at: expiresAtSec })).toString("base64");
  const header = `arena-auth-prod-v1=${token}`;
  assert.equal(authExpiryMs(header), expiresAtSec * 1000);
});

test("authExpiryMs returns 0 for malformed tokens", () => {
  assert.equal(authExpiryMs("arena-auth-prod-v1=notbase64"), 0);
  assert.equal(authExpiryMs(""), 0);
});
