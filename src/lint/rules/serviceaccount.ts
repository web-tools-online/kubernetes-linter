import { isDNS1123Subdomain, suggestName } from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const SERVICE_ACCOUNT_DOCS = 'https://kubernetes.io/docs/concepts/security/service-accounts/';
const IMAGE_PULL_DOCS =
  'https://kubernetes.io/docs/concepts/containers/images/#specifying-imagepullsecrets-on-a-pod';
const MOUNTABLE_SECRETS_DOCS =
  'https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#enforce-mountable-secrets';

/**
 * The annotation the ServiceAccount admission plugin reads to decide whether
 * `secrets` is a permission list or merely a note. Nothing validates it — it
 * is an annotation — so both checks below are about what the plugin makes of
 * the value rather than about the apiserver accepting it.
 */
const ENFORCE_MOUNTABLE_SECRETS_ANNOTATION = 'kubernetes.io/enforce-mountable-secrets';

/** The release whose apiserver started warning that the annotation is deprecated. */
const ENFORCE_MOUNTABLE_SECRETS_DEPRECATED_IN = 32;

/**
 * Every field an ObjectReference has besides `name`. PrepareForCreate rewrites
 * each `secrets` entry to `ObjectReference{Name: ...}` before validation runs,
 * so all six are dropped on the way in.
 */
const IGNORED_REFERENCE_FIELDS = [
  'kind',
  'namespace',
  'uid',
  'apiVersion',
  'resourceVersion',
  'fieldPath',
] as const;

/**
 * The checks worth making on a ServiceAccount. It is the kind with the least
 * apiserver validation of any here: ValidateServiceAccount in
 * pkg/apis/core/validation checks the object's metadata and nothing else — not
 * `secrets`, not `imagePullSecrets`, not `automountServiceAccountToken` — so
 * `meta/*` already covers everything that can actually be rejected, and there
 * is not one error-severity finding in this module.
 *
 * What is left is the gap between what a manifest can say and what the cluster
 * does with it, which for this kind is unusually wide. Two mechanisms account
 * for all of it:
 *
 * - The registry's PrepareForCreate calls `cleanSecretReferences`, replacing
 *   every `secrets` entry with just its name. A namespace, a kind or a uid
 *   written beside it is discarded silently — the object is stored, and stored
 *   differently from what was applied.
 * - The `kubernetes.io/enforce-mountable-secrets` annotation is read with
 *   `strconv.ParseBool`, whose error the plugin discards, so a value it cannot
 *   parse leaves enforcement quietly off rather than failing loudly.
 *
 * Like a ConfigMap or a Secret it has no `spec` at all — `secrets`,
 * `imagePullSecrets` and `automountServiceAccountToken` hang directly off the
 * document — so this module addresses `ctx.doc`, and it describes no Pod, so
 * none of the shared PodSpec rules apply. `automountServiceAccountToken` is a
 * bare bool with no constraint on it beyond its type, which is layer 1's, and
 * the kind has no enum field at all, so it adds nothing to `rules/enums.ts`.
 *
 * Duplicates are deliberately checked in `imagePullSecrets` only. Upstream
 * declares `secrets` an `x-kubernetes-list-type: map` keyed by name from 1.30
 * on, which layer 1 already reports as `schema/duplicate-list-entry`, so
 * checking it here would double-report on exactly the versions that describe
 * it; below 1.30 upstream simply says nothing about the list and neither do
 * we — that split is pinned in `tests/versions.test.ts` rather than papered
 * over, as upstream's NetworkPolicy drift is. `imagePullSecrets` is atomic on
 * every version, so layer 1 never dedupes it and this module always does.
 */
export const serviceAccountRule: Rule = {
  id: 'serviceaccount/fields',
  run(ctx: RuleContext) {
    checkSecrets(ctx);
    checkImagePullSecrets(ctx);
    checkEnforceMountableSecrets(ctx);
  },
};

/* secrets */

/**
 * The Secrets a Pod using this ServiceAccount may mount — but only when the
 * enforce-mountable-secrets annotation is on; otherwise the list is a note to
 * the reader and nothing consults it. Either way only the name survives being
 * stored.
 */
