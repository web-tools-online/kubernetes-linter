import { decodeBase64, decodedByteLength, MAX_SECRET_SIZE_BYTES } from '../../k8s/base64.js';
import { isConfigMapKey, isRelativePathKey } from '../../k8s/names.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const SECRET_DOCS = 'https://kubernetes.io/docs/concepts/configuration/secret/';
const TYPES_DOCS = `${SECRET_DOCS}#secret-types`;
const MOUNT_DOCS = `${SECRET_DOCS}#using-secrets-as-files-from-a-pod`;

const TYPE_OPAQUE = 'Opaque';
const TYPE_SERVICE_ACCOUNT_TOKEN = 'kubernetes.io/service-account-token';
const TYPE_DOCKERCFG = 'kubernetes.io/dockercfg';
const TYPE_DOCKERCONFIGJSON = 'kubernetes.io/dockerconfigjson';
const TYPE_BASIC_AUTH = 'kubernetes.io/basic-auth';
const TYPE_SSH_AUTH = 'kubernetes.io/ssh-auth';
const TYPE_TLS = 'kubernetes.io/tls';

const SERVICE_ACCOUNT_NAME_ANNOTATION = 'kubernetes.io/service-account.name';

/**
 * The types ValidateSecret itself knows the shape of. Everything else — a
 * Helm release, a bootstrapping controller's own type — is a legal type of
 * its own and checked no further than the fields every Secret has.
 */
const WELL_KNOWN_TYPES = [
  TYPE_OPAQUE,
  TYPE_SERVICE_ACCOUNT_TOKEN,
  TYPE_DOCKERCFG,
  TYPE_DOCKERCONFIGJSON,
  TYPE_BASIC_AUTH,
  TYPE_SSH_AUTH,
  TYPE_TLS,
];

interface KeyEntry {
  source: 'data' | 'stringData';
  value: string;
}

/**
 * The checks the apiserver runs on a Secret, from ValidateSecret in
 * pkg/apis/core/validation. Structurally its closest sibling is ConfigMap: no
 * `spec` at all, so this module addresses `ctx.doc` directly, and it describes
 * no Pod, so none of the shared PodSpec rules apply.
 *
 * Validation runs on the *merged* object: the conversion from v1 to the
 * internal type folds stringData into data, with stringData's value winning
 * on a shared key, before anything below is checked — so a key's format, the
 * combined size, and every type-specific required-key check all read that
 * merged view rather than either map alone. A key claimed by both is not
 * itself rejected, unlike a ConfigMap's data/binaryData: it is a warning here
 * rather than an error, since stringData silently wins rather than the
 * apiserver refusing the object.
 *
 * The schema layer covers what it can: the two maps are `map[string]string`,
 * so a value written as a bare number is layer 1's, as is a `data` value that
 * is not base64 at all (`format: byte`; `stringData` carries no such format,
 * since it is plain text on the wire, not bytes). Nothing is required — an
 * empty Opaque Secret is valid — so what is left is what OpenAPI cannot
 * express: key format, the combined size cap, and the handful of well-known
 * types whose `type` value requires specific keys to be present.
 *
 * `type` is deliberately not in `rules/enums.ts`: arbitrary third-party types
 * are legal, so a near-miss of a well-known one is reported as a warning with
 * a "did you mean" rather than an error.
 *
 * Deliberately skipped: the immutability of data/stringData once
 * `immutable: true` is set, which — like a ConfigMap's — only constrains an
 * update; and the internal structure of a type ValidateSecret does not itself
 * check, such as `bootstrap.kubernetes.io/token`, which is validated by the
 * bootstrap controller rather than by this function.
 *
 * Nothing is version-gated: data, stringData, type and immutable have all
 * been part of core/v1 Secret since well before the 1.25 floor.
 */
