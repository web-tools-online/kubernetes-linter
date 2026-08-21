import type { Path } from '../types.js';
import { asString, type Rule, type RuleContext } from './context.js';
import { checkBinding, type RoleBindingOwner } from './rolebinding.js';

const BINDING_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding';
const SUBJECTS_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects';

const CLUSTER_ROLE = 'ClusterRole';

/**
 * The checks worth making on a ClusterRoleBinding, which is the smallest
 * module here: `ValidateClusterRoleBinding` and `ValidateRoleBinding` are the
 * same function written out twice, so `rolebinding.ts` owns the whole of it
 * and this module brings the two lines where the copies differ — the same
 * arrangement `clusterrole.ts` has with `role.ts`, except that there upstream
 * really does share one `validatePolicyRule` and here it does not.
 *
 * Both differences follow from the same fact, that this binding is attached to
 * no namespace. Its `roleRef` may therefore name only a ClusterRole, a Role's
 * rules having nowhere to be interpreted; and a ServiceAccount subject must
 * name its own namespace, there being no binding namespace for the authorizer
 * to read one from. The first is a value `rules/enums.ts` accepts — `RoleRef.kind`
 * is one table entry serving both bindings, and a RoleBinding really may name
 * either — so narrowing it is this module's rather than the table's. The second
 * is the single branch `ValidateRoleBindingSubject` consults its `isNamespaced`
 * argument for.
 *
 * The third difference is not this module's at all: `ValidateObjectMeta` is
 * called with `false` here, so a `metadata.namespace` is forbidden rather than
 * merely unusual, which the descriptor's `clusterScoped` says and `metadata.ts`
 * reports as `meta/namespace-not-allowed`.
 *
 * Deliberately not checked, exactly as on a RoleBinding: whether the
 * referenced ClusterRole or a named ServiceAccount exists, both being questions
 * about what a cluster holds rather than about the document, and the
 * immutability of `roleRef`, which only constrains an update. Nothing is
 * version-gated: rbac/v1 has been served unchanged since 1.8.
 */
export const clusterRoleBindingRule: Rule = {
  id: 'clusterrolebinding/fields',
  run(ctx: RuleContext) {
    checkBinding(ctx, {
      kind: 'ClusterRoleBinding',
      checkRoleRefKind,
      checkServiceAccountNamespace,
    } satisfies RoleBindingOwner);
  },
};

/**
 * The `roleRef.kind` narrowing. A RoleBinding's switch accepts "Role" and
 * "ClusterRole" and this one accepts "ClusterRole" alone, so the only value
 * reaching here that the enum table let through and the apiserver will not is
 * "Role" — anything else has already been reported as `enum/invalid-value`.
 */
function checkRoleRefKind(ctx: RuleContext, kind: string, path: Path): void {
  if (kind === CLUSTER_ROLE) return;
  // A kind outside the table's two is enum/invalid-value's; there is nothing
  // to add about a reference that names no kind RBAC has.
  if (kind !== 'Role') return;

  ctx.report({
    ruleId: 'clusterrolebinding/namespaced-role-ref',
    severity: 'error',
    path,
    message: 'A ClusterRoleBinding can only bind a ClusterRole, not a Role.',
    explanation:
      'The apiserver rejects this with "supported values: \\"ClusterRole\\"". A Role\'s rules are written to be read inside the namespace that holds it, and this binding belongs to no namespace — it grants across all of them at once, and over the cluster-scoped resources that sit outside every one — so there is nowhere for a Role\'s rules to apply. Bind the Role with a RoleBinding in its own namespace, or move the rules into a ClusterRole.',
    docsUrl: BINDING_DOCS,
    fix: {
      // Not safe on either reading. Pointing at a ClusterRole of the same name
      // silently repoints the binding at a different object, which may not
      // exist and which would grant cluster-wide what was written to be
      // namespaced; and the other correction is to the document's own kind,
      // which the author has to choose.
      title: `Change to "${CLUSTER_ROLE}"`,
      safe: false,
      ops: [{ op: 'set', path, value: CLUSTER_ROLE }],
    },
  });
}

/**
 * The `isNamespaced` branch. A ServiceAccount is the one subject kind naming
 * an object the cluster holds, and that object lives in a namespace, so
 * something has to say which — a RoleBinding lends its own and this cannot.
 */
function checkServiceAccountNamespace(
  ctx: RuleContext,
  subject: Record<string, unknown>,
  base: Path,
): void {
  const namespace = asString(subject['namespace']);
  // Upstream measures a length, so an explicit empty string is missing too. A
  // value of the wrong type is layer 1's, and asString has already dropped it.
  if (namespace !== undefined && namespace !== '') return;

  ctx.report({
    ruleId: 'clusterrolebinding/missing-subject-namespace',
    severity: 'error',
    path: 'namespace' in subject ? [...base, 'namespace'] : base,
    anchor: 'key',
    message: 'This ServiceAccount subject names no namespace.',
    explanation:
      'A ServiceAccount name is unique only within a namespace, so naming one is the only way to say which account is meant. A RoleBinding may leave this out because the authorizer falls back to the binding\'s own namespace, but a ClusterRoleBinding has none to fall back to — it is attached to no namespace at all — so the apiserver requires the field and rejects the binding without it.',
    docsUrl: SUBJECTS_DOCS,
  });
}
