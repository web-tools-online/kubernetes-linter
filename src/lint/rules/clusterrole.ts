import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, type Rule, type RuleContext } from './context.js';
import { checkKeyedMap } from './metadata.js';
import { checkList, checkPolicyRules, type PolicyRuleOwner } from './role.js';
import { checkRequirement } from './selector.js';

const AGGREGATION_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#aggregated-clusterroles';
const RESOURCES_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources';
const NON_RESOURCE_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

/** The entry that stands for every URL, exactly as it does in the other lists. */
const WILDCARD = '*';

/** The three lists a rule may not carry beside `nonResourceURLs`. */
const RESOURCE_FIELDS = ['apiGroups', 'resources', 'resourceNames'] as const;

/**
 * The verbs a non-resource request can arrive with. `RequestInfoFactory` maps
 * a resource request's method onto the eight RBAC verbs — a GET becomes a
 * `get` or a `list` depending on whether it addressed a member or a collection
 * — but a path that is not under an API prefix never reaches that mapping and
 * keeps the verb it was given at the top of the function, the HTTP method
 * lowercased. So these are the only words a rule over URLs can match, and
 * `list`, `watch`, `create`, `update` and `deletecollection` are not among
 * them however natural they look beside one.
 */
const NON_RESOURCE_VERBS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  WILDCARD,
];

/**
 * The checks worth making on a ClusterRole. Its rules are a Role's rules —
 * `validateClusterRole` and `validateRole` both walk `validatePolicyRule` per
 * entry, differing only in the `isNamespaced` flag — so `role.ts` owns all of
 * that and this module brings the two things a ClusterRole has that a Role
 * does not.
 *
 * The first is legal non-resource URLs. A path like /healthz belongs to the
 * server rather than to any namespace, so only a cluster-scoped rule can grant
 * it; but the authorizer answers a non-resource request from an entirely
 * different function than a resource one, so a rule that names both halves is
 * rejected outright. Past that rejection the URLs themselves are unvalidated
 * free strings, matched by `NonResourceURLMatches` with an equality test and a
 * single trailing-`*` prefix test and nothing else — which leaves two ways to
 * write one that is stored happily and then matches no request that will ever
 * arrive, and one more in the verbs beside it.
 *
 * The second is `aggregationRule`, which is not a permission at all but an
 * instruction to a controller: set it, and the ClusterRole's `rules` become
 * controller-managed, recomputed from every ClusterRole its selectors match
 * and overwritten on every sync. Nothing about it is rejected — the field's own
 * API description is the whole of the contract — so all three findings here are
 * warnings about a manifest that says one thing and stores another.
 *
 * Deliberately not checked: whether an aggregated ClusterRole's selectors match
 * anything, which depends on the ClusterRoles a particular cluster holds rather
 * than on the document, the same reason `role.ts` does not ask whether a named
 * resource exists. Nothing is version-gated: rbac/v1 has been served unchanged
 * since 1.8, `aggregationRule` since 1.9, long before the 1.25 floor.
 */
export const clusterRoleRule: Rule = {
  id: 'clusterrole/rules',
  run(ctx: RuleContext) {
    const aggregation = asObject(ctx.doc['aggregationRule']);

    checkPolicyRules(ctx, {
      kind: 'ClusterRole',
      // An aggregated ClusterRole with no rules is not a mistake but the
      // normal way to write one: the controller fills them in.
      reportEmpty: aggregation === undefined,
      checkNonResourceRule,
    } satisfies PolicyRuleOwner);

    if (aggregation) checkAggregationRule(ctx, aggregation);
  },
};

/* Non-resource URLs, the branch a Role rejects outright */