export const secretRule: Rule = {
  id: 'secret/fields',
  run(ctx: RuleContext) {
    const data = asObject(ctx.doc['data']) ?? {};
    const stringData = asObject(ctx.doc['stringData']) ?? {};
    const merged = new Map<string, KeyEntry>();

    for (const [key, value] of Object.entries(data)) {
      checkKey(ctx, key, ['data']);
      const str = asString(value);
      if (str !== undefined) merged.set(key, { source: 'data', value: str });
    }

    for (const [key, value] of Object.entries(stringData)) {
      checkKey(ctx, key, ['stringData']);
      const str = asString(value);
      if (str === undefined) continue;

      if (merged.has(key)) {
        ctx.report({
          ruleId: 'secret/overlapping-key',
          severity: 'warning',
          path: ['stringData', key],
          anchor: 'key',
          message: `"${key}" is also a key in data; the stringData value silently wins.`,
          explanation:
            'The apiserver merges stringData into data before storing the object, overwriting whatever value data already has for the same key — unlike a ConfigMap, where the same overlap between data and binaryData is rejected outright. Nothing stops this Secret being created, but the data entry is never actually stored, so it is worth removing.',
          docsUrl: SECRET_DOCS,
        });
      }
      merged.set(key, { source: 'stringData', value: str });
    }

    checkSize(ctx, merged);
    checkType(ctx, merged);
  },
};

/**
 * A key has to survive being both a filename and an environment variable
 * name, exactly as a ConfigMap's does — the apiserver checks a Secret's keys
 * with the very same IsConfigMapKey.
 */
function checkKey(ctx: RuleContext, key: string, base: Path): void {
  const path: Path = [...base, key];

  if (isRelativePathKey(key)) {
    ctx.report({
      ruleId: 'secret/relative-path-key',
      severity: 'error',
      path,
      anchor: 'key',
      message: `"${key}" cannot be a key: it names a path rather than a file.`,
      explanation:
        'Mounting a Secret writes one file per key into the volume, so "." would be the directory itself, ".." its parent, and a key starting with ".." a file outside the mount altogether. The apiserver refuses all three rather than let a key escape the directory it is projected into.',
      docsUrl: MOUNT_DOCS,
    });
    return;
  }

  const check = isConfigMapKey(key);
  if (check.ok) return;

  const suggestion = suggestKey(key);
  ctx.report({
    ruleId: 'secret/invalid-key',
    severity: 'error',
    path,
    anchor: 'key',
    message: `"${key}" is not a valid Secret key: it ${check.reason}.`,
    explanation:
      'Keys become filenames when the Secret is mounted and environment variable names when it is consumed through envFrom, so they are limited to alphanumerics, "-", "_" and "." — no spaces, and no "/" to imply a directory.',
    docsUrl: SECRET_DOCS,
    fix: suggestion
      ? {
          // Renaming a key changes what every Pod referring to it has to ask
          // for, so this is never applied unattended.
          title: `Rename to "${suggestion}"`,
          safe: false,
          ops: [{ op: 'rename', path, to: suggestion }],
        }
      : undefined,
  });
}

/**
 * Replace each run of characters a key may not carry with "_" — the separator
 * the allowed set leaves for the job. Only offered when the result is a key
 * that would actually pass.
 */
function suggestKey(key: string): string | undefined {
  const candidate = key.trim().replace(/[^-._a-zA-Z0-9]+/g, '_');
  return candidate !== key && isConfigMapKey(candidate).ok && !isRelativePathKey(candidate)
    ? candidate
    : undefined;
}

function checkSize(ctx: RuleContext, merged: Map<string, KeyEntry>): void {
  let bytes = 0;
  for (const entry of merged.values()) {
    // A value that fails to decode at all is layer 1's problem already
    // (schema/base64) and contributes nothing measurable here.
    bytes += entry.source === 'stringData' ? utf8Length(entry.value) : (decodedByteLength(entry.value) ?? 0);
  }

  if (bytes > MAX_SECRET_SIZE_BYTES) {
    ctx.report({
      ruleId: 'secret/too-large',
      severity: 'error',
      // Upstream reports this against the object rather than either map,
      // since it is the two together, post-merge, that are over the cap.
      path: [],
      message: `data and stringData total ${formatBytes(bytes)}, over the ${formatBytes(MAX_SECRET_SIZE_BYTES)} limit.`,
      explanation:
        'Every Secret a node needs is held in the kubelet\'s memory and re-sent on every watch event, so the apiserver caps one at 1 MiB — the same cap a ConfigMap has, measured the same way: both maps combined, after stringData has overwritten any key it shares with data.',
      docsUrl: SECRET_DOCS,
    });
  }
}

