import { isDNS1035Label, isDNS1123Subdomain } from '../../k8s/names.js';
import { customResourceGroupVersion } from '../schema.js';
import { type Rule, type RuleContext } from './context.js';

const CRD_DOCS =
  'https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/';

/**
 * The only thing about a custom resource this linter can check beyond its
 * metadata: the group and version its apiVersion names. Everything below is
 * the CRD's own business — its schema lives in a cluster, not in a release —
 * but the CustomResourceDefinition that would serve this document is itself an
 * ordinary object the apiserver validates, so a group or version no CRD could
 * declare names a resource that cannot exist on any cluster.
 *
 * The split is the same one the schema layer used to recognise the document as
 * a custom resource in the first place, and this rule runs for nothing else,
 * so it can only come back empty if the two ever stopped agreeing.
 */
export const customResourceRule: Rule = {
  id: 'customresource/api-version',
  run(ctx: RuleContext) {
    const groupVersion = customResourceGroupVersion(ctx.doc['apiVersion']);
    if (!groupVersion) return;
    const { group, version } = groupVersion;

    const groupCheck = isDNS1123Subdomain(group);
    if (!groupCheck.ok) {
      ctx.report({
        ruleId: 'customresource/invalid-group',
        severity: 'error',
        path: ['apiVersion'],
        message: `"${group}" cannot be an API group: it ${groupCheck.reason}.`,
        explanation:
          'A CustomResourceDefinition\'s group is validated as a DNS subdomain — lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character — so no CRD could serve this kind.',
        docsUrl: CRD_DOCS,
      });
    } else if (!group.includes('.')) {
      ctx.report({
        ruleId: 'customresource/invalid-group',
        severity: 'error',
        path: ['apiVersion'],
        message: `"${group}" cannot be an API group: it should be a domain with at least one dot.`,
        explanation:
          'The apiserver rejects a CustomResourceDefinition whose group is a bare word: the dotless groups — apps, batch, autoscaling, policy, extensions — are the Kubernetes project\'s own, and an extension names a domain it controls so that two of them cannot collide.',
        docsUrl: CRD_DOCS,
      });
    }

    const versionCheck = isDNS1035Label(version);
    if (!versionCheck.ok) {
      ctx.report({
        ruleId: 'customresource/invalid-version',
        severity: 'error',
        path: ['apiVersion'],
        message: `"${version}" cannot be an API version: it ${versionCheck.reason}.`,
        explanation:
          'A CustomResourceDefinition\'s version names are validated as DNS labels, which is what the conventional "v1", "v1beta1" and "v2alpha1" spellings already are: lowercase letters and digits starting with a letter, at most 63 characters.',
        docsUrl: CRD_DOCS,
      });
    }
  },
};
