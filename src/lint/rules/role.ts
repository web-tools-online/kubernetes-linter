import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const RBAC_DOCS = 'https://kubernetes.io/docs/reference/access-authn-authz/rbac/';
const RESOURCES_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources';
const VERBS_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/authorization/#determine-the-request-verb';

/** The entry that stands for "every value" in verbs, apiGroups and resources. */
const WILDCARD = '*';

/**
 * The verbs the apiserver asks the authorizer about. The first eight are the
 * ones every resource has, derived from a request's method and whether it
 * addresses a collection or a member of one; the rest belong to a single
 * resource each — `bind` and `escalate` to roles, `impersonate` to users and
 * service accounts, `approve` to a certificate signing request, `sign` to a
 * signer, `proxy` to a node or a service, `use` to whatever admission plugin
 * asks for it.
 *
 * This is only ever consulted to ask whether an unrecognised verb is a
 * near-miss of a real one, never to reject: an aggregated apiserver may define
 * a verb of its own, and RBAC will happily match it. Being generous here
 * therefore costs nothing but a suggestion not made.
 */
const KNOWN_VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection',
  'bind',
  'escalate',
  'impersonate',
  'approve',
  'sign',
  'proxy',
  'use',
  WILDCARD,
];

/**
 * The verbs `resourceNames` cannot narrow. RBAC compares the list against the
 * object name in the request path, and neither of these requests carries one:
 * a create names the object in its body, which the authorizer never sees, and
 * a deletecollection addresses the collection rather than any member of it. So
 * the comparison is against the empty string, no listed name equals it, and
 * the rule authorizes nothing.
 */
const UNRESTRICTABLE_VERBS = ['create', 'deletecollection'];

/** A PolicyRule's five fields, every one of them a list of plain strings. */
type ListField = 'verbs' | 'nonResourceURLs' | 'apiGroups' | 'resources' | 'resourceNames';

/**
 * The checks worth making on a Role. `ValidateRole` in pkg/apis/rbac/validation
 * is short — the object's metadata, then `validatePolicyRule` per entry — and
 * of the four things that function rejects, layer 1 already covers one: `verbs`
 * is the only field in PolicyRule's `required` list, so an absent one is
 * `schema/required-field` and only an empty one is reported here. The rest of
 * `validatePolicyRule` is this module's: a rule needs an api group and a
 * resource, and a namespaced rule may not name a non-resource URL at all.
 *
 * Everything past that is the wider half of the job, and it is wide for this
 * kind because RBAC validates a Role's contents almost not at all. A policy
 * rule is five lists of free strings — no enum, no format, no cross-reference
 * to the resources that actually exist — so a misspelt verb, a resource
 * written as a Kind, or a name restriction on a verb that carries no name is
 * stored exactly as written and then silently matches nothing. Every one of
 * those is a warning: the object is created, the RoleBinding resolves, and the
 * only symptom is a "forbidden" that arrives much later from somewhere else.
 *
 * A Role's name is the one place a kind here departs from the usual DNS
 * subdomain: `ValidateRBACName` is `path.IsValidPathSegmentName`, the loosest
 * format the apiserver has, which is why the descriptor sets
 * `nameFormat: 'path-segment'` and why "system:controller:token-cleaner" is a
 * legal name. `metadata.ts` reads that; nothing about it is this module's.
 *
 * Deliberately not checked: whether a named resource, api group or verb
 * actually exists in the cluster. That is a question about the API surface a
 * particular cluster serves — CRDs and aggregated apiservers included — and
 * cannot be answered from the document alone, which is the same reason a
 * ServiceAccount's secret references are checked for shape and not existence.
 * Nothing here is version-gated: rbac/v1 has been served unchanged since 1.8,
 * long before the 1.25 floor.
 */
export const roleRule: Rule = {
  id: 'role/rules',
  run(ctx: RuleContext) {
    const declared = ctx.doc['rules'];
    // A `rules` that is neither a list nor absent is layer 1's to report. A
    // key written with no value decodes to null, which the apiserver reads as
    // the empty list exactly as it reads an absent one, so it lands below.
    if (declared != null && asArray(declared) === undefined) return;
    const rules = asArray(declared);

    if (rules === undefined || rules.length === 0) {
      ctx.report({
        ruleId: 'role/no-rules',
        severity: 'warning',
        path: 'rules' in ctx.doc ? ['rules'] : [],
        message: 'This Role grants nothing: it has no rules.',
        explanation:
          'RBAC is purely additive — permissions come from the rules a Role lists and from nowhere else — so a Role with an empty list denies every request made through it. The apiserver creates it without complaint, and any RoleBinding to it resolves and grants no access at all.',
        docsUrl: RBAC_DOCS,
      });
      return;
    }

    rules.forEach((entry, index) => {
      const rule = asObject(entry);
      if (!rule) return;
      checkPolicyRule(ctx, rule, ['rules', index]);
    });
  },
};

