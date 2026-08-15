import { isQualifiedName } from '../../k8s/names.js';
import { parseQuantity } from '../../k8s/quantity.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const QUOTA_DOCS = 'https://kubernetes.io/docs/concepts/policy/resource-quotas/';
const SCOPE_DOCS = 'https://kubernetes.io/docs/concepts/policy/resource-quotas/#quota-scopes';

/**
 * standardQuotaResources from pkg/apis/core/helper: the unprefixed names a
 * quota may bound. It is not the same set as a container's — a quota counts
 * objects as well as compute, and spells the compute ones three ways
 * ("cpu" is shorthand for "requests.cpu") — so it is written out here rather
 * than shared with `rules/resources.ts`.
 */
const STANDARD_QUOTA_RESOURCES = [
  'cpu', 'memory', 'ephemeral-storage',
  'requests.cpu', 'requests.memory', 'requests.storage', 'requests.ephemeral-storage',
  'limits.cpu', 'limits.memory', 'limits.ephemeral-storage',
  'pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps',
  'persistentvolumeclaims', 'services.nodeports', 'services.loadbalancers',
];

/**
 * integerResources from the same file: a count of objects cannot be
 * fractional. Extended resources are integer-valued too, which
 * `isIntegerResource` adds.
 */
const OBJECT_COUNT_RESOURCES = [
  'pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps',
  'persistentvolumeclaims', 'services.nodeports', 'services.loadbalancers',
];

/** podComputeQuotaResources: what a Pod-scoped quota may bound beyond "pods". */
const POD_COMPUTE_RESOURCES = [
  'cpu', 'memory', 'requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory',
];

const SCOPES = [
  'Terminating',
  'NotTerminating',
  'BestEffort',
  'NotBestEffort',
  'PriorityClass',
  'CrossNamespacePodAffinity',
];

/** Two scopes that select complementary sets of Pods select nothing together. */
const CONFLICTING_SCOPES: [string, string][] = [
  ['Terminating', 'NotTerminating'],
  ['BestEffort', 'NotBestEffort'],
];

/**
 * The checks the apiserver runs on a ResourceQuota, from ValidateResourceQuota
 * in pkg/apis/core/validation. Like a Service it describes no Pod, so none of
 * the shared PodSpec rules apply.
 *
 * ResourceQuotaSpec has no required fields and its two maps are
 * `map[string]Quantity`, so layer 1 covers only the shape of a value — a
 * quantity that is not a quantity at all is `schema/quantity`, and the
 * scope selector's `scopeName`/`operator` are plain scalar enums and live in
 * `rules/enums.ts`. `spec.scopes` cannot: it is a list of enum strings rather
 * than a scalar, exactly like a NetworkPolicy's `policyTypes`, so it is checked
 * here.
 *
 * What is left is what OpenAPI cannot express: which resource names a quota may
 * bound (a narrower set than a container's, since a quota counts objects too),
 * which of those must be whole numbers, and the several ways a scope can
 * contradict another scope or the resources beside it.
 *
 * Deliberately skipped: `status`, whose `hard` and `used` are written by the
 * quota controller rather than by the manifest in front of us.
 *
 * Nothing is version-gated: core/v1 ResourceQuota has carried `hard`, `scopes`
 * and `scopeSelector` since well before the 1.25 floor.
 */
export const resourceQuotaRule: Rule = {
  id: 'resourcequota/fields',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']) ?? {};
    const hard = asObject(spec['hard']);

    for (const [name, value] of Object.entries(hard ?? {})) {
      checkResourceName(ctx, name);
      checkQuantity(ctx, name, value);
    }

    const bounded = Object.keys(hard ?? {});
    checkScopes(ctx, asArray(spec['scopes']), bounded);
    checkScopeSelector(ctx, asObject(spec['scopeSelector']), bounded);
  },
};

/* hard */

/**
 * A quota key is a resource name, but a narrower one than a container's: an
 * unprefixed name has to be a resource the quota system itself knows how to
 * count, since there is nothing generic to count for an arbitrary one.
 */