function checkNonResourceRule(
  ctx: RuleContext,
  rule: Record<string, unknown>,
  base: Path,
): void {
  const named = RESOURCE_FIELDS.filter((field) => (asArray(rule[field]) ?? []).length > 0);
  if (named.length > 0) {
    ctx.report({
      ruleId: 'clusterrole/mixed-rule',
      severity: 'error',
      path: [...base, 'nonResourceURLs'],
      anchor: 'key',
      message: `A rule cannot grant both non-resource URLs and resources, but this one also names ${named.join(' and ')}.`,
      explanation:
        'The apiserver rejects this with "rules cannot apply to both regular resources and non-resource URLs". The two are authorized by different code: a request under an API prefix is matched by api group, resource and name, and anything else is matched against these URLs by prefix alone, so a single rule cannot describe both. Split it into two rules — one naming the resources, one naming the URLs.',
      docsUrl: RESOURCES_DOCS,
    });
    // Upstream stops at this error, and so does everything below, which only
    // has advice to offer about a rule the apiserver will not store anyway.
    return;
  }

  checkList(ctx, rule, base, 'nonResourceURLs', (url, path) => checkURL(ctx, url, path));
  checkList(ctx, rule, base, 'verbs', (verb, path) => checkNonResourceVerb(ctx, verb, path));
}

/**
 * A non-resource URL against the two ways `NonResourceURLMatches` can read it:
 * equality with the request's path, or — for an entry ending in `*` — a prefix
 * of it. Both compare against a path from the request line, which always
 * begins with a slash and never contains a literal `*`.
 */
function checkURL(ctx: RuleContext, url: string, path: Path): void {
  if (url === WILDCARD) return;

  if (!url.startsWith('/')) {
    ctx.report({
      ruleId: 'clusterrole/relative-non-resource-url',
      severity: 'warning',
      path,
      message: `"${url}" matches nothing: a non-resource URL is an absolute path.`,
      explanation:
        'RBAC compares this entry against the path from the request line, which always starts with a slash — "/healthz", never "healthz". The comparison is a plain string one, so an entry without the leading slash can never equal a request path nor be a prefix of one, and the rule authorizes nothing.',
      docsUrl: NON_RESOURCE_DOCS,
      fix: {
        // The only reading: every path this could have meant starts with a
        // slash, and adding one changes nothing else about the entry.
        title: `Change to "/${url}"`,
        safe: true,
        ops: [{ op: 'set', path, value: `/${url}` }],
      },
    });
    return;
  }

  // A "*" is a wildcard only as the last character, where it turns the
  // comparison into a prefix test. Anywhere else it is part of the literal
  // string being compared.
  const star = url.indexOf(WILDCARD);
  if (star === -1 || star === url.length - 1) return;

  ctx.report({
    ruleId: 'clusterrole/embedded-wildcard-url',
    severity: 'warning',
    path,
    message: `The "*" in "${url}" is not a wildcard: only a trailing one is.`,
    explanation:
      'RBAC reads a non-resource URL two ways and no more: as a string equal to the request path, or — when the entry ends in "*" — as a prefix of it. A "*" anywhere else is compared as the character it is, and no request path contains one, so this entry matches nothing. A "*" in the middle of a path cannot be expressed; grant the prefix it sits after instead.',
    docsUrl: NON_RESOURCE_DOCS,
  });
}

/**
 * A verb beside a URL, which stands where `checkVerb` stands on an ordinary
 * rule. This is the same shape of finding as `role/unrestrictable-verb`: the
 * rule is accepted, the binding resolves, and the verb simply never turns up
 * on a request against the path.
 */
function checkNonResourceVerb(ctx: RuleContext, verb: string, path: Path): void {
  if (NON_RESOURCE_VERBS.includes(verb)) return;

  const suggestion = didYouMean(verb, NON_RESOURCE_VERBS) ?? 'get';
  ctx.report({
    ruleId: 'clusterrole/non-resource-verb',
    severity: 'warning',
    path,
    message: `"${verb}" grants nothing here: a request for a URL never carries it.`,
    explanation:
      'A request that is not for an API resource keeps the verb it was given before RBAC sees it, which is its HTTP method lowercased — get, post, put, patch, delete, head or options. The eight resource verbs are derived further up, from the shape of the path, and a path like /healthz never reaches that step. So this verb is never the one being authorized, and the entry matches no request.',
    docsUrl: NON_RESOURCE_DOCS,
    fix: {
      // "list" on a URL almost always means "get", but which HTTP method was
      // wanted is the author's to say, so this is offered rather than applied.
      title: `Change to "${suggestion}"`,
      safe: false,
      ops: [{ op: 'set', path, value: suggestion }],
    },
  });
}