/**
 * One entry of `rules`. The order below is upstream's, including the early
 * return: `validatePolicyRule` stops after a non-resource URL rather than
 * going on to ask for an api group, since a rule that reached that branch is
 * not describing resources at all.
 */
function checkPolicyRule(ctx: RuleContext, rule: Record<string, unknown>, base: Path): void {
  checkList(ctx, rule, base, 'verbs');
  checkEmptyList(ctx, rule, base, 'verbs');

  const nonResourceURLs = asArray(rule['nonResourceURLs']) ?? [];
  if (nonResourceURLs.length > 0) {
    ctx.report({
      ruleId: 'role/non-resource-urls',
      severity: 'error',
      path: [...base, 'nonResourceURLs'],
      anchor: 'key',
      message: 'A Role cannot grant access to non-resource URLs.',
      explanation:
        'The apiserver rejects this with "namespaced rules cannot apply to non-resource URLs". A path like /healthz or /metrics belongs to the server rather than to any namespace, so only a ClusterRole reached through a ClusterRoleBinding can grant it — and even there the rule may name either resources or URLs, never both. Move this rule into a ClusterRole, or drop the field if the resource half is what was meant.',
      docsUrl: RESOURCES_DOCS,
      fix: {
        // Which half of the rule was intended is a genuine question: deleting
        // the URLs keeps the resource grant, moving the rule to a ClusterRole
        // keeps the URLs, and only the author knows which.
        title: 'Remove nonResourceURLs',
        safe: false,
        ops: [{ op: 'delete', path: [...base, 'nonResourceURLs'] }],
      },
    });
    return;
  }

  checkList(ctx, rule, base, 'apiGroups');
  checkEmptyList(ctx, rule, base, 'apiGroups');
  checkList(ctx, rule, base, 'resources');
  checkEmptyList(ctx, rule, base, 'resources');
  checkList(ctx, rule, base, 'resourceNames');
  checkNameRestriction(ctx, rule, base);
}

/**
 * The three lists `validatePolicyRule` requires a value in. `verbs` is in
 * PolicyRule's `required` list and the other two are not, so an absent `verbs`
 * has already been reported by layer 1 and an absent `apiGroups` or
 * `resources` has not — which is why only the latter two are reported from
 * here when the field is missing entirely. The apiserver treats absent and
 * empty identically, so past that the only difference between them is whether
 * there is a key to anchor the finding on.
 */
function checkEmptyList(
  ctx: RuleContext,
  rule: Record<string, unknown>,
  base: Path,
  field: 'verbs' | 'apiGroups' | 'resources',
): void {
  const declared = rule[field];
  const entries = asArray(declared);
  // A value of the wrong type is layer 1's; a key with no value at all decodes
  // to null, which the apiserver reads as the empty list.
  if (declared != null && entries === undefined) return;
  if (entries !== undefined && entries.length > 0) return;
  // Layer 1 reports an absent — or valueless — `verbs` as schema/required-field.
  if (entries === undefined && field === 'verbs') return;

  const detail =
    field === 'verbs'
      ? 'A rule that permits no verb permits no request; the apiserver rejects it with "verbs must contain at least one value".'
      : field === 'apiGroups'
        ? 'The apiserver rejects this with "resource rules must supply at least one api group". Use "" for the core group — the one that serves pods, services, configmaps and the rest of /api/v1 — and the group name for anything else, such as "apps" or "batch".'
        : 'The apiserver rejects this with "resource rules must supply at least one resource". Resources are named as they appear in a request path: the lowercase plural, such as "pods" or "deployments", optionally with a subresource after a slash.';

  ctx.report({
    ruleId: `role/missing-${field === 'apiGroups' ? 'api-groups' : field}`,
    severity: 'error',
    path: field in rule ? [...base, field] : base,
    anchor: 'key',
    message: `This rule needs at least one entry in "${field}".`,
    explanation: detail,
    docsUrl: RESOURCES_DOCS,
  });
}

/**
 * Everything one of a PolicyRule's string lists can say about itself. RBAC
 * unions a rule's lists into a set before matching anything against them, so
 * none of what follows is rejected — a repeated entry, an entry a "*" beside
 * it already covers, and an empty string all leave the grant exactly as it
 * would have been without them.
 */
