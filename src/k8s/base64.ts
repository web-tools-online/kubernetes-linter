/**
 * Base64 as Go's encoding/json decodes a `[]byte` field — standard alphabet,
 * padding required — since that is what a ConfigMap's binaryData is on the
 * wire. Line breaks are ignored, the way Go's decoder ignores them, so a value
 * written as a wrapped YAML block scalar still decodes.
 *
 * The linter needs both halves of one answer: layer 1 reports a value that is
 * not decodable at all, and `rules/configmap.ts` sums the decoded sizes against
 * the apiserver's 1 MiB cap. Returning the length or undefined answers both
 * without decoding the bytes themselves.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size in bytes, or undefined when the string is not valid base64. */
export function decodedByteLength(value: string): number | undefined {
  const stripped = value.replace(/[\r\n]/g, '');
  if (stripped.length % 4 !== 0) return undefined;
  if (!BASE64.test(stripped)) return undefined;

  const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0;
  return (stripped.length / 4) * 3 - padding;
}
