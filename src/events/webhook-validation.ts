import { ProtocolError } from "@modelcontextprotocol/server";

export function isValidCallbackUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

export function isValidWebhookSecret(value: unknown): value is string {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    return false;
  try {
    const encoded = value.slice(6);
    const decoded = atob(encoded);
    return (
      decoded.length >= 24 &&
      decoded.length <= 64 &&
      btoa(decoded).replace(/=+$/, "") === encoded.replace(/=+$/, "")
    );
  } catch {
    return false;
  }
}

export function validateUrl(value: string): void {
  if (!isValidCallbackUrl(value))
    throw new ProtocolError(
      -32602,
      "Callback must be an HTTPS URL without credentials or a fragment",
    );
}

export function validateSecret(value: string): void {
  if (!isValidWebhookSecret(value))
    throw new ProtocolError(-32602, "Invalid Standard Webhooks secret");
}