/* aggregationRule, which hands the rules to a controller */

function checkAggregationRule(ctx: RuleContext, aggregation: Record<string, unknown>): void {
  if ((asArray(ctx.doc['rules']) ?? []).length > 0) {
    ctx.report({
      ruleId: 'clusterrole/aggregated-rules',
      severity: 'warning',
      path: ['rules'],
      anchor: 'key',
      message: 'These rules will be overwritten: aggregationRule hands them to a controller.',
      explanation:
        'The field\'s own description says it: "If AggregationRule is set, then the Rules are controller managed and direct changes to Rules will be stomped by the controller." The aggregation controller recomputes this list from every ClusterRole the selectors below match and writes the result back, so whatever is written here survives only until the next sync. Grant these permissions from a ClusterRole carrying the labels the selectors look for instead.',
      docsUrl: AGGREGATION_DOCS,
      fix: {
        // Deleting them is what the controller does, but it is a permission
        // grant disappearing, so it is never applied unasked.
        title: 'Remove the controller-managed rules',
        safe: false,
        ops: [{ op: 'delete', path: ['rules'] }],
      },
    });
  }

  const declared = aggregation['clusterRoleSelectors'];
  const selectors = asArray(declared);
  // A value of the wrong type is layer 1's to report; a key with no value
  // decodes to null, which the controller reads as no selectors at all and
  // which lands below. The rules above are checked either way: the controller
  // owns them whatever shape the selectors turned out to be.
  if (declared != null && selectors === undefined) return;

  if (selectors === undefined || selectors.length === 0) {
    ctx.report({
      ruleId: 'clusterrole/no-aggregation-selectors',
      severity: 'warning',
      path: 'clusterRoleSelectors' in aggregation
        ? ['aggregationRule', 'clusterRoleSelectors']
        : ['aggregationRule'],
      anchor: 'key',
      message: 'This aggregationRule aggregates nothing: it selects no ClusterRoles.',
      explanation:
        'A ClusterRole matches when at least one of these selectors matches its labels, so with none listed nothing can ever match. The controller still owns the rules, which means it recomputes them as the empty list and this ClusterRole permanently grants nothing. Either list a selector or drop the aggregationRule and write the rules directly.',
      docsUrl: AGGREGATION_DOCS,
    });
    return;
  }

  selectors.forEach((entry, index) => {
    const selector = asObject(entry);
    if (!selector) return;
    checkSelector(ctx, selector, ['aggregationRule', 'clusterRoleSelectors', index]);
  });
}

function checkSelector(
  ctx: RuleContext,
  selector: Record<string, unknown>,
  path: Path,
): void {
  const labels = asObject(selector['matchLabels']);
  const expressions = asArray(selector['matchExpressions']);

  // An empty LabelSelector matches every object, which here means every
  // ClusterRole in the cluster — cluster-admin included. That is the opposite
  // of what a selector left blank looks like it means, which is what makes it
  // worth a word rather than a matter of taste.
  if (
    Object.keys(labels ?? {}).length === 0 &&
    (expressions ?? []).length === 0
  ) {
    ctx.report({
      ruleId: 'clusterrole/empty-aggregation-selector',
      severity: 'warning',
      path,
      anchor: 'key',
      message: 'An empty selector matches every ClusterRole in the cluster, not none of them.',
      explanation:
        'A LabelSelector with neither matchLabels nor matchExpressions imposes no requirement, and an object that has to satisfy no requirement satisfies it. So this aggregates the rules of every other ClusterRole the cluster holds, cluster-admin among them, and keeps doing so as new ones are installed. A selector meant to match nothing yet has to name a label that nothing carries.',
      docsUrl: AGGREGATION_DOCS,
    });
    return;
  }

  checkKeyedMap(ctx, selector['matchLabels'], [...path, 'matchLabels'], 'label', true);

  expressions?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), [...path, 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'clusterrole',
      docsUrl: SELECTOR_DOCS,
    });
  });
}