/**
 * Non-empty *decoded* content for a key, mirroring Go's
 * `len(secret.Data[key]) == 0` — the internal representation is already
 * decoded bytes, so a data-sourced key's length is measured after decoding,
 * not the length of its base64 text. A value that fails to decode at all is
 * layer 1's problem already (schema/base64), so it is treated as present
 * here rather than reported a second time under a different rule id.
 */
function hasContent(merged: Map<string, KeyEntry>, key: string): boolean {
  const entry = merged.get(key);
  if (!entry) return false;
  if (entry.source === 'stringData') return entry.value.length > 0;

  const length = decodedByteLength(entry.value);
  return length === undefined || length > 0;
}

function checkType(ctx: RuleContext, merged: Map<string, KeyEntry>): void {
  const type = asString(ctx.doc['type']);
  if (!type) return;

  switch (type) {
    case TYPE_OPAQUE:
      return;
    case TYPE_SERVICE_ACCOUNT_TOKEN:
      checkServiceAccountToken(ctx);
      return;
    case TYPE_DOCKERCFG:
      checkDockerConfig(ctx, merged, TYPE_DOCKERCFG, '.dockercfg');
      return;
    case TYPE_DOCKERCONFIGJSON:
      checkDockerConfig(ctx, merged, TYPE_DOCKERCONFIGJSON, '.dockerconfigjson');
      return;
    case TYPE_BASIC_AUTH:
      checkBasicAuth(ctx, merged);
      return;
    case TYPE_SSH_AUTH:
      checkSSHAuth(ctx, merged);
      return;
    case TYPE_TLS:
      checkTLS(ctx, merged);
      return;
    default:
      checkUnknownType(ctx, type);
  }
}

/** kubernetes.io/service-account-token, the type the token controller reads. */
function checkServiceAccountToken(ctx: RuleContext): void {
  const annotations = asObject(asObject(ctx.doc['metadata'])?.['annotations']);
  const name = asString(annotations?.[SERVICE_ACCOUNT_NAME_ANNOTATION]);
  if (name) return;

  ctx.report({
    ruleId: 'secret/missing-service-account-name',
    severity: 'error',
    path: ['metadata', 'annotations', SERVICE_ACCOUNT_NAME_ANNOTATION],
    message: `A Secret of type ${TYPE_SERVICE_ACCOUNT_TOKEN} must carry a non-empty "${SERVICE_ACCOUNT_NAME_ANNOTATION}" annotation.`,
    explanation:
      'The annotation names the ServiceAccount this token authenticates as; the token controller reads it to populate the token, and the apiserver rejects the Secret without it.',
    docsUrl: `${TYPES_DOCS}-service-account-token-secrets`,
  });
}

/** kubernetes.io/basic-auth: at least one of the two credential keys is required, non-empty. */
function checkBasicAuth(ctx: RuleContext, merged: Map<string, KeyEntry>): void {
  if (hasContent(merged, 'username') || hasContent(merged, 'password')) return;

  ctx.report({
    ruleId: 'secret/missing-basic-auth-key',
    severity: 'error',
    path: ['data'],
    message: `A Secret of type ${TYPE_BASIC_AUTH} must carry a non-empty "username" or "password" key.`,
    explanation:
      'At least one of the two is required — the apiserver rejects a basic-auth Secret carrying neither, or carrying both as empty strings.',
    docsUrl: `${TYPES_DOCS}-basic-authentication-secret`,
  });
}

