/**
 * Base64 as Go's encoding/json decodes a `[]byte` field — standard alphabet,
 * padding required — since that is what a ConfigMap's binaryData and a
 * Secret's data are on the wire. Line breaks are ignored, the way Go's decoder
 * ignores them, so a value written as a wrapped YAML block scalar still
 * decodes.
 *
 * The linter needs both halves of one answer: layer 1 reports a value that is
 * not decodable at all, and `rules/configmap.ts`/`rules/secret.ts` sum the
 * decoded sizes against the apiserver's 1 MiB cap. Returning the length or
 * undefined answers both without decoding the bytes themselves.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * core.MaxSecretSize: the combined size of a Secret's data (or a ConfigMap's
 * data and binaryData together) may not exceed 1 MiB, decoded.
 */
export const MAX_SECRET_SIZE_BYTES = 1024 * 1024;

/** Decoded size in bytes, or undefined when the string is not valid base64. */
export function decodedByteLength(value: string): number | undefined {
  const stripped = value.replace(/[\r\n]/g, '');
  if (stripped.length % 4 !== 0) return undefined;
  if (!BASE64.test(stripped)) return undefined;

  const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0;
  return (stripped.length / 4) * 3 - padding;
}

/**
 * Decoded content as text, or undefined when the string is not valid base64
 * or does not decode as UTF-8. Unlike `decodedByteLength`, this needs the
 * bytes themselves — used only where a value's *content* matters, such as a
 * Secret's `.dockercfg`/`.dockerconfigjson` needing to parse as JSON.
 */
export function decodeBase64(value: string): string | undefined {
  const stripped = value.replace(/[\r\n]/g, '');
  if (decodedByteLength(stripped) === undefined) return undefined;

  try {
    const binary = atob(stripped);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
