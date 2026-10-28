import { ProtocolError } from "@modelcontextprotocol/server";

export function validateUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      !value.startsWith("https://") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new ProtocolError(
      -32602,
      "Callback must be an HTTPS URL without credentials or a fragment",
    );
  }
}

export function validateSecret(value: string): void {
  try {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
    const encoded = value.slice(6);
    const decoded = atob(encoded);
    if (
      decoded.length < 24 ||
      decoded.length > 64 ||
      btoa(decoded).replace(/=+$/, "") !== encoded.replace(/=+$/, "")
    )
      throw new Error();
  } catch {
    throw new ProtocolError(-32602, "Invalid Standard Webhooks secret");
  }
}