function checkSecrets(ctx: RuleContext): void {
  const secrets = asArray(ctx.doc['secrets']);
  if (!secrets) return;

  secrets.forEach((entry, index) => {
    const reference = asObject(entry);
    if (!reference) return;
    const base: Path = ['secrets', index];

    for (const field of IGNORED_REFERENCE_FIELDS) {
      if (reference[field] === undefined) continue;

      ctx.report({
        ruleId: 'serviceaccount/ignored-secret-field',
        severity: 'warning',
        path: [...base, field],
        message:
          field === 'namespace'
            ? 'namespace is discarded: a ServiceAccount can only reference Secrets in its own namespace.'
            : `${field} is discarded: only the name of a secrets entry is stored.`,
        explanation:
          'The apiserver rewrites every entry in this list to just its name before the object is validated, let alone stored, so anything written beside the name is dropped without a word — the object is created, and it is not the object that was applied. The list means "Secrets in this namespace", and a name is all it takes to say that.',
        docsUrl: SERVICE_ACCOUNT_DOCS,
        fix: {
          // The apiserver deletes this itself; doing it here only makes the
          // manifest say what the cluster will end up holding.
          title: `Remove ${field}`,
          safe: true,
          ops: [{ op: 'delete', path: [...base, field] }],
        },
      });
    }

    checkReferenceName(ctx, reference, base, 'secrets');
  });
}

/* imagePullSecrets */

/**
 * The registry credentials the kubelet pulls with for every Pod using this
 * ServiceAccount. A LocalObjectReference carries a name and nothing else, so
 * layer 1 covers the shape of an entry and only the name itself is left —
 * plus duplicates, which nothing else looks for on an atomic list.
 */
function checkImagePullSecrets(ctx: RuleContext): void {
  const secrets = asArray(ctx.doc['imagePullSecrets']);
  if (!secrets) return;

  const seen = new Map<string, number>();

  secrets.forEach((entry, index) => {
    const reference = asObject(entry);
    if (!reference) return;
    const base: Path = ['imagePullSecrets', index];

    const name = checkReferenceName(ctx, reference, base, 'imagePullSecrets');
    if (name === undefined) return;

    const first = seen.get(name);
    if (first === undefined) {
      seen.set(name, index);
      return;
    }

    ctx.report({
      ruleId: 'serviceaccount/duplicate-image-pull-secret',
      severity: 'warning',
      path: [...base, 'name'],
      message: `"${name}" is already listed by entry ${first + 1}.`,
      explanation:
        'The kubelet collects these into a set before it pulls, so naming the same Secret twice adds no credential and changes no order — it is redundant rather than wrong, which is why the apiserver stores it without complaint.',
      docsUrl: IMAGE_PULL_DOCS,
      fix: {
        title: 'Remove the duplicate entry',
        safe: true,
        ops: [{ op: 'delete', path: base }],
      },
    });
  });
}

/* Shared: the name both lists reference a Secret by */

/**
 * Both lists point at a Secret in this namespace by name, so both are wrong in
 * the same two ways. Returns the name when there is a usable one, so a caller
 * can go on to compare it with the others.
 */
function checkReferenceName(
  ctx: RuleContext,
  reference: Record<string, unknown>,
  base: Path,
  field: 'secrets' | 'imagePullSecrets',
): string | undefined {
  const docsUrl = field === 'secrets' ? SERVICE_ACCOUNT_DOCS : IMAGE_PULL_DOCS;
  const name = asString(reference['name']);

  if (name === undefined || name === '') {
    ctx.report({
      ruleId: 'serviceaccount/missing-secret-name',
      severity: 'warning',
      path: name === undefined ? base : [...base, 'name'],
      ...(name === undefined ? { anchor: 'key' as const } : {}),
      message: `This ${field} entry names no Secret.`,
      explanation:
        'Nothing rejects the entry — a ServiceAccount\'s references are not validated at all, and no controller resolves them until a Pod needs one — so an entry with no name is stored and then matches nothing for the life of the object.',
      docsUrl,
    });
    return undefined;
  }

  const check = isDNS1123Subdomain(name);
  if (!check.ok) {
    const suggestion = suggestName(name);
    ctx.report({
      ruleId: 'serviceaccount/invalid-secret-name',
      severity: 'warning',
      path: [...base, 'name'],
      message: `No Secret can be named "${name}": it ${check.reason}.`,
      explanation:
        'A Secret\'s own name is a DNS subdomain, so a reference that is not one cannot ever resolve, whatever is created alongside it. The apiserver does not check a ServiceAccount\'s references, so this is stored as written and only surfaces when a Pod fails to start.',
      docsUrl,
      fix: suggestion
        ? {
            // Which Secret was meant is a guess: the name here has to match an
            // object elsewhere, and correcting the spelling of a reference
            // cannot be done by looking at this document alone.
            title: `Change to "${suggestion}"`,
            safe: false,
            ops: [{ op: 'set', path: [...base, 'name'], value: suggestion }],
          }
        : undefined,
    });
    return undefined;
  }

  return name;
}

