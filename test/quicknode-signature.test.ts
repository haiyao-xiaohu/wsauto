import assert from "node:assert/strict";
import test from "node:test";
import {
  signQuickNodeWebhook,
  verifyQuickNodeWebhook,
} from "../src/quicknode-signature.js";

test("验证 QuickNode HMAC-SHA256 Webhook 签名", () => {
  const secret = "test-secret";
  const headers = { nonce: "nonce-1", timestamp: "1785083148" };
  const payload = "{\"ok\":true}";
  const signature = signQuickNodeWebhook(secret, headers, payload);

  assert.equal(
    verifyQuickNodeWebhook(secret, { ...headers, signature }, payload),
    true,
  );
  assert.equal(
    verifyQuickNodeWebhook(
      secret,
      { ...headers, signature },
      "{\"ok\":false}",
    ),
    false,
  );
});
