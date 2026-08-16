import { isQualifiedName } from '../../k8s/names.js';
import { parseQuantity } from '../../k8s/quantity.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const LIMITRANGE_DOCS = 'https://kubernetes.io/docs/concepts/policy/limit-range/';

/** The five constraint maps a LimitRangeItem carries, all `map[string]Quantity`. */
const CONSTRAINTS = ['max', 'min', 'default', 'defaultRequest', 'maxLimitRequestRatio'] as const;
type Constraint = (typeof CONSTRAINTS)[number];

/**
 * standardResources from pkg/apis/core/helper, which `validateResourceName`
 * checks an unprefixed name against. It is the quota system's set plus bare
 * "storage" — a LimitRange bounds a PersistentVolumeClaim's size directly,
 * where a quota only ever sums it as "requests.storage" — so the two are not
 * the same set and this one is written out rather than shared with
 * `rules/resourcequota.ts`.
 */
const STANDARD_RESOURCES = [
  'cpu', 'memory', 'ephemeral-storage', 'storage',
  'requests.cpu', 'requests.memory', 'requests.storage', 'requests.ephemeral-storage',
  'limits.cpu', 'limits.memory', 'limits.ephemeral-storage',
  'pods', 'resourcequotas', 'services', 'replicationcontrollers', 'secrets', 'configmaps',
  'persistentvolumeclaims', 'services.nodeports', 'services.loadbalancers',
];

interface Ordering {
  /** The constraint that must not exceed `upper`. */
  lower: Constraint;
  upper: Constraint;
  /** The field upstream blames, which is not always the greater of the two. */
  blame: Constraint;
  reason: string;
}

/**
 * The orderings one resource's constraints must satisfy — in effect
 * min <= defaultRequest <= default <= max, spelled out as the six pairs
 * upstream compares, since any one of them can be violated on its own.
 */
const ORDERINGS: Ordering[] = [
  {
    lower: 'min',
    upper: 'max',
    blame: 'min',
    reason:
      'A container asking for less than min is rejected and one asking for more than max is too, so a min above the max leaves nothing that can be admitted at all.',
  },
  {
    lower: 'min',
    upper: 'defaultRequest',
    blame: 'defaultRequest',
    reason:
      'defaultRequest is the request a container that names none is given, so one below the min would default every such container straight into rejection.',
  },
  {
    lower: 'defaultRequest',
    upper: 'max',
    blame: 'defaultRequest',
    reason:
      'defaultRequest is the request a container that names none is given, so one above the max would default every such container straight into rejection.',
  },
  {
    lower: 'defaultRequest',
    upper: 'default',
    blame: 'defaultRequest',
    reason:
      'default is the limit a container that names none is given and defaultRequest is its request, and a request above its own limit is never valid.',
  },
  {
    lower: 'min',
    upper: 'default',
    blame: 'default',
    reason:
      'default is the limit a container that names none is given, and a limit below the min is rejected, so every such container would be.',
  },
  {
    lower: 'default',
    upper: 'max',
    blame: 'default',
    reason:
      'default is the limit a container that names none is given, and a limit above the max is rejected, so every such container would be.',
  },
];

/**
 * The checks the apiserver runs on a LimitRange, from ValidateLimitRange in
 * pkg/apis/core/validation. Like a ResourceQuota it describes no Pod, so none
 * of the shared PodSpec rules apply.
 *
 * Layer 1 covers the structure — `spec.limits` is required, so is each item's
 * `type`, and every constraint map is a `map[string]Quantity` whose values it
 * checks parse — and `LimitRangeItem.type` is a plain scalar enum, so it lives
 * in `rules/enums.ts`. What is left is what OpenAPI cannot express: the same
 * `type` twice, the two `default` maps a Pod-typed item may not carry, the
 * storage bound a PersistentVolumeClaim-typed one must, which resource names
 * may be bounded, and the ways one resource's five constraints can contradict
 * each other.
 *
 * Deliberately skipped: a negative quantity, which upstream does not check for
 * here — unlike a ResourceQuota, whose ceilings it does.
 *
 * Nothing is version-gated: core/v1 LimitRange has been unchanged since well
 * before the 1.25 floor.
 */
export const limitRangeRule: Rule = {
  id: 'limitrange/fields',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']) ?? {};
    const limits = asArray(spec['limits']);
    if (!limits) return;

    const seen = new Set<string>();

    limits.forEach((entry, index) => {
      const item = asObject(entry);
      if (!item) return;

      const base: Path = ['spec', 'limits', index];
      const type = asString(item['type']);

      if (type !== undefined && seen.has(type)) {
        ctx.report({
          ruleId: 'limitrange/duplicate-type',
          severity: 'error',
          path: [...base, 'type'],
          message: `There is already a "${type}" entry in spec.limits.`,
          explanation:
            'Each entry states the whole set of constraints for the kind of object it names, so a second one for the same type would be a second answer to the same question rather than an addition to the first. The apiserver rejects it with "Duplicate value". Merge the two entries.',
          docsUrl: LIMITRANGE_DOCS,
        });
      }
      if (type !== undefined) seen.add(type);

      checkItem(ctx, item, type, base);
    });
  },
};