function checkResourceName(ctx: RuleContext, name: string): void {
  const path: Path = ['spec', 'hard', name];

  const check = isQualifiedName(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'resourcequota/invalid-resource-name',
      severity: 'error',
      path,
      anchor: 'key',
      message: `"${name}" is not a valid resource name: it ${check.reason}.`,
      explanation:
        'A quota key is a resource name: a qualified name, optionally prefixed with a DNS subdomain and "/". "count/deployments.apps" and "requests.nvidia.com/gpu" are both spelled that way.',
      docsUrl: QUOTA_DOCS,
    });
    return;
  }

  // A prefixed name is an extended resource or a "count/<resource>.<group>"
  // key, both of which the quota system counts generically.
  if (name.includes('/') || STANDARD_QUOTA_RESOURCES.includes(name)) return;

  const suggestion = didYouMean(name, STANDARD_QUOTA_RESOURCES);
  ctx.report({
    ruleId: 'resourcequota/unknown-resource-name',
    severity: 'error',
    path,
    anchor: 'key',
    message: suggestion
      ? `"${name}" is not a resource a quota can bound. Did you mean "${suggestion}"?`
      : `"${name}" is not a resource a quota can bound.`,
    explanation: `Unprefixed keys are limited to the resources the quota system counts natively: ${STANDARD_QUOTA_RESOURCES.join(', ')} and hugepages-<size>. Anything else needs a domain prefix ("nvidia.com/gpu") or the generic object counter ("count/deployments.apps").`,
    docsUrl: QUOTA_DOCS,
    fix: suggestion
      ? { title: `Rename to "${suggestion}"`, safe: true, ops: [{ op: 'rename', path, to: suggestion }] }
      : undefined,
  });
}

/**
 * A quota is a ceiling, so a negative one bounds nothing; and a ceiling on a
 * number of objects has to be a whole number, since half a Pod cannot exist.
 * A value that is not a quantity at all is layer 1's, through the Quantity
 * scalar check.
 */
function checkQuantity(ctx: RuleContext, name: string, raw: unknown): void {
  const quantity = parseQuantity(raw);
  if (!quantity.ok || quantity.value === undefined) return;

  const path: Path = ['spec', 'hard', name];

  if (quantity.value < 0) {
    ctx.report({
      ruleId: 'resourcequota/negative-quantity',
      severity: 'error',
      path,
      message: `The ${name} limit is negative.`,
      explanation:
        'A quota is an upper bound on what a namespace may consume, so a negative one would forbid everything including what already exists. The apiserver rejects it with "must be greater than or equal to 0".',
      docsUrl: QUOTA_DOCS,
    });
    return;
  }

  if (isIntegerResource(name) && !Number.isInteger(quantity.value)) {
    ctx.report({
      ruleId: 'resourcequota/fractional-count',
      severity: 'error',
      path,
      message: `The ${name} limit is ${quantity.value}, which is not a whole number.`,
      explanation:
        'This resource is a count of objects rather than an amount of compute, so it can only be bounded by a whole number — there is no half a Pod to allow. The apiserver rejects the value with "must be an integer".',
      docsUrl: QUOTA_DOCS,
    });
  }
}

/**
 * An extended resource — anything domain-prefixed that is not one of the
 * kubernetes.io names — is integer-valued too, whether requested directly or
 * through the "requests." spelling.
 */
function isIntegerResource(name: string): boolean {
  if (OBJECT_COUNT_RESOURCES.includes(name)) return true;
  const bare = name.startsWith('requests.') ? name.slice('requests.'.length) : name;
  if (bare.startsWith('hugepages-')) return false;
  return bare.includes('/') && !bare.startsWith('kubernetes.io/');
}

/* scopes */

function checkScopes(ctx: RuleContext, scopes: unknown[] | undefined, bounded: string[]): void {
  if (!scopes) return;

  const named: string[] = [];
  scopes.forEach((entry, index) => {
    const scope = asString(entry);
    if (scope === undefined) return;

    const path: Path = ['spec', 'scopes', index];
    if (!SCOPES.includes(scope)) {
      const suggestion = didYouMean(scope, SCOPES);
      ctx.report({
        ruleId: 'resourcequota/unknown-scope',
        severity: 'error',
        path,
        message: suggestion
          ? `"${scope}" is not a quota scope. Did you mean "${suggestion}"?`
          : `"${scope}" is not a quota scope.`,
        explanation: `A scope narrows the quota to a subset of the objects in the namespace. The scopes are ${SCOPES.map((value) => `"${value}"`).join(', ')}; values are case-sensitive.`,
        docsUrl: SCOPE_DOCS,
        fix: suggestion
          ? { title: `Change to "${suggestion}"`, safe: true, ops: [{ op: 'set', path, value: suggestion }] }
          : undefined,
      });
      return;
    }

    checkScopeAgainstResources(ctx, scope, bounded, path);
    named.push(scope);
  });

  checkConflictingScopes(ctx, named, ['spec', 'scopes']);
}

/**
 * A scope that selects Pods can only bound what a Pod consumes: the object
 * count "pods" and the six compute names. Bounding a Secret count within the
 * "Terminating" scope would ask how many Secrets a terminating Pod is, which
 * is not a question. Only the standard names are checked, since an extended
 * or counted resource may legitimately be scoped.
 */
