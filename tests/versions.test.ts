import { describe, expect, it } from 'vitest';
import {
  lint,
  loadSchema,
  isKnownVersion,
  AVAILABLE_VERSIONS,
  DEFAULT_VERSION,
} from '../src/lint/index.js';
import { EXAMPLES } from '../src/ui/examples.js';
import {
  VALID_CONFIGMAP,
  VALID_CRONJOB,
  VALID_DAEMONSET,
  VALID_DEPLOYMENT,
  VALID_GATEWAY,
  VALID_HTTPROUTE,
  VALID_INGRESS,
  VALID_INGRESS_CLASS,
  VALID_JOB,
  VALID_LIMITRANGE,
  VALID_NETWORKPOLICY,
  VALID_PERSISTENTVOLUME,
  VALID_PERSISTENTVOLUMECLAIM,
  VALID_RESOURCEQUOTA,
  VALID_CLUSTER_ROLE,
  VALID_ROLE,
  VALID_ROLE_BINDING,
  VALID_CLUSTER_ROLE_BINDING,
  VALID_SECRET,
  VALID_SERVICE,
  VALID_SERVICE_ACCOUNT,
  VALID_STATEFULSET,
  VALID_STORAGE_CLASS,
  configMapData,
  cronJobWithPodSpec,
  daemonSetWithPodSpec,
  deploymentWithPodSpec,
  gatewayWithListener,
  httpRouteWithRule,
  ingressClassParameters,
  ingressPath,
  ingressWithPaths,
  job,
  jobWithPodSpec,
  limitRange,
  networkPolicy,
  persistentVolume,
  persistentVolumeClaim,
  pod,
  podWithContainer,
  policyRule,
  urlRule,
  bindingSubject,
  clusterRoleBinding,
  resourceQuota,
  role,
  secretData,
  service,
  serviceAccountEnforcing,
  serviceAccountSecrets,
  statefulSet,
  statefulSetWithPodSpec,
  storageClassWith,
} from './helpers.js';

const schemaFor = (version: string) => loadSchema(version);

async function ruleIdsAt(version: string, yaml: string): Promise<string[]> {
  return lint(yaml, await schemaFor(version)).findings.map((finding) => finding.ruleId);
}