function checkItem(
  ctx: RuleContext,
  item: Record<string, unknown>,
  type: string | undefined,
  base: Path,
): void {
  // A Pod-typed entry constrains the sum across a Pod's containers, and there
  // is nothing to default a sum to — the defaults are applied per container —
  // so upstream forbids both maps outright and never even reads their keys.
  const isPod = type === 'Pod';
  if (isPod) {
    for (const constraint of ['default', 'defaultRequest'] as const) {
      if (asObject(item[constraint]) === undefined) continue;
      ctx.report({
        ruleId: 'limitrange/default-not-allowed',
        severity: 'error',
        path: [...base, constraint],
        anchor: 'key',
        message: `${constraint} may not be set when type is "Pod".`,
        explanation:
          'A Pod-typed entry bounds the total of a Pod\'s containers, and a default is filled in per container rather than per Pod, so there is nothing for this map to apply to. The apiserver rejects it with "may not be specified when `type` is \'Pod\'". Move the defaults to a "Container" entry.',
        docsUrl: LIMITRANGE_DOCS,
      });
    }
  }

  const read = CONSTRAINTS.filter(
    (constraint) => !(isPod && (constraint === 'default' || constraint === 'defaultRequest')),
  );

  /** Every constraint the item states, by resource name then by constraint. */
  const byResource = new Map<string, Partial<Record<Constraint, Amount>>>();

  for (const constraint of read) {
    for (const [name, value] of Object.entries(asObject(item[constraint]) ?? {})) {
      checkResourceName(ctx, name, [...base, constraint, name]);

      const amount = toAmount(value);
      if (amount === undefined) continue;
      const stated = byResource.get(name) ?? {};
      stated[constraint] = amount;
      byResource.set(name, stated);
    }
  }

  if (type === 'PersistentVolumeClaim') {
    const storage = byResource.get('storage');
    if (storage?.min === undefined && storage?.max === undefined) {
      ctx.report({
        ruleId: 'limitrange/missing-storage-constraint',
        severity: 'error',
        path: base,
        anchor: 'key',
        message: 'A "PersistentVolumeClaim" entry must set a min or a max for "storage".',
        explanation:
          'Size is the only thing a claim can be bounded by, so an entry that bounds neither end of it constrains nothing. The apiserver rejects it with "either minimum or maximum storage value is required, but neither was provided".',
        docsUrl: LIMITRANGE_DOCS,
      });
    }
  }

  for (const [name, stated] of byResource) {
    checkOrderings(ctx, name, stated, base);
    checkRatio(ctx, name, stated, base);
    checkOvercommit(ctx, name, stated, base);
  }
}

/* resource names */

/**
 * A constraint key is a resource name: a qualified name, and — unprefixed — one
 * of the resources the API itself knows, since there is nothing to compare an
 * invented bare name against.
 */
function checkResourceName(ctx: RuleContext, name: string, path: Path): void {
  const check = isQualifiedName(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'limitrange/invalid-resource-name',
      severity: 'error',
      path,
      anchor: 'key',
      message: `"${name}" is not a valid resource name: it ${check.reason}.`,
      explanation:
        'A constraint key is a resource name: a qualified name, optionally prefixed with a DNS subdomain and "/". "cpu" and "nvidia.com/gpu" are both spelled that way.',
      docsUrl: LIMITRANGE_DOCS,
    });
    return;
  }

  if (name.includes('/') || isStandardResource(name)) return;

  const suggestion = didYouMean(name, STANDARD_RESOURCES);
  ctx.report({
    ruleId: 'limitrange/unknown-resource-name',
    severity: 'error',
    path,
    anchor: 'key',
    message: suggestion
      ? `"${name}" is not a standard resource name. Did you mean "${suggestion}"?`
      : `"${name}" is not a standard resource name.`,
    explanation: `Unprefixed keys are limited to the resources the API defines: ${STANDARD_RESOURCES.join(', ')} and hugepages-<size>. An extended resource needs its domain prefix ("nvidia.com/gpu"). The apiserver rejects anything else with "must be a standard resource type or fully qualified".`,
    docsUrl: LIMITRANGE_DOCS,
    fix: suggestion
      ? { title: `Rename to "${suggestion}"`, safe: true, ops: [{ op: 'rename', path, to: suggestion }] }
      : undefined,
  });
}