/* The enforce-mountable-secrets annotation */

/**
 * The annotation that turns `secrets` into a permission list. Two things can
 * be said about it, and which apply are independent: the plugin may not
 * understand the value, and from 1.32 the apiserver deprecates the mechanism
 * whatever the value is.
 */
function checkEnforceMountableSecrets(ctx: RuleContext): void {
  const annotations = asObject(asObject(ctx.doc['metadata'])?.['annotations']);
  if (!annotations || !(ENFORCE_MOUNTABLE_SECRETS_ANNOTATION in annotations)) return;

  const path: Path = ['metadata', 'annotations', ENFORCE_MOUNTABLE_SECRETS_ANNOTATION];
  // A non-string value is layer 1's: annotations are map[string]string.
  const value = asString(annotations[ENFORCE_MOUNTABLE_SECRETS_ANNOTATION]);

  if (value !== undefined && parseGoBool(value) === undefined) {
    const normalised = value.trim().toLowerCase();
    const intended = normalised === 'true' || normalised === 'false' ? normalised : undefined;

    ctx.report({
      ruleId: 'serviceaccount/invalid-enforce-mountable-secrets',
      severity: 'warning',
      path,
      message: `"${value}" does not enable mountable-secret enforcement; it reads as off.`,
      explanation:
        'The admission plugin parses this with Go\'s strconv.ParseBool and throws the error away, so a value it cannot read is not a mistake it reports but a false — "yes", "on" and "enabled" all leave every Secret in the namespace mountable by these Pods, which is the opposite of what writing the annotation was meant to do. It accepts "true", "false", "t", "f", "T", "F", "1", "0", and the all-caps and capitalised spellings of the two words.',
      docsUrl: MOUNTABLE_SECRETS_DOCS,
      // "TRue" or " true " differ from a spelling ParseBool accepts only in
      // case and spacing; "yes" is a guess at intent and gets no fix.
      fix: intended
        ? {
            title: `Change to "${intended}"`,
            safe: true,
            ops: [{ op: 'set', path, value: intended }],
          }
        : undefined,
    });
  }

  // The one version-conditional check in the codebase that `ctx.supports()`
  // cannot express: an annotation is not a schema field, so its presence in a
  // version's closure says nothing. Reporting this below 1.32 would be plainly
  // wrong rather than merely early — the mechanism is current there, and the
  // apiserver returns no warning of its own.
  // Written as the positive test so an unparseable version says nothing
  // rather than reporting: NaN fails the comparison either way round.
  if (!(minorVersion(ctx.schema.version) >= ENFORCE_MOUNTABLE_SECRETS_DEPRECATED_IN)) return;

  ctx.report({
    ruleId: 'serviceaccount/deprecated-enforce-mountable-secrets',
    severity: 'warning',
    path,
    anchor: 'key',
    message: `This annotation is deprecated as of Kubernetes 1.32 — you are linting against ${ctx.schema.version}.`,
    explanation:
      'The apiserver returns this as a warning on the response to creating or updating the ServiceAccount: "deprecated in v1.32+; prefer separate namespaces to isolate access to mounted secrets". It still works, and there is no removal date — the objection is to the design, since a list of permitted Secrets has to be kept in step with the Secrets themselves by hand, where a namespace boundary keeps itself.',
    docsUrl: MOUNTABLE_SECRETS_DOCS,
  });
}

/**
 * Go's strconv.ParseBool: exactly twelve spellings, and not case-insensitive
 * beyond them — "tRue" is an error there and so is undefined here.
 */
function parseGoBool(value: string): boolean | undefined {
  switch (value) {
    case '1':
    case 't':
    case 'T':
    case 'true':
    case 'TRUE':
    case 'True':
      return true;
    case '0':
    case 'f':
    case 'F':
    case 'false':
    case 'FALSE':
    case 'False':
      return false;
    default:
      return undefined;
  }
}

/** The minor of the version being linted against: "1.36" -> 36. */
function minorVersion(version: string): number {
  return Number.parseInt(version.split('.')[1] ?? '', 10);
}