function checkList(
  ctx: RuleContext,
  rule: Record<string, unknown>,
  base: Path,
  field: Exclude<ListField, 'nonResourceURLs'>,
): void {
  const entries = asArray(rule[field]);
  if (!entries) return;

  // "*" is a wildcard in three of the four lists. It is not one in
  // resourceNames, where the comparison is a plain string equality — which is
  // what makes a "*" there worth a finding of its own rather than a reason to
  // call its neighbours redundant.
  const wildcarded = field !== 'resourceNames' && entries.some((e) => asString(e) === WILDCARD);
  const seen = new Map<string, number>();

  entries.forEach((entry, index) => {
    const value = asString(entry);
    if (value === undefined) return;
    const path: Path = [...base, field, index];

    const first = seen.get(value);
    if (first !== undefined) {
      ctx.report({
        ruleId: 'role/duplicate-entry',
        severity: 'warning',
        path,
        message: `"${value}" is already listed by entry ${first + 1} of ${field}.`,
        explanation:
          'A policy rule is matched by asking whether any entry equals the request\'s value, so listing one twice adds nothing and shadows nothing. The apiserver stores the list verbatim, duplicates included.',
        docsUrl: RESOURCES_DOCS,
        fix: {
          title: 'Remove the duplicate entry',
          safe: true,
          ops: [{ op: 'delete', path }],
        },
      });
      return;
    }
    seen.set(value, index);

    if (wildcarded && value !== WILDCARD) {
      ctx.report({
        ruleId: 'role/redundant-wildcard',
        severity: 'warning',
        path,
        message: `"${value}" is redundant: "*" in ${field} already covers it.`,
        explanation:
          'Matching stops at the first entry that answers yes, and "*" answers yes to everything, so nothing beside it in this list can narrow or extend the grant. Either the "*" was not meant, in which case removing it is the fix, or these entries are documentation rather than policy — and documentation that a reader has no way to tell apart from a restriction is worth a comment instead.',
        docsUrl: RESOURCES_DOCS,
        fix: {
          // Provably inert: whatever this entry says, the "*" beside it has
          // already granted at least as much.
          title: `Remove "${value}"`,
          safe: true,
          ops: [{ op: 'delete', path }],
        },
      });
      return;
    }

    // The core API group is spelled "", so an empty string is a value in its
    // own right there and only there.
    if (value === '' && field !== 'apiGroups') {
      ctx.report({
        ruleId: 'role/empty-entry',
        severity: 'warning',
        path,
        message: `An empty string in ${field} matches nothing.`,
        explanation:
          'RBAC compares this entry against the request as a plain string, and no request carries an empty verb, resource or object name, so the entry can never answer yes. Note that "" does mean something in apiGroups — it is how the core group is written — which is the likely source of the confusion.',
        docsUrl: RESOURCES_DOCS,
        fix: {
          title: 'Remove the empty entry',
          safe: true,
          ops: [{ op: 'delete', path }],
        },
      });
      return;
    }

    switch (field) {
      case 'verbs':
        checkVerb(ctx, value, path);
        return;
      case 'resources':
        checkResource(ctx, value, path);
        return;
      case 'resourceNames':
        checkResourceName(ctx, value, path);
        return;
      case 'apiGroups':
        return;
    }
  });
}

/**
 * A verb is a free string that nothing validates, and the authorizer compares
 * it to the request's own verb exactly — case included. So a misspelling is
 * not an error but a grant that never applies, and the only handle on it is
 * how close the word is to one the apiserver actually asks about.
 */
function checkVerb(ctx: RuleContext, verb: string, path: Path): void {
  if (KNOWN_VERBS.includes(verb)) return;
  const suggestion = didYouMean(verb, KNOWN_VERBS);
  if (suggestion === undefined) return;

  ctx.report({
    ruleId: 'role/unknown-verb',
    severity: 'warning',
    path,
    message: `"${verb}" is not a verb the apiserver asks about — did you mean "${suggestion}"?`,
    explanation:
      'The authorizer matches a rule\'s verbs against the verb it derived from the request — get, list, watch, create, update, patch, delete or deletecollection for an ordinary resource — by exact, case-sensitive comparison. A verb it never derives simply never matches, and since an aggregated apiserver may define verbs of its own, nothing rejects one it does not recognise. This one is close enough to a real verb to read as a typo rather than a deliberate custom verb.',
    docsUrl: VERBS_DOCS,
    fix: {
      title: `Change to "${suggestion}"`,
      safe: true,
      ops: [{ op: 'set', path, value: suggestion }],
    },
  });
}

