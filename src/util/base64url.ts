export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

export function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

export function randomId(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
