import { createHmac, timingSafeEqual } from "node:crypto";

export interface QuickNodeSignatureHeaders {
  nonce: string;
  signature: string;
  timestamp: string;
}

export function signQuickNodeWebhook(
  secret: string,
  headers: Pick<QuickNodeSignatureHeaders, "nonce" | "timestamp">,
  decodedPayload: string,
): string {
  return createHmac("sha256", secret)
    .update(`${headers.nonce}${headers.timestamp}${decodedPayload}`)
    .digest("hex");
}

export function verifyQuickNodeWebhook(
  secret: string,
  headers: QuickNodeSignatureHeaders,
  decodedPayload: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(headers.signature)) return false;
  const expected = Buffer.from(
    signQuickNodeWebhook(secret, headers, decodedPayload),
    "hex",
  );
  const provided = Buffer.from(headers.signature, "hex");
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}
