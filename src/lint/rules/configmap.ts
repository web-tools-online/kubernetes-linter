import { decodedByteLength, MAX_SECRET_SIZE_BYTES } from '../../k8s/base64.js';
import { isConfigMapKey, isRelativePathKey } from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const CONFIGMAP_DOCS = 'https://kubernetes.io/docs/concepts/configuration/configmap/';
const MOUNT_DOCS =
  'https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/#populate-a-volume-with-data-stored-in-a-configmap';

/**
 * The checks the apiserver runs on a ConfigMap, from ValidateConfigMap in
 * pkg/apis/core/validation. Like a StorageClass it has no `spec` at all — data,
 * binaryData and immutable hang directly off the document — and like a Service
 * it describes no Pod, so none of the shared PodSpec rules apply.
 *
 * The schema layer covers a great deal here for once, because there is so
 * little to cover: the two maps are `map[string]string`, so a value written as
 * a bare number or a nested mapping is layer 1's, as is a binaryData value that
 * is not base64 at all (`format: byte`). Nothing is required, since an empty
 * ConfigMap is valid — it is the keys, not the fields, that carry the rules.
 *
 * What is left is what OpenAPI cannot express: the format of a key, the two
 * maps not overlapping, and the total size of everything in them.
 *
 * Deliberately skipped: the immutability of data and binaryData once
 * `immutable: true` has been applied, which — like a StorageClass's
 * provisioner — only constrains an update, and so says nothing about the
 * manifest in front of us.
 *
 * Nothing is version-gated: core/v1 ConfigMap has carried these three fields
 * since well before the 1.25 floor, binaryData and immutable included.
 */
export const configMapRule: Rule = {
  id: 'configmap/fields',
  run(ctx: RuleContext) {
    const data = asObject(ctx.doc['data']);
    const binaryData = asObject(ctx.doc['binaryData']);
    let bytes = 0;

    for (const [key, value] of Object.entries(data ?? {})) {
      checkKey(ctx, key, ['data']);

      if (binaryData && key in binaryData) {
        ctx.report({
          ruleId: 'configmap/duplicate-key',
          severity: 'error',
          path: ['data', key],
          anchor: 'key',
          message: `"${key}" is also a key in binaryData.`,
          explanation:
            'The two maps are projected into one namespace of keys — one file per key when the ConfigMap is mounted, one variable per key when it is consumed through envFrom — so a key can only come from one of them. The apiserver rejects the object rather than pick a winner. Keep the entry in binaryData for a value with bytes outside UTF-8, and in data otherwise.',
          docsUrl: CONFIGMAP_DOCS,
        });
      }

      bytes += utf8Length(asString(value) ?? '');
    }

    for (const [key, value] of Object.entries(binaryData ?? {})) {
      checkKey(ctx, key, ['binaryData']);
      // A value that is not decodable at all is layer 1's, through the
      // `format: byte` on this map, and contributes nothing measurable here.
      bytes += decodedByteLength(asString(value) ?? '') ?? 0;
    }

    if (bytes > MAX_SECRET_SIZE_BYTES) {
      ctx.report({
        ruleId: 'configmap/too-large',
        severity: 'error',
        // Upstream reports this against the object rather than either map,
        // since it is the two together that are over the cap.
        path: [],
        message: `data and binaryData total ${formatBytes(bytes)}, over the ${formatBytes(MAX_SECRET_SIZE_BYTES)} limit.`,
        explanation:
          'Every ConfigMap a node needs is held in the kubelet\'s memory and re-sent on every watch event, so the apiserver caps one at 1 MiB — the same cap a Secret has. Something this large is usually a file that belongs in an image, a volume, or an object store the Pod reads at startup instead.',
        docsUrl: CONFIGMAP_DOCS,
      });
    }
  },
};

/**
 * A key has to survive being a filename, since mounting the ConfigMap writes
 * one file per key — which is why the character set is narrower than a label
 * key's and why the three relative-path spellings are refused outright.
 */
function checkKey(ctx: RuleContext, key: string, base: Path): void {
  const path: Path = [...base, key];

  if (isRelativePathKey(key)) {
    ctx.report({
      ruleId: 'configmap/relative-path-key',
      severity: 'error',
      path,
      anchor: 'key',
      message: `"${key}" cannot be a key: it names a path rather than a file.`,
      explanation:
        'Mounting a ConfigMap writes one file per key into the volume, so "." would be the directory itself, ".." its parent, and a key starting with ".." a file outside the mount altogether. The apiserver refuses all three rather than let a key escape the directory it is projected into.',
      docsUrl: MOUNT_DOCS,
    });
    return;
  }

  const check = isConfigMapKey(key);
  if (check.ok) return;

  const suggestion = suggestKey(key);
  ctx.report({
    ruleId: 'configmap/invalid-key',
    severity: 'error',
    path,
    anchor: 'key',
    message: `"${key}" is not a valid ConfigMap key: it ${check.reason}.`,
    explanation:
      'Keys become filenames when the ConfigMap is mounted and environment variable names when it is consumed through envFrom, so they are limited to alphanumerics, "-", "_" and "." — no spaces, and no "/" to imply a directory. Nest a path under a single key\'s value instead, or use "_" where a separator is wanted.',
    docsUrl: CONFIGMAP_DOCS,
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

/** What the apiserver measures: the value's length in bytes, not characters. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes} bytes`;
}