/** kubernetes.io/ssh-auth: the private key is required, non-empty. */
function checkSSHAuth(ctx: RuleContext, merged: Map<string, KeyEntry>): void {
  if (hasContent(merged, 'ssh-privatekey')) return;

  ctx.report({
    ruleId: 'secret/missing-ssh-key',
    severity: 'error',
    path: ['data', 'ssh-privatekey'],
    message: `A Secret of type ${TYPE_SSH_AUTH} must carry a non-empty "ssh-privatekey" key.`,
    explanation: 'The apiserver rejects an ssh-auth Secret with no private key, or one whose value is empty.',
    docsUrl: `${TYPES_DOCS}-ssh-authentication-secrets`,
  });
}

/**
 * kubernetes.io/tls: both keys are required, but only their presence —
 * unlike basic-auth and ssh-auth, an empty tls.crt or tls.key passes.
 */
function checkTLS(ctx: RuleContext, merged: Map<string, KeyEntry>): void {
  for (const key of ['tls.crt', 'tls.key']) {
    if (merged.has(key)) continue;

    ctx.report({
      ruleId: 'secret/missing-tls-key',
      severity: 'error',
      path: ['data', key],
      message: `A Secret of type ${TYPE_TLS} must carry a "${key}" key.`,
      explanation: 'The apiserver requires both "tls.crt" and "tls.key" to be present — empty is allowed, absent is not.',
      docsUrl: `${TYPES_DOCS}-tls-secrets`,
    });
  }
}

/**
 * kubernetes.io/dockercfg and kubernetes.io/dockerconfigjson: the one key
 * each carries is required, non-empty, and has to decode into a JSON object —
 * the kubelet parses it to read registry credentials out of it.
 */
function checkDockerConfig(ctx: RuleContext, merged: Map<string, KeyEntry>, type: string, key: string): void {
  if (!hasContent(merged, key)) {
    ctx.report({
      ruleId: 'secret/missing-docker-config',
      severity: 'error',
      path: ['data', key],
      message: `A Secret of type ${type} must carry a non-empty "${key}" key.`,
      explanation: 'The apiserver rejects the Secret without it, since there is nothing for the kubelet to hand the container runtime.',
      docsUrl: `${TYPES_DOCS}-docker-config-secrets`,
    });
    return;
  }

  const entry = merged.get(key)!;
  const content = entry.source === 'stringData' ? entry.value : decodeBase64(entry.value);
  // Undecodable base64 is layer 1's problem already (schema/base64); there is
  // no content here to say anything further about.
  if (content === undefined) return;

  if (!isJSONObjectOrNull(content)) {
    ctx.report({
      ruleId: 'secret/invalid-docker-config',
      severity: 'error',
      path: ['data', key],
      message: `"${key}" does not decode to a JSON object.`,
      explanation:
        'The kubelet parses this value as JSON to read the registry credentials out of it, so anything else — an array, a bare string, malformed JSON — fails at image pull time rather than when the Secret is applied.',
      docsUrl: `${TYPES_DOCS}-docker-config-secrets`,
    });
  }
}

/** Go's json.Unmarshal into a map/struct target: null is accepted, arrays and scalars are not. */
function isJSONObjectOrNull(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  return parsed === null || (typeof parsed === 'object' && !Array.isArray(parsed));
}

/**
 * A type outside the well-known set is legal — this is only a nudge for the
 * case where it looks like a typo of one of them rather than a deliberate
 * type of its own.
 */
function checkUnknownType(ctx: RuleContext, type: string): void {
  const suggestion = didYouMean(type, WELL_KNOWN_TYPES);
  if (!suggestion) return;

  ctx.report({
    ruleId: 'secret/unknown-type',
    severity: 'warning',
    path: ['type'],
    message: `"${type}" is close to the well-known type "${suggestion}" — is that what was meant?`,
    explanation:
      'Kubernetes reserves several "kubernetes.io/" type strings, each with its own required keys; anything else is a legal type of your own, checked no further than the fields every Secret has. This one is close enough to a well-known spelling that it reads as a typo rather than a deliberate custom type.',
    docsUrl: TYPES_DOCS,
    fix: {
      title: `Change to "${suggestion}"`,
      safe: true,
      ops: [{ op: 'set', path: ['type'], value: suggestion }],
    },
  });
}

/** What the apiserver measures: the value's length in bytes, not characters. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes} bytes`;
}