function checkScopeAgainstResources(
  ctx: RuleContext,
  scope: string,
  bounded: string[],
  path: Path,
): void {
  const allowed =
    scope === 'BestEffort' ? ['pods'] : ['pods', ...POD_COMPUTE_RESOURCES];

  for (const name of bounded) {
    if (!STANDARD_QUOTA_RESOURCES.includes(name) || allowed.includes(name)) continue;

    ctx.report({
      ruleId: 'resourcequota/scope-not-valid-for-resource',
      severity: 'error',
      path,
      message: `The "${scope}" scope cannot bound "${name}".`,
      explanation: `This scope selects Pods, so the quota may only count the Pods it selects and the compute they ask for: ${allowed.join(', ')}. Move "${name}" into a second ResourceQuota with no scopes.`,
      docsUrl: SCOPE_DOCS,
    });
  }
}

/** Terminating and NotTerminating — or BestEffort and NotBestEffort — select
 * complementary sets of Pods, so a quota asking for both selects no Pod at all. */
function checkConflictingScopes(ctx: RuleContext, scopes: string[], path: Path): void {
  for (const [first, second] of CONFLICTING_SCOPES) {
    if (!scopes.includes(first) || !scopes.includes(second)) continue;

    ctx.report({
      ruleId: 'resourcequota/conflicting-scopes',
      severity: 'error',
      path,
      message: `"${first}" and "${second}" cannot both be required.`,
      explanation:
        'Scopes are combined with AND, and these two select complementary sets of Pods — every Pod is one or the other — so together they select nothing and the quota would never apply. The apiserver rejects the pair with "conflicting scopes".',
      docsUrl: SCOPE_DOCS,
    });
  }
}

/* scopeSelector */

function checkScopeSelector(
  ctx: RuleContext,
  selector: Record<string, unknown> | undefined,
  bounded: string[],
): void {
  const expressions = asArray(selector?.['matchExpressions']);
  if (!expressions) return;

  const named: string[] = [];
  const base: Path = ['spec', 'scopeSelector', 'matchExpressions'];

  expressions.forEach((entry, index) => {
    const requirement = asObject(entry);
    if (!requirement) return;

    const scope = asString(requirement['scopeName']);
    const operator = asString(requirement['operator']);
    const values = asArray(requirement['values']);
    const path: Path = [...base, index];

    // An unknown scope or operator is `enum/invalid-value`, from the table in
    // rules/enums.ts; nothing below it can be judged until it is corrected.
    if (scope !== undefined && SCOPES.includes(scope)) {
      checkScopeAgainstResources(ctx, scope, bounded, [...path, 'scopeName']);
      named.push(scope);

      // Only PriorityClass has a value to compare against — every other scope
      // is a property a Pod either has or does not.
      if (scope !== 'PriorityClass' && operator !== undefined && operator !== 'Exists') {
        ctx.report({
          ruleId: 'resourcequota/scope-operator',
          severity: 'error',
          path: [...path, 'operator'],
          message: `The "${scope}" scope only supports the "Exists" operator, not "${operator}".`,
          explanation:
            'A scope other than PriorityClass names no value to match against, so the only question that can be asked of it is whether it applies. "Exists" is that question; "In" and "NotIn" would need values there are none of.',
          docsUrl: SCOPE_DOCS,
          fix: {
            title: 'Change to "Exists"',
            safe: false,
            ops: [{ op: 'set', path: [...path, 'operator'], value: 'Exists' }],
          },
        });
      }
    }

    if ((operator === 'In' || operator === 'NotIn') && (values?.length ?? 0) === 0) {
      ctx.report({
        ruleId: 'resourcequota/missing-scope-values',
        severity: 'error',
        path,
        anchor: 'key',
        message: `A "${operator}" scope requirement must list at least one value.`,
        explanation:
          '"In" and "NotIn" compare the scope against the values beside them — the priority class names this quota applies to, or does not — so an empty list makes the requirement unanswerable. The apiserver rejects it with "Required value".',
        docsUrl: SCOPE_DOCS,
      });
    }

    if ((operator === 'Exists' || operator === 'DoesNotExist') && values && values.length > 0) {
      ctx.report({
        ruleId: 'resourcequota/unexpected-scope-values',
        severity: 'error',
        path: [...path, 'values'],
        anchor: 'key',
        message: `A "${operator}" scope requirement must not list values.`,
        explanation:
          '"Exists" asks only whether the scope applies, so there is nothing for the values to be compared against and the apiserver rejects them rather than ignore them. Use "In" if the listed values were meant to be matched.',
        docsUrl: SCOPE_DOCS,
        fix: {
          title: 'Remove the values',
          safe: false,
          ops: [{ op: 'delete', path: [...path, 'values'] }],
        },
      });
    }
  });

  checkConflictingScopes(ctx, named, base);
}