describe('bundled versions', () => {
  it('covers 1.25 through 1.36, newest first', () => {
    expect(AVAILABLE_VERSIONS[0]).toBe('1.36');
    expect(AVAILABLE_VERSIONS.at(-1)).toBe('1.25');
    expect(AVAILABLE_VERSIONS).toHaveLength(12);
    expect(DEFAULT_VERSION).toBe('1.36');
  });

  it('recognises only the versions it ships', () => {
    expect(isKnownVersion('1.30')).toBe(true);
    expect(isKnownVersion('1.24')).toBe(false);
    expect(isKnownVersion('nonsense')).toBe(false);
  });

  it('rejects a request for a version it does not have', async () => {
    await expect(loadSchema('1.24')).rejects.toThrow(/No schema bundled/);
  });

  it('reports its own version', async () => {
    for (const version of AVAILABLE_VERSIONS) {
      expect((await schemaFor(version)).version).toBe(version);
    }
  });

  it('lints the valid example cleanly on every version', async () => {
    // Catches a botched regeneration: a truncated or mis-scoped schema file
    // would light this manifest up with spurious findings.
    const valid = EXAMPLES.find((example) => example.id === 'valid')!;
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(valid.yaml, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('carries a root for every kind on every version', async () => {
    for (const version of AVAILABLE_VERSIONS) {
      const schema = await schemaFor(version);
      expect(schema.kinds, version).toEqual([
        'Pod',
        'Deployment',
        'StatefulSet',
        'DaemonSet',
        'Job',
        'CronJob',
        'Service',
        'Ingress',
        'IngressClass',
        'PersistentVolume',
        'PersistentVolumeClaim',
        'StorageClass',
        'NetworkPolicy',
        'ConfigMap',
        'Secret',
        'ResourceQuota',
        'LimitRange',
        'ServiceAccount',
        'Role',
        'ClusterRole',
        'RoleBinding',
        'ClusterRoleBinding',
        'HTTPRoute',
        'Gateway',
      ]);
      expect(schema.for('Deployment')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('StatefulSet')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('DaemonSet')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('Job')?.apiVersion, version).toBe('batch/v1');
      expect(schema.for('CronJob')?.apiVersion, version).toBe('batch/v1');
      expect(schema.for('Pod')?.apiVersion, version).toBe('v1');
      expect(schema.for('Service')?.apiVersion, version).toBe('v1');
      expect(schema.for('Ingress')?.apiVersion, version).toBe('networking.k8s.io/v1');
      expect(schema.for('IngressClass')?.apiVersion, version).toBe('networking.k8s.io/v1');
      expect(schema.for('PersistentVolume')?.apiVersion, version).toBe('v1');
      expect(schema.for('PersistentVolumeClaim')?.apiVersion, version).toBe('v1');
      expect(schema.for('NetworkPolicy')?.apiVersion, version).toBe('networking.k8s.io/v1');
      expect(schema.for('ConfigMap')?.apiVersion, version).toBe('v1');
      expect(schema.for('Secret')?.apiVersion, version).toBe('v1');
      expect(schema.for('ResourceQuota')?.apiVersion, version).toBe('v1');
      expect(schema.for('LimitRange')?.apiVersion, version).toBe('v1');
      expect(schema.for('ServiceAccount')?.apiVersion, version).toBe('v1');
      expect(schema.for('Role')?.apiVersion, version).toBe('rbac.authorization.k8s.io/v1');
      expect(schema.for('ClusterRole')?.apiVersion, version).toBe(
        'rbac.authorization.k8s.io/v1',
      );
      expect(schema.for('RoleBinding')?.apiVersion, version).toBe(
        'rbac.authorization.k8s.io/v1',
      );
      expect(schema.for('ClusterRoleBinding')?.apiVersion, version).toBe(
        'rbac.authorization.k8s.io/v1',
      );
      expect(schema.for('HTTPRoute')?.apiVersion, version).toBe('gateway.networking.k8s.io/v1');
      expect(schema.for('Gateway')?.apiVersion, version).toBe('gateway.networking.k8s.io/v1');
      expect(schema.for('StorageClass')?.apiVersion, version).toBe('storage.k8s.io/v1');
    }
  });

  it('lints a valid Deployment cleanly on every version', async () => {
    // The Deployment closure is generated alongside the Pod one, so the same
    // regeneration tripwire has to cover the second root.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_DEPLOYMENT, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid StatefulSet cleanly on every version', async () => {
    // Covers the third root, and with it PersistentVolumeClaim, which only the
    // StatefulSet closure pulls in.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_STATEFULSET, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid DaemonSet cleanly on every version', async () => {
    // The fourth root, and the tripwire for the closure it adds.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_DAEMONSET, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Job cleanly on every version', async () => {
    // The fifth root, and the only one in the batch group — it reaches PodSpec
    // through the same PodTemplateSpec the apps kinds do, but its own spec and
    // the two policies hanging off it are its alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_JOB, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid CronJob cleanly on every version', async () => {
    // The sixth root, nested one level deeper than the other five: its
    // JobTemplateSpec wraps the same JobSpec the Job root already reaches, so
    // this is the tripwire for CronJob, CronJobSpec, CronJobStatus and
    // JobTemplateSpec specifically.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_CRONJOB, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Service cleanly on every version', async () => {
    // The seventh root, and the only one that shares nothing with the pod
    // closure — a truncated Service bundle would show up here alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_SERVICE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Ingress cleanly on every version', async () => {
    // The eighth root, and the only one outside the core and apps groups — a
    // regeneration that dropped the networking closure would show up here.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_INGRESS, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid IngressClass cleanly on every version', async () => {
    // The ninth root. It reaches only two definitions of its own, so a
    // regeneration that dropped them would be invisible everywhere but here.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_INGRESS_CLASS, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid PersistentVolume cleanly on every version', async () => {
    // The tenth root, and the one whose closure is genuinely new: the
    // *PersistentVolumeSource variants (CSIPersistentVolumeSource and so on)
    // are not reachable from any other root, so a regeneration that dropped
    // them would show up here alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_PERSISTENTVOLUME, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid PersistentVolumeClaim cleanly on every version', async () => {
    // The eleventh root. Its closure was already pulled in by StatefulSet's
    // volumeClaimTemplates, so this is the tripwire for the roots map alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_PERSISTENTVOLUMECLAIM, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid StorageClass cleanly on every version', async () => {
    // The twelfth root, and the only one outside core/v1, apps/v1, batch/v1
    // and networking/v1. Below its own definition it reaches the two
    // TopologySelector types and nothing else, so a regeneration that dropped
    // them would be invisible everywhere but here.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_STORAGE_CLASS, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid NetworkPolicy cleanly on every version', async () => {
    // The thirteenth root. podSelector is spelled out as {} rather than left
    // off, so this manifest lints clean even on the 1.25-1.33 bundles whose
    // generated NetworkPolicySpec still lists it as required — see "carries
    // NetworkPolicySpec.required inconsistently" below for that divergence.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_NETWORKPOLICY, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a NetworkPolicy the same way on every version', async () => {
    // Every field this rule module reads, endPort included, predates the
    // 1.25 floor, so nothing in it is version-gated.
    const yaml = networkPolicy(
      '  podSelector: {}\n  ingress:\n    - ports:\n        - port: 8080\n          endPort: 80\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['networkpolicy/endport-before-port']);
    }
  });

  it('lints a valid ConfigMap cleanly on every version', async () => {
    // The fourteenth root, and the cheapest of them all: below ObjectMeta it
    // reaches nothing, so the closure grows by its own definition alone and
    // this is the tripwire for the roots map more than for the closure.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_CONFIGMAP, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a ConfigMap the same way on every version', async () => {
    // core/v1 ConfigMap has carried data, binaryData and immutable since well
    // before the 1.25 floor, so nothing in its rule module is version-gated.
    const yaml = configMapData('  "log level": info\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['configmap/invalid-key']);
    }
  });

  it('lints a valid Secret cleanly on every version', async () => {
    // The fifteenth root, exactly as cheap as ConfigMap and for the same
    // reason: below ObjectMeta it reaches nothing, so this is the tripwire
    // for the roots map more than for the closure.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_SECRET, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a Secret the same way on every version', async () => {
    // core/v1 Secret has carried data, stringData, type and immutable since
    // well before the 1.25 floor, so nothing in its rule module is
    // version-gated.
    const yaml = secretData('  "log level": dGVzdA==\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['secret/invalid-key']);
    }
  });

  it('lints a valid ResourceQuota cleanly on every version', async () => {
    // The sixteenth root, and nearly as cheap as ConfigMap: its hard and used
    // maps are Quantity maps the Pod closure already carries, so it adds only
    // its own spec, status and the two scope-selector definitions.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_RESOURCEQUOTA, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a ResourceQuota the same way on every version', async () => {
    // core/v1 ResourceQuota has carried hard, scopes and scopeSelector since
    // well before the 1.25 floor, so nothing in its rule module is
    // version-gated.
    const yaml = resourceQuota('  hard:\n    secrets: "10"\n  scopes:\n    - BestEffort\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'resourcequota/scope-not-valid-for-resource',
      ]);
    }
  });

  it('lints a valid LimitRange cleanly on every version', async () => {
    // The seventeenth root, and the cheapest since ConfigMap: its five
    // constraint maps are Quantity maps the Pod closure already carries, so it
    // adds only its own definition, its spec and LimitRangeItem.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_LIMITRANGE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a LimitRange the same way on every version', async () => {
    // core/v1 LimitRange has been unchanged since well before the 1.25 floor,
    // so nothing in its rule module is version-gated.
    const yaml = limitRange('  limits:\n    - type: Pod\n      default:\n        cpu: "1"\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'limitrange/default-not-allowed',
      ]);
    }
  });

  it('lints a valid ServiceAccount cleanly on every version', async () => {
    // The eighteenth root and the cheapest of the lot: both reference types it
    // needs are already in the closure — ObjectReference through a
    // PersistentVolume's claimRef, LocalObjectReference through a PodSpec's own
    // imagePullSecrets — so it adds its own definition and nothing else.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_SERVICE_ACCOUNT, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a ServiceAccount the same way on every version', async () => {
    // Nothing in the module's own reference checks is version-gated: core/v1
    // ServiceAccount has carried all three fields since before the 1.25 floor.
    const yaml = serviceAccountSecrets('  - name: build-token\n    namespace: shared\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'serviceaccount/ignored-secret-field',
      ]);
    }
  });

  it('reports the enforce-mountable-secrets annotation as deprecated from 1.32 only', async () => {
    // The one version-conditional check `ctx.supports()` cannot express, since
    // an annotation is not a schema field: the apiserver began returning a
    // deprecation warning for it in 1.32, and on 1.25-1.31 the mechanism is
    // current, so saying anything there would be wrong rather than early.
    const yaml = serviceAccountEnforcing('"true"');
    for (const version of AVAILABLE_VERSIONS) {
      const expected = Number(version.split('.')[1]) >= 32;
      expect(await ruleIdsAt(version, yaml), version).toEqual(
        expected ? ['serviceaccount/deprecated-enforce-mountable-secrets'] : [],
      );
    }
  });

  it('leaves duplicate secrets entries to layer 1, which only describes them from 1.30', async () => {
    // Upstream's own generated OpenAPI gained x-kubernetes-list-type: map on
    // ServiceAccount.secrets in 1.30; before that it says nothing about the
    // list, so neither does the linter. The module deliberately does not fill
    // the gap, since doing so would double-report on 1.30 and up.
    const yaml = serviceAccountSecrets('  - name: build-token\n  - name: build-token\n');
    for (const version of AVAILABLE_VERSIONS) {
      const described = Number(version.split('.')[1]) >= 30;
      expect(await ruleIdsAt(version, yaml), version).toEqual(
        described ? ['schema/duplicate-list-entry'] : [],
      );
    }
  });

  it('lints a valid Role cleanly on every version', async () => {
    // The nineteenth root, and the first outside core/v1, apps/v1, batch/v1,
    // networking/v1 and storage/v1. It shares nothing below ObjectMeta with any
    // of them, but there is nothing to share: a PolicyRule is five lists of
    // plain strings, so the closure grows by Role and PolicyRule alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_ROLE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a Role the same way on every version', async () => {
    // Nothing in the module is version-gated: rbac/v1 has been served unchanged
    // since 1.8, long before the 1.25 floor, and every field a policy rule has
    // is in all twelve bundles.
    const yaml = policyRule('    apiGroups: [""]\n    resources: ["Pods"]\n    verbs: ["gets"]\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'role/uppercase-resource',
        'role/unknown-verb',
      ]);
    }
  });

  it('validates a Role name as a path segment on every version', async () => {
    // The one kind here whose name is not a DNS name of some sort: RBAC
    // validates it with path.IsValidPathSegmentName, which is what lets the
    // built-in roles carry colons and capitals.
    const yaml = role('rules: []\n', '  name: system:Controller_x\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['role/no-rules']);
    }
  });

  it('lints a valid ClusterRole cleanly on every version', async () => {
    // The twentieth root, and the cheaper half of the RBAC pair: PolicyRule is
    // already in the closure from Role, so this one grows it by ClusterRole
    // and AggregationRule alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_CLUSTER_ROLE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a ClusterRole the same way on every version', async () => {
    // Nothing in either RBAC module is version-gated: rbac/v1 has been served
    // unchanged since 1.8 and aggregationRule since 1.9, both long before the
    // 1.25 floor. The one thing that does move is upstream's own annotation of
    // `rules` as an atomic list from 1.30, which changes nothing here — atomic
    // is not the map type that would make layer 1 look for duplicates.
    const yaml = urlRule('["healthz"]', '["list"]');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'clusterrole/relative-non-resource-url',
        'clusterrole/non-resource-verb',
      ]);
    }
  });

  it('lints a valid RoleBinding cleanly on every version', async () => {
    // The twenty-first root, and the third of the RBAC four: it shares
    // ObjectMeta with everything and nothing else with Role or ClusterRole, so
    // it grows the closure by RoleBinding, RoleRef and Subject alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_ROLE_BINDING, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a RoleBinding the same way on every version', async () => {
    // Nothing in rules/rolebinding.ts is version-gated either: RoleBinding,
    // RoleRef and Subject have carried exactly these fields since rbac/v1 was
    // served in 1.8, and neither the defaulting the module leans on nor the
    // authorizer's subject matching has moved since.
    const yaml = bindingSubject(
      '    kind: User\n    name: alice\n    apiGroup: ""\n    namespace: default\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'rolebinding/ignored-subject-namespace',
      ]);
    }
  });

  it('lints a valid ClusterRoleBinding cleanly on every version', async () => {
    // The twenty-second root and the cheapest of them all: RoleRef and Subject
    // are already in the closure by way of RoleBinding, so it grows the bundle
    // by its own definition and nothing else on any version.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_CLUSTER_ROLE_BINDING, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a ClusterRoleBinding the same way on every version', async () => {
    // Both of the things this kind adds to a RoleBinding come from a switch
    // and a boolean argument in the validator rather than from a field, so
    // neither can vary with the schema: rbac/v1 has been served unchanged
    // since 1.8, and `subjects` being an atomic list from 1.30 changes nothing
    // — atomic is not the map type that would make layer 1 look for
    // duplicates, so the module's own duplicate check is the only one on every
    // version.
    const yaml = clusterRoleBinding(
      'subjects:\n  - kind: ServiceAccount\n    name: reader\n  - kind: User\n    name: alice\n    namespace: default\n',
      '  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: node-reader\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'clusterrolebinding/namespaced-role-ref',
        'clusterrolebinding/missing-subject-namespace',
        'rolebinding/ignored-subject-namespace',
      ]);
    }
  });

  it('lints a valid HTTPRoute cleanly on every version', async () => {
    // The twelfth root, and the first one sourced from a CRD rather than the
    // k8s swagger — HTTPRoute's definitions are the same on every k8s
    // version, pinned instead to one Gateway API release, so this is the
    // tripwire for that half of generation rather than for a per-version diff.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_HTTPROUTE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Gateway cleanly on every version', async () => {
    // The second root sourced from a CRD, sharing HTTPRoute's pinned Gateway
    // API release rather than tracking the k8s one.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_GATEWAY, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks a Gateway the same way on every version', async () => {
    // Like an HTTPRoute, its schema does not vary with the selected
    // Kubernetes version, so the findings must not either.
    const yaml = gatewayWithListener(
      '    - name: https\n      protocol: HTTPS\n      port: 443\n' +
        '      tls:\n        mode: Passthrough\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['gateway/tls-mode']);
    }
  });

  it('checks an HTTPRoute the same way on every version', async () => {
    // Its schema does not vary with the selected Kubernetes version at all,
    // so the same manifest has to produce the same findings across the range.
    const yaml = httpRouteWithRule(
      '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
        '      filters:\n        - type: RequestRedirect\n          requestRedirect:\n            statusCode: 302\n' +
        '      backendRefs:\n        - name: web\n          port: 80\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['httproute/redirect-with-backend-refs']);
    }
  });

  it('checks a StorageClass the same way on every version', async () => {
    // storage/v1 StorageClass predates the 1.25 floor and has not changed
    // since — allowedTopologies and volumeBindingMode included — so nothing in
    // its rule module is version-gated.
    const yaml = storageClassWith(
      'allowedTopologies:\n' +
        '  - matchLabelExpressions:\n' +
        '      - key: topology.kubernetes.io/zone\n' +
        '        values:\n' +
        '          - us-east-1a\n' +
        '      - key: topology.kubernetes.io/zone\n' +
        '        values:\n' +
        '          - us-east-1b\n',
    );
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'storageclass/duplicate-topology-key',
      ]);
    }
  });

  it('checks an IngressClass the same way on every version', async () => {
    // IngressClass reached v1 in 1.19 and its parameters reference has carried
    // scope and namespace since before the 1.25 floor, so nothing in its rule
    // module is version-gated.
    const yaml = ingressClassParameters('    kind: IngressParameters\n    name: p\n    namespace: ns\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'ingressclass/parameters-namespace-not-allowed',
      ]);
    }
  });

  it('checks an Ingress the same way on every version', async () => {
    // networking/v1 Ingress has been served unchanged since 1.19, so nothing in
    // its rule module is version-gated and the same manifest has to produce the
    // same findings across the whole range.
    const yaml = ingressWithPaths(ingressPath('/a', 'Exact') + ingressPath('/a', 'Exact'));
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['ingress/duplicate-path']);
    }
  });

  it('checks a Service the same way on every version', async () => {
    // Nothing this rule module reads arrived after 1.25, so the same manifest
    // has to produce the same findings across the whole range.
    const yaml = service('  type: LoadBalancer\n  clusterIP: None\n  ports:\n    - port: 80\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['service/headless-with-external-type']);
    }
  });

  it('applies version-gated pod spec rules under a DaemonSet template', async () => {
    const yaml = daemonSetWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a Deployment template', async () => {
    // hostnameOverride arrived in 1.34. The gate resolves the field through
    // the kind's own spec path, so it must still close on an older target
    // rather than silently passing everything.
    const yaml = deploymentWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a StatefulSet template', async () => {
    const yaml = statefulSetWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a Job template', async () => {
    const yaml = jobWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a CronJob template', async () => {
    // The sharpest test that the gate resolves through the deepest spec path
    // in the bundle: spec.jobTemplate.spec.template.spec, four segments below
    // the document root rather than the usual one or two.
    const yaml = cronJobWithPodSpec('          hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });
});

describe('Job fields that came and went', () => {
  it('accepts the per-index fields from 1.28', async () => {
    const yaml = job('  completionMode: Indexed\n  completions: 4\n  backoffLimitPerIndex: 1\n');

    expect(await ruleIdsAt('1.27', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.28', yaml)).toEqual([]);
  });

  it('does not double-report a per-index rule on a version without the field', async () => {
    // backoffLimitPerIndex needs Indexed completion, but on 1.27 the field does
    // not exist at all and only the schema layer should speak.
    const yaml = job('  backoffLimitPerIndex: 1\n');

    expect(await ruleIdsAt('1.27', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.28', yaml)).toEqual(['job/requires-indexed-completion']);
  });

  it('accepts successPolicy and managedBy from 1.30', async () => {
    const yaml = job(
      '  completionMode: Indexed\n  completions: 4\n  managedBy: kueue.x-k8s.io/multikueue\n' +
        '  successPolicy:\n    rules:\n      - succeededIndexes: "0-2"\n',
    );

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field', 'schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toEqual([]);
  });

  it('requires a pod condition status up to 1.34 in the schema and in the rule after', async () => {
    // 1.35 dropped `status` from the required list in the OpenAPI definition,
    // but validation still rejects a pattern without one — so the report has to
    // move from layer 1 to the rule module rather than disappear.
    const yaml = job(
      '  podFailurePolicy:\n    rules:\n      - action: Ignore\n' +
        '        onPodConditions:\n          - type: DisruptionTarget\n',
    );

    expect(await ruleIdsAt('1.34', yaml)).toEqual(['schema/required-field']);
    expect(await ruleIdsAt('1.35', yaml)).toEqual(['job/missing-pod-condition-status']);
    expect(await ruleIdsAt('1.36', yaml)).toEqual(['job/missing-pod-condition-status']);
  });
});

describe('Service fields that came and went', () => {
  it('accepts spec.trafficDistribution from 1.30', async () => {
    const yaml = service('  trafficDistribution: PreferClose\n  ports:\n    - port: 80\n');

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toEqual([]);
  });

  it('does not double-report a bad value on a version without the field', async () => {
    const yaml = service('  trafficDistribution: PreferNear\n  ports:\n    - port: 80\n');

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toContain('enum/invalid-value');
  });
});

describe('StatefulSet fields that came and went', () => {
  it('accepts spec.ordinals from 1.26', async () => {
    const yaml = statefulSet('  ordinals:\n    start: 1\n');

    expect(await ruleIdsAt('1.25', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.26', yaml)).toEqual([]);
  });

  it('does not double-report a negative ordinal on a version without the field', async () => {
    const yaml = statefulSet('  ordinals:\n    start: -1\n');

    expect(await ruleIdsAt('1.25', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.26', yaml)).toContain('statefulset/negative-ordinal-start');
  });

  it('requires serviceName up to 1.32 and leaves it optional from 1.33', async () => {
    // The headless Service stopped being mandatory in 1.33; the requirement
    // itself lives in the generated schema, so this pins the regeneration.
    const yaml = VALID_STATEFULSET.replace('  serviceName: db\n', '');

    expect(await ruleIdsAt('1.32', yaml)).toEqual(['schema/required-field']);
    expect(await ruleIdsAt('1.33', yaml)).toEqual([]);
  });
});

describe('PersistentVolume fields that came and went', () => {
  it('accepts spec.volumeAttributesClassName from 1.29', async () => {
    const yaml = persistentVolume(
      '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
        '  csi:\n    driver: csi.example.com\n    volumeHandle: vol-1\n  volumeAttributesClassName: silver\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toEqual([]);
  });

  it('does not double-report an invalid name on a version without the field', async () => {
    const yaml = persistentVolume(
      '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
        '  csi:\n    driver: csi.example.com\n    volumeHandle: vol-1\n  volumeAttributesClassName: Not_Valid\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toContain(
      'persistentvolume/invalid-volume-attributes-class-name',
    );
  });
});

describe('PersistentVolumeClaim fields that came and went', () => {
  it('accepts spec.volumeAttributesClassName from 1.29', async () => {
    const yaml = persistentVolumeClaim(
      '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Gi\n' +
        '  volumeAttributesClassName: silver\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toEqual([]);
  });

  it('does not double-report an invalid name on a version without the field', async () => {
    const yaml = persistentVolumeClaim(
      '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Gi\n' +
        '  volumeAttributesClassName: Not_Valid\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toContain(
      'persistentvolumeclaim/invalid-volume-attributes-class-name',
    );
  });
});

describe('NetworkPolicy carries NetworkPolicySpec.required inconsistently', () => {
  // Upstream's own generated OpenAPI document lists podSelector as required on
  // NetworkPolicySpec through 1.33 and stops in 1.34, even though the
  // apiserver has never actually rejected an absent one — the zero-value
  // LabelSelector is valid and means "every Pod in the namespace". The bundle
  // keeps upstream's definitions verbatim rather than patching around the
  // drift, so this is upstream's inconsistency to pin, not a rule of this
  // linter's.
  it('requires podSelector through 1.33 and stops in 1.34', async () => {
    const yaml = networkPolicy('  policyTypes:\n    - Ingress\n');

    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/required-field']);
    expect(await ruleIdsAt('1.34', yaml)).toEqual([]);
  });
});

describe('fields that came and went', () => {
  it('accepts spec.workloadRef on 1.35 only', async () => {
    // The sharpest check that per-version schemas are really applied:
    // workloadRef was added in 1.35 and removed again in 1.36.
    const yaml = pod('  workloadRef:\n    name: job-1\n  containers:\n    - name: web\n      image: a\n');

    expect(await ruleIdsAt('1.35', yaml)).not.toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.34', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.36', yaml)).toContain('schema/unknown-field');
  });

  it('accepts the image volume source from 1.31', async () => {
    const yaml = pod(
      '  containers:\n    - name: web\n      image: a\n' +
        '      volumeMounts:\n        - name: art\n          mountPath: /art\n' +
        '  volumes:\n    - name: art\n      image:\n        reference: registry.example/art:v1\n',
    );

    expect(await ruleIdsAt('1.30', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.31', yaml)).not.toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.36', yaml)).not.toContain('schema/unknown-field');
  });

  it('accepts pod-level resources from 1.32', async () => {
    const yaml = pod(
      '  resources:\n    limits:\n      cpu: "1"\n  containers:\n    - name: web\n      image: a\n',
    );

    expect(await ruleIdsAt('1.31', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.32', yaml)).not.toContain('schema/unknown-field');
  });

  it('accepts lifecycle stopSignal from 1.33', async () => {
    const yaml = podWithContainer('      lifecycle:\n        stopSignal: SIGUSR1\n');

    expect(await ruleIdsAt('1.32', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.33', yaml)).not.toContain('schema/unknown-field');
  });

  it('still validates enum values on the versions that have the field', async () => {
    // enums.ts self-gates through walkFields, so a bad value must be caught
    // where the field exists and reported as unknown where it does not.
    const yaml = podWithContainer('      lifecycle:\n        stopSignal: SIGNOPE\n');

    expect(await ruleIdsAt('1.33', yaml)).toContain('enum/invalid-value');
    expect(await ruleIdsAt('1.32', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.32', yaml)).not.toContain('enum/invalid-value');
  });
});

describe('version-sensitive rules', () => {
  const initWithProbe = pod(
    '  initContainers:\n    - name: init\n      image: a\n' +
      '      readinessProbe:\n        tcpSocket:\n          port: 1\n' +
      '  containers:\n    - name: web\n      image: b\n',
  );

  it('offers the sidecar fix from 1.28, when Container.restartPolicy exists', async () => {
    for (const version of ['1.28', '1.31', '1.36']) {
      const finding = lint(initWithProbe, await schemaFor(version)).findings.find(
        (entry) => entry.ruleId === 'pod/init-container-probe',
      );
      expect(finding?.fix?.ops, version).toEqual([
        { op: 'set', path: ['spec', 'initContainers', 0, 'restartPolicy'], value: 'Always' },
      ]);
    }
  });

  it('withholds the sidecar fix before 1.28 and says why', async () => {
    for (const version of ['1.25', '1.26', '1.27']) {
      const finding = lint(initWithProbe, await schemaFor(version)).findings.find(
        (entry) => entry.ruleId === 'pod/init-container-probe',
      );
      // The problem is still reported — only the fix that the target cluster
      // could not honour is withheld.
      expect(finding, version).toBeDefined();
      expect(finding?.fix, version).toBeUndefined();
      expect(finding?.explanation, version).toContain('1.28 or newer');
      expect(finding?.explanation, version).toContain(version);
    }
  });

  it('does not double-report a field the target version has never heard of', async () => {
    // hostnameOverride arrived in 1.34; on 1.33 the schema layer alone should
    // speak, not the name-format rule as well.
    const yaml = pod('  hostnameOverride: Not_A_DNS_Name\n  containers:\n    - name: web\n      image: a\n');

    const older = await ruleIdsAt('1.33', yaml);
    expect(older).toContain('schema/unknown-field');
    expect(older).not.toContain('pod/invalid-spec-name');

    expect(await ruleIdsAt('1.34', yaml)).toContain('pod/invalid-spec-name');
  });
});