/**
 * Resources are named the way a request path names them: lowercase, plural,
 * with a subresource after a slash. Nothing enforces that here, so the common
 * mistake — writing the Kind from the manifest, "Pod" for "pods" — is stored
 * and matches nothing. An uppercase letter is a reliable tell, since a
 * built-in resource never has one and a CRD's own validation forbids it in
 * `spec.names.plural`.
 */
function checkResource(ctx: RuleContext, resource: string, path: Path): void {
  if (resource === resource.toLowerCase()) return;

  ctx.report({
    ruleId: 'role/uppercase-resource',
    severity: 'warning',
    path,
    message: `"${resource}" cannot name a resource: resource names are lowercase.`,
    explanation:
      'This list names resources as a request path spells them — the lowercase plural, "pods" rather than "Pod" — not as the manifest\'s "kind" spells them. No resource can have an uppercase letter in its name: the built-in ones do not, and a CustomResourceDefinition\'s own validation refuses a plural that does. So this entry matches no request that will ever arrive.',
    docsUrl: RESOURCES_DOCS,
    fix: {
      // Lowercasing is necessary but may not be sufficient: "Pod" becomes
      // "pod" where the resource is "pods", and only the author knows which
      // resource was meant.
      title: `Change to "${resource.toLowerCase()}"`,
      safe: false,
      ops: [{ op: 'set', path, value: resource.toLowerCase() }],
    },
  });
}

/**
 * The one list where "*" is not a wildcard. `ResourceNameMatches` compares
 * entries to the request's object name with `==` and nothing else, so a "*"
 * here asks for the object literally named "*" — which, since every kind's own
 * name format forbids the character, is no object at all.
 */
function checkResourceName(ctx: RuleContext, name: string, path: Path): void {
  if (name !== WILDCARD) return;

  ctx.report({
    ruleId: 'role/wildcard-resource-name',
    severity: 'warning',
    path,
    message: '"*" is not a wildcard in resourceNames; it names an object called "*".',
    explanation:
      'Every other list in a policy rule reads "*" as "any", but resourceNames is compared to the request\'s object name by string equality alone. No object can be called "*" — the name formats every kind is validated against exclude the character — so this restricts the rule to nothing rather than opening it to everything. "Any name" is said by leaving resourceNames out altogether.',
    docsUrl: RESOURCES_DOCS,
    fix: {
      // Deleting the entry widens the rule from "nothing" to "every object of
      // this resource", which is probably what was meant and is emphatically
      // not something to do without being asked.
      title: 'Remove the "*" entry',
      safe: false,
      ops: [{ op: 'delete', path }],
    },
  });
}

/**
 * `resourceNames` against the verbs it is meant to narrow. The list is
 * compared to the object name in the request path, so a verb whose request
 * carries no name there cannot be narrowed by it — it is excluded outright.
 */
function checkNameRestriction(
  ctx: RuleContext,
  rule: Record<string, unknown>,
  base: Path,
): void {
  const names = asArray(rule['resourceNames']) ?? [];
  if (names.length === 0) return;

  const verbs = asArray(rule['verbs']) ?? [];
  verbs.forEach((entry, index) => {
    const verb = asString(entry);
    // A "*" is left alone deliberately: it grants the eight ordinary verbs at
    // once, and that the two unnameable ones fall out of a name-restricted
    // rule is the expected reading of it rather than a mistake.
    if (verb === undefined || !UNRESTRICTABLE_VERBS.includes(verb)) return;

    ctx.report({
      ruleId: 'role/unrestrictable-verb',
      severity: 'warning',
      path: [...base, 'verbs', index],
      message: `"${verb}" grants nothing here: it cannot be restricted by resourceNames.`,
      explanation:
        verb === 'create'
          ? 'RBAC narrows a rule by comparing resourceNames to the object name in the request path, and a create has none there — the name is inside the body, which the authorizer never reads. So the comparison is against an empty name, no listed name equals it, and this verb authorizes nothing. Grant create in a rule of its own, without resourceNames.'
          : 'RBAC narrows a rule by comparing resourceNames to the object name in the request path, and a deletecollection addresses the collection rather than any member of it, so there is no name there to compare. The comparison is against an empty name, no listed name equals it, and this verb authorizes nothing. Grant deletecollection in a rule of its own, without resourceNames.',
      docsUrl: RESOURCES_DOCS,
    });
  });
}