function isStandardResource(name: string): boolean {
  if (STANDARD_RESOURCES.includes(name)) return true;
  return name.startsWith('hugepages-') || name.startsWith('requests.hugepages-');
}

/* per-resource consistency */

function checkOrderings(
  ctx: RuleContext,
  name: string,
  stated: Partial<Record<Constraint, Amount>>,
  base: Path,
): void {
  for (const { lower, upper, blame, reason } of ORDERINGS) {
    const low = stated[lower];
    const high = stated[upper];
    if (low === undefined || high === undefined || low.value <= high.value) continue;

    ctx.report({
      ruleId: 'limitrange/conflicting-constraints',
      severity: 'error',
      path: [...base, blame, name],
      message: `The ${lower} for "${name}" (${low.raw}) is greater than its ${upper} (${high.raw}).`,
      explanation: reason,
      docsUrl: LIMITRANGE_DOCS,
    });
  }
}

/**
 * maxLimitRequestRatio bounds limit/request, so a ratio below 1 would demand a
 * limit under the request, and one above max/min demands a spread the min and
 * max beside it have already ruled out.
 */
function checkRatio(
  ctx: RuleContext,
  name: string,
  stated: Partial<Record<Constraint, Amount>>,
  base: Path,
): void {
  const ratio = stated['maxLimitRequestRatio'];
  if (ratio === undefined) return;
  const path: Path = [...base, 'maxLimitRequestRatio', name];

  if (ratio.value < 1) {
    ctx.report({
      ruleId: 'limitrange/ratio-below-one',
      severity: 'error',
      path,
      message: `The maxLimitRequestRatio for "${name}" is ${ratio.raw}, which is less than 1.`,
      explanation:
        'The ratio is the largest limit a container may have for the request it makes, and a limit below its own request is not a valid container, so a ratio under 1 admits nothing. A ratio of exactly 1 requires the two to be equal.',
      docsUrl: LIMITRANGE_DOCS,
    });
    return;
  }

  const min = stated['min'];
  const max = stated['max'];
  if (min === undefined || max === undefined) return;

  const bound = max.value / min.value;
  if (ratio.value <= bound) return;

  ctx.report({
    ruleId: 'limitrange/ratio-above-max-min',
    severity: 'error',
    path,
    message: `The maxLimitRequestRatio for "${name}" is ${ratio.raw}, which is greater than max/min (${max.raw}/${min.raw}).`,
    explanation:
      'The widest spread this entry already allows is the max divided by the min, since the request cannot go below the min nor the limit above the max. A ratio beyond that can never be reached, so the apiserver rejects it rather than let it read as a looser bound than it is.',
    docsUrl: LIMITRANGE_DOCS,
  });
}

/**
 * A resource that cannot be overcommitted has to be requested in full, so its
 * two defaults have to agree — otherwise the pair would default a container
 * into exactly the request/limit mismatch the resource forbids. Overcommit is
 * allowed for native resources, which is everything unprefixed or under
 * "kubernetes.io/", except hugepages.
 */
function checkOvercommit(
  ctx: RuleContext,
  name: string,
  stated: Partial<Record<Constraint, Amount>>,
  base: Path,
): void {
  const value = stated['default'];
  const request = stated['defaultRequest'];
  if (value === undefined || request === undefined || value.value === request.value) return;

  const native = !name.includes('/') || name.startsWith('kubernetes.io/');
  if (native && !name.startsWith('hugepages-')) return;

  ctx.report({
    ruleId: 'limitrange/overcommit-not-allowed',
    severity: 'error',
    path: [...base, 'defaultRequest', name],
    message: `"${name}" cannot be overcommitted, so its default (${value.raw}) and defaultRequest (${request.raw}) must be equal.`,
    explanation:
      'An extended resource or a hugepages allocation is handed out whole rather than shared, so a container is always given exactly what it asks for and its request and limit have to match. Two different defaults would put every container that names neither into violation of that.',
    docsUrl: LIMITRANGE_DOCS,
    fix: {
      title: `Set defaultRequest to ${value.raw}`,
      safe: false,
      ops: [{ op: 'set', path: [...base, 'defaultRequest', name], value: value.raw }],
    },
  });
}

/** A quantity that parsed, kept alongside how the manifest spelled it. */
interface Amount {
  raw: string;
  value: number;
}

function toAmount(raw: unknown): Amount | undefined {
  const quantity = parseQuantity(raw);
  if (!quantity.ok || quantity.value === undefined) return undefined;
  return { raw: typeof raw === 'string' ? raw : String(raw), value: quantity.value };
}
