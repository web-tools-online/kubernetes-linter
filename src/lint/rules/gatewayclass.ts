import type { Path } from '../types.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const GATEWAYCLASS_DOCS = 'https://gateway-api.sigs.k8s.io/api-types/gatewayclass/';

/**
 * Spellings of the core API group that are not it. The group's own name is the
 * empty string, which the field's `pattern` allows explicitly; "core" is what
 * the group is called in prose and "v1" is its version, and both are spellable
 * as a DNS subdomain, so the schema lets either through.
 */
const CORE_GROUP_ALIASES = ['core', 'v1'];

/**
 * Kinds a parametersRef can name that this linter knows are namespaced. The
 * question the check below asks is whether the reference resolves, and that
 * needs the referent's scope, which no manifest carries — so only the core
 * group's own kinds can be answered, and only the two the Gateway API's own
 * documentation suggests naming.
 */
const NAMESPACED_CORE_KINDS = ['ConfigMap', 'Secret'];

/**
 * What is left of a GatewayClass once layer 1 has had it. The CRD's schema
 * carries everything the apiserver checks — `controllerName` is required and
 * pattern-matched as a domain-prefixed path, `description` is length-capped,
 * and a `parametersRef` requires a `group`, a `kind` and a `name`, each with
 * its own pattern — and the one `x-kubernetes-validations` (CEL) rule on the
 * kind only makes `controllerName` immutable, which constrains an update
 * rather than the document.
 *
 * So, like `serviceaccount.ts`, this module reports **no error at all**: every
 * finding here is about a `parametersRef` the apiserver stores exactly as
 * written and the controller then fails to resolve, leaving the class with
 * "Accepted: False" and an "InvalidParameters" reason rather than a rejection
 * at apply time. A GatewayClass describes no Pod, so none of the shared PodSpec
 * rules apply.
 *
 * Like the other two Gateway API kinds, a GatewayClass's schema is generated
 * from one pinned Gateway API release rather than from the selected Kubernetes
 * version (see `scripts/generate-schema.mjs`), so nothing here is
 * version-gated.
 */
export const gatewayClassRule: Rule = {
  id: 'gatewayclass/spec',
  run(ctx: RuleContext) {
    // An absent spec is schema/required-field's to report — GatewayClassSpec is
    // required on the root — so this only guards against the wrong shape.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    const parameters = asObject(spec['parametersRef']);
    if (!parameters) return;

    const base: Path = ['spec', 'parametersRef'];
    checkParametersGroup(ctx, parameters, base);
    checkParametersKind(ctx, parameters, base);
    checkParametersNamespace(ctx, parameters, base);
  },
};

/**
 * The group the referent is served under. Unlike an IngressClass's `apiGroup`,
 * which is left out to mean the core group, this one is required and names the
 * core group with an empty string — so the two ways of writing "core" that the
 * pattern happens to admit resolve to a group no apiserver serves.
 */
function checkParametersGroup(
  ctx: RuleContext,
  parameters: Record<string, unknown>,
  base: Path,
): void {
  const group = asString(parameters['group']);
  if (group === undefined || !CORE_GROUP_ALIASES.includes(group)) return;

  ctx.report({
    ruleId: 'gatewayclass/invalid-parameters-group',
    severity: 'warning',
    path: [...base, 'group'],
    message: `"${group}" is not an API group; the core group is named by an empty string.`,
    explanation:
      'The group is the one the referenced object is served under — "" for the core group a ConfigMap or a Secret lives in, "k8s.example.com" for a custom resource. "core" is what that group is called in prose and "v1" is its version; neither is a group the controller can look the referent up in, so the reference resolves to nothing.',
    docsUrl: GATEWAYCLASS_DOCS,
    fix: {
      title: 'Set group: ""',
      safe: true,
      ops: [{ op: 'set', path: [...base, 'group'], value: '' }],
    },
  });
}

/**
 * The kind of the referent, which is a Kind and not a resource: the controller
 * resolves it through the RESTMapper, which matches it character for character.
 * The field's own pattern only asks that it start with a letter, so the plural,
 * lowercased resource name a kubectl command takes passes the schema and then
 * matches nothing.
 */
function checkParametersKind(
  ctx: RuleContext,
  parameters: Record<string, unknown>,
  base: Path,
): void {
  const kind = asString(parameters['kind']);
  if (kind === undefined || !/^[a-z]/.test(kind)) return;

  ctx.report({
    ruleId: 'gatewayclass/invalid-parameters-kind',
    severity: 'warning',
    path: [...base, 'kind'],
    message: `"${kind}" is not a Kind; a Kind starts with a capital letter — "ConfigMap", not "configmaps".`,
    explanation:
      'kind names the type of the referenced object the way the object itself spells it in its own "kind" field, not the plural resource name a URL or a kubectl command takes. The lookup is case-sensitive, so a lowercase spelling names a type the cluster does not serve.',
    docsUrl: GATEWAYCLASS_DOCS,
  });
}

/**
 * A GatewayClass is cluster-scoped, so a reference from it to a namespaced
 * object has no namespace of its own to fall back on. Nothing rejects the pair
 * — which resource is namespaced is not something the apiserver asks of the
 * schema — so this is only reportable for a referent whose scope is known.
 */
function checkParametersNamespace(
  ctx: RuleContext,
  parameters: Record<string, unknown>,
  base: Path,
): void {
  const namespace = asString(parameters['namespace']);
  if (namespace !== undefined) return;

  const group = asString(parameters['group']);
  const kind = asString(parameters['kind']);
  if (group !== '' || kind === undefined || !NAMESPACED_CORE_KINDS.includes(kind)) return;

  ctx.report({
    ruleId: 'gatewayclass/missing-parameters-namespace',
    severity: 'warning',
    path: base,
    anchor: 'key',
    message: `A parametersRef naming a ${kind} must say which namespace it is in.`,
    explanation:
      'A GatewayClass lives outside every namespace, so a reference from it carries no namespace for the controller to default to. Without one the lookup has nowhere to run and the class is left with "Accepted: False" and an "InvalidParameters" reason.',
    docsUrl: GATEWAYCLASS_DOCS,
  });
}
