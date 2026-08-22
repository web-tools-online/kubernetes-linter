import { describe, expect, it } from 'vitest';
import {
  VALID_CLUSTER_ROLE,
  VALID_CLUSTER_ROLE_BINDING,
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
  VALID_ROLE,
  VALID_ROLE_BINDING,
  VALID_SECRET,
  VALID_SERVICE,
  VALID_SERVICE_ACCOUNT,
  VALID_STATEFULSET,
  VALID_STORAGE_CLASS,
  aggregatedClusterRole,
  bindingSubject,
  bindingSubjects,
  clusterBindingSubject,
  clusterBindingSubjects,
  clusterPolicyRule,
  clusterRole,
  clusterRoleBinding,
  configMap,
  configMapData,
  cronJob,
  cronJobWithPodSpec,
  daemonSet,
  daemonSetWithPodSpec,
  deployment,
  deploymentWithPodSpec,
  expectNoRule,
  expectRule,
  expectRules,
  findings,
  gateway,
  gatewayWithListener,
  httpRoute,
  httpRouteWithRule,
  ingress,
  ingressClass,
  ingressClassParameters,
  ingressPath,
  ingressWithPaths,
  job,
  jobWithPodSpec,
  limitRange,
  limitRangeItem,
  networkPolicy,
  networkPolicyWithPeer,
  persistentVolume,
  persistentVolumeClaim,
  pod,
  podWithContainer,
  policyRule,
  resourceQuota,
  resourceQuotaHard,
  role,
  roleBinding,
  roleVerbs,
  ruleIds,
  secret,
  secretData,
  service,
  serviceAccount,
  serviceAccountEnforcing,
  serviceAccountSecrets,
  statefulSet,
  statefulSetWithPodSpec,
  storageClass,
  storageClassWith,
  urlRule,
} from './helpers.js';

describe('metadata', () => {
  it('requires a name', () => {
    expectRule(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  labels: {}\nspec:\n  containers:\n    - name: web\n      image: a\n',
      'meta/missing-name',
    );
  });

  it('accepts generateName instead of name', () => {
    expectRules(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-\nspec:\n  containers:\n    - name: web\n      image: a\n',
      [],
    );
  });

  it('rejects an uppercase name and suggests a valid one', () => {
    const finding = expectRule(
      pod('  containers:\n    - name: web\n      image: a\n', '  name: Web-Pod\n'),
      'meta/invalid-name',
    );
    expect(finding.fix?.ops).toEqual([{ op: 'set', path: ['metadata', 'name'], value: 'web-pod' }]);
  });

  it('rejects a namespace that is not a DNS label', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n', '  name: web\n  namespace: My_Namespace\n'),
      'meta/invalid-namespace',
    );
  });

  it('rejects an over-long label value', () => {
    expectRule(
      pod(
        '  containers:\n    - name: web\n      image: a\n',
        `  name: web\n  labels:\n    app: ${'x'.repeat(64)}\n`,
      ),
      'meta/invalid-label-value',
    );
  });
});

describe('containers', () => {
  it('requires an image', () => {
    expectRule(pod('  containers:\n    - name: web\n'), 'pod/missing-image');
  });

  it('rejects an empty containers list', () => {
    expectRule(pod('  containers: []\n'), 'pod/no-containers');
  });

  it('rejects an invalid container name', () => {
    expectRule(pod('  containers:\n    - name: Web_1\n      image: a\n'), 'pod/invalid-container-name');
  });

  it('detects a name reused across containers and initContainers', () => {
    const finding = expectRule(
      pod('  initContainers:\n    - name: web\n      image: a\n  containers:\n    - name: web\n      image: b\n'),
      'pod/duplicate-container-name',
    );
    expect(finding.message).toContain('already used by container "web"');
    expect(finding.path).toEqual(['spec', 'initContainers', 0, 'name']);
  });

  it('rejects probes on a plain init container', () => {
    const finding = expectRule(
      pod('  initContainers:\n    - name: init\n      image: a\n      readinessProbe:\n        tcpSocket:\n          port: 1\n  containers:\n    - name: web\n      image: b\n'),
      'pod/init-container-probe',
    );
    expect(finding.fix?.title).toContain('sidecar');
  });

  it('allows probes on a sidecar init container', () => {
    expectNoRule(
      pod('  initContainers:\n    - name: init\n      image: a\n      restartPolicy: Always\n      readinessProbe:\n        tcpSocket:\n          port: 1\n  containers:\n    - name: web\n      image: b\n'),
      'pod/init-container-probe',
    );
  });

  it('rejects ports on an ephemeral container', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n  ephemeralContainers:\n    - name: debug\n      image: busybox\n      ports:\n        - containerPort: 80\n'),
      'pod/ephemeral-container-field',
    );
  });

  it('requires an absolute workingDir', () => {
    const finding = expectRule(podWithContainer('      workingDir: app\n'), 'pod/relative-working-dir');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'workingDir'], value: '/app' },
    ]);
  });
});

describe('enums', () => {
  it('corrects a lowercase enum value', () => {
    const finding = expectRule(podWithContainer('      imagePullPolicy: always\n'), 'enum/invalid-value');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'imagePullPolicy'], value: 'Always' },
    ]);
  });

  it('rejects an unrelated value without guessing', () => {
    const finding = expectRule(pod('  restartPolicy: Sometimes\n  containers:\n    - name: web\n      image: a\n'), 'enum/invalid-value');
    expect(finding.fix).toBeUndefined();
    expect(finding.explanation).toContain('"Always", "OnFailure", "Never"');
  });

  it('applies to nested types wherever they are reused', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n  tolerations:\n    - key: k\n      operator: exists\n'),
      'enum/invalid-value',
    );
  });

  it('accepts an empty value where the API allows it', () => {
    expectNoRule(
      pod('  containers:\n    - name: web\n      image: a\n  volumes:\n    - name: d\n      emptyDir:\n        medium: ""\n'),
      'enum/invalid-value',
    );
  });
});

describe('ports', () => {
  it('rejects an out-of-range port', () => {
    expectRule(podWithContainer('      ports:\n        - containerPort: 70000\n'), 'pod/port-out-of-range');
  });

  it('rejects an invalid port name', () => {
    const finding = expectRule(
      podWithContainer('      ports:\n        - containerPort: 80\n          name: HTTP-Port\n'),
      'pod/invalid-port-name',
    );
    expect(finding.message).toContain('lowercase');

    expect(
      expectRule(
        podWithContainer('      ports:\n        - containerPort: 80\n          name: a-very-long-port-name\n'),
        'pod/invalid-port-name',
      ).message,
    ).toContain('at most 15 characters');
  });

  it('detects a port name reused across containers', () => {
    expectRule(
      pod(
        '  containers:\n' +
          '    - name: a\n      image: a\n      ports:\n        - name: http\n          containerPort: 80\n' +
          '    - name: b\n      image: b\n      ports:\n        - name: http\n          containerPort: 81\n',
      ),
      'pod/duplicate-port-name',
    );
  });

  it('detects a host port claimed twice', () => {
    expectRule(
      pod(
        '  containers:\n' +
          '    - name: a\n      image: a\n      ports:\n        - containerPort: 80\n          hostPort: 8080\n' +
          '    - name: b\n      image: b\n      ports:\n        - containerPort: 81\n          hostPort: 8080\n',
      ),
      'pod/duplicate-host-port',
    );
  });

  it('requires hostPort to match containerPort on the host network', () => {
    const finding = expectRule(
      pod('  hostNetwork: true\n  dnsPolicy: ClusterFirstWithHostNet\n  containers:\n    - name: a\n      image: a\n      ports:\n        - containerPort: 80\n          hostPort: 8080\n'),
      'pod/host-network-port-mismatch',
    );
    expect(finding.fix?.safe).toBe(true);
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'ports', 0, 'hostPort'], value: 80 },
    ]);
  });
});

describe('env', () => {
  it('rejects value together with valueFrom', () => {
    expectRule(
      podWithContainer('      env:\n        - name: A\n          value: "1"\n          valueFrom:\n            fieldRef:\n              fieldPath: metadata.name\n'),
      'pod/env-value-and-value-from',
    );
  });

  it('requires exactly one valueFrom source', () => {
    expectRule(
      podWithContainer('      env:\n        - name: A\n          valueFrom:\n            fieldRef:\n              fieldPath: metadata.name\n            secretKeyRef:\n              name: s\n              key: k\n'),
      'pod/multiple-value-from',
    );
  });

  it('warns about a duplicate variable', () => {
    const finding = expectRule(
      podWithContainer('      env:\n        - name: A\n          value: "1"\n        - name: A\n          value: "2"\n'),
      'pod/duplicate-env-name',
    );
    expect(finding.severity).toBe('warning');
  });

  it('requires exactly one envFrom source', () => {
    expectRule(podWithContainer('      envFrom:\n        - prefix: APP_\n'), 'pod/empty-env-from');
  });
});

describe('volumes', () => {
  const withVolume = (volume: string, mount = '      volumeMounts:\n        - name: data\n          mountPath: /data\n') =>
    pod(`  containers:\n    - name: web\n      image: a\n${mount}  volumes:\n${volume}`);

  it('requires exactly one volume source', () => {
    expectRule(withVolume('    - name: data\n'), 'pod/volume-without-source');
    expectRule(
      withVolume('    - name: data\n      emptyDir: {}\n      hostPath:\n        path: /tmp\n'),
      'pod/volume-multiple-sources',
    );
  });

  it('detects a mount pointing at an undeclared volume and suggests the right one', () => {
    const finding = expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: dat\n          mountPath: /data\n',
      ),
      'pod/volume-mount-not-found',
    );
    expect(finding.message).toContain('Did you mean "data"');
    expect(finding.fix?.safe).toBe(true);
  });

  it('offers to declare a volume when nothing is close', () => {
    const finding = expectRule(
      pod('  containers:\n    - name: web\n      image: a\n      volumeMounts:\n        - name: cache\n          mountPath: /c\n'),
      'pod/volume-mount-not-found',
    );
    expect(finding.fix?.ops[0]).toMatchObject({ op: 'insert', path: ['spec', 'volumes'] });
  });

  it('requires an absolute, unique mountPath', () => {
    expectRule(
      withVolume('    - name: data\n      emptyDir: {}\n', '      volumeMounts:\n        - name: data\n          mountPath: data\n'),
      'pod/relative-mount-path',
    );
    expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n    - name: other\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: data\n          mountPath: /data\n        - name: other\n          mountPath: /data\n',
      ),
      'pod/duplicate-mount-path',
    );
  });

  it('rejects a subPath that escapes the volume', () => {
    expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: data\n          mountPath: /data\n          subPath: ../etc\n',
      ),
      'pod/sub-path-escapes-volume',
    );
  });
});

describe('resources', () => {
  const resources = (block: string) => podWithContainer(`      resources:\n${block}`);

  it('rejects a request larger than its limit', () => {
    const finding = expectRule(
      resources('        requests:\n          cpu: "500m"\n        limits:\n          cpu: "200m"\n'),
      'pod/request-exceeds-limit',
    );
    expect(finding.fix?.safe).toBe(false);
  });

  it('compares across suffixes', () => {
    expectRule(
      resources('        requests:\n          memory: "1Gi"\n        limits:\n          memory: "512Mi"\n'),
      'pod/request-exceeds-limit',
    );
    expectNoRule(
      resources('        requests:\n          memory: "512Mi"\n        limits:\n          memory: "1Gi"\n'),
      'pod/request-exceeds-limit',
    );
  });

  it('warns when memory is given in milli-units', () => {
    const finding = expectRule(resources('        limits:\n          memory: "512m"\n'), 'pod/milli-byte-quantity');
    expect(finding.message).toContain('0.512 bytes');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'resources', 'limits', 'memory'], value: '512Mi' },
    ]);
  });

  it('rejects an unqualified non-standard resource', () => {
    const finding = expectRule(resources('        limits:\n          gpu: "1"\n'), 'pod/unknown-resource-name');
    expect(finding.explanation).toContain('nvidia.com/gpu');
  });

  it('accepts a domain-qualified extended resource', () => {
    expectNoRule(resources('        limits:\n          nvidia.com/gpu: "1"\n'), 'pod/unknown-resource-name');
  });

  it('corrects a misspelled standard resource', () => {
    const finding = expectRule(resources('        limits:\n          memroy: "1Gi"\n'), 'pod/unknown-resource-name');
    expect(finding.fix?.ops).toEqual([
      { op: 'rename', path: ['spec', 'containers', 0, 'resources', 'limits', 'memroy'], to: 'memory' },
    ]);
  });
});

describe('probes', () => {
  const probe = (block: string) => podWithContainer(`      livenessProbe:\n${block}`);

  it('requires exactly one handler', () => {
    expectRule(probe('        periodSeconds: 10\n'), 'pod/probe-without-handler');
    expectRule(
      probe('        httpGet:\n          port: 8080\n        exec:\n          command: ["true"]\n'),
      'pod/probe-multiple-handlers',
    );
  });

  it('requires successThreshold 1 for liveness and startup', () => {
    const finding = expectRule(
      probe('        httpGet:\n          port: 8080\n        successThreshold: 3\n'),
      'pod/probe-success-threshold',
    );
    expect(finding.fix?.safe).toBe(true);
  });

  it('allows a higher successThreshold on readiness', () => {
    expectNoRule(
      podWithContainer('      readinessProbe:\n        httpGet:\n          port: 8080\n        successThreshold: 3\n'),
      'pod/probe-success-threshold',
    );
  });

  it('rejects out-of-range timings', () => {
    expectRule(probe('        httpGet:\n          port: 8080\n        timeoutSeconds: 0\n'), 'pod/probe-value-out-of-range');
  });

  it('resolves a named probe port against the container ports', () => {
    expectNoRule(
      podWithContainer(
        '      ports:\n        - name: http\n          containerPort: 8080\n' +
          '      livenessProbe:\n        httpGet:\n          port: http\n',
      ),
      'pod/probe-port-name-not-found',
    );
    const finding = expectRule(
      podWithContainer(
        '      ports:\n        - name: http\n          containerPort: 8080\n' +
          '      livenessProbe:\n        httpGet:\n          port: htpp\n',
      ),
      'pod/probe-port-name-not-found',
    );
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'livenessProbe', 'httpGet', 'port'], value: 'http' },
    ]);
  });

  it('checks lifecycle hooks the same way', () => {
    expectRule(
      podWithContainer('      lifecycle:\n        preStop:\n          exec:\n            command: ["a"]\n          sleep:\n            seconds: 5\n'),
      'pod/hook-multiple-handlers',
    );
  });
});

describe('pod spec cross-field rules', () => {
  const spec = (fragment: string) => pod(`${fragment}  containers:\n    - name: web\n      image: a\n`);

  it('requires a nameserver when dnsPolicy is None', () => {
    expectRule(spec('  dnsPolicy: None\n'), 'pod/dns-none-without-config');
    expectNoRule(
      spec('  dnsPolicy: None\n  dnsConfig:\n    nameservers:\n      - 1.1.1.1\n'),
      'pod/dns-none-without-config',
    );
  });

  it('warns about cluster DNS on the host network', () => {
    const finding = expectRule(spec('  hostNetwork: true\n'), 'pod/host-network-dns-policy');
    expect(finding.severity).toBe('warning');
    expectNoRule(
      spec('  hostNetwork: true\n  dnsPolicy: ClusterFirstWithHostNet\n'),
      'pod/host-network-dns-policy',
    );
  });

  it('rejects shareProcessNamespace together with hostPID', () => {
    expectRule(spec('  hostPID: true\n  shareProcessNamespace: true\n'), 'pod/share-process-namespace-conflict');
  });

  it('rejects hostUsers: false alongside a host namespace', () => {
    expectRule(spec('  hostUsers: false\n  hostIPC: true\n'), 'pod/host-users-conflict');
  });

  it('renames the deprecated serviceAccount field', () => {
    const finding = expectRule(spec('  serviceAccount: builder\n'), 'pod/deprecated-service-account');
    expect(finding.fix?.ops).toEqual([
      { op: 'rename', path: ['spec', 'serviceAccount'], to: 'serviceAccountName' },
    ]);
  });

  it('rejects a serviceAccount that disagrees with serviceAccountName', () => {
    expectRule(
      spec('  serviceAccount: old\n  serviceAccountName: new\n'),
      'pod/service-account-mismatch',
    );
  });

  it('warns that nodeName bypasses scheduling constraints', () => {
    expectRule(spec('  nodeName: node-1\n  nodeSelector:\n    disk: ssd\n'), 'pod/node-name-bypasses-scheduler');
  });

  it('rejects Linux-only fields on a Windows Pod', () => {
    expectRule(spec('  os:\n    name: windows\n  hostPID: true\n'), 'pod/windows-unsupported-field');
  });
});

describe('scheduling', () => {
  const spec = (fragment: string) => pod(`${fragment}  containers:\n    - name: web\n      image: a\n`);

  it('rejects values on a unary selector operator', () => {
    const finding = expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: disk\n                operator: Exists\n                values: ["ssd"]\n',
      ),
      'pod/selector-values-forbidden',
    );
    expect(finding.fix?.safe).toBe(true);
  });

  it('requires values on a set operator', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: disk\n                operator: In\n',
      ),
      'pod/selector-values-required',
    );
  });

  it('requires an integer for Gt and Lt', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: cores\n                operator: Gt\n                values: ["many"]\n',
      ),
      'pod/selector-value-not-integer',
    );
  });

  it('rejects an out-of-range preference weight', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      preferredDuringSchedulingIgnoredDuringExecution:\n        - weight: 500\n          preference:\n            matchExpressions:\n              - key: disk\n                operator: Exists\n',
      ),
      'pod/invalid-weight',
    );
  });

  it('rejects a value on an Exists toleration', () => {
    expectRule(spec('  tolerations:\n    - key: k\n      operator: Exists\n      value: v\n'), 'pod/toleration-exists-with-value');
  });

  it('rejects tolerationSeconds without NoExecute', () => {
    expectRule(
      spec('  tolerations:\n    - key: k\n      operator: Exists\n      effect: NoSchedule\n      tolerationSeconds: 30\n'),
      'pod/toleration-seconds-without-no-execute',
    );
  });

  it('checks topology spread constraints', () => {
    expectRule(
      spec('  topologySpreadConstraints:\n    - maxSkew: 0\n      topologyKey: zone\n      whenUnsatisfiable: DoNotSchedule\n'),
      'pod/invalid-max-skew',
    );
    expectRule(
      spec('  topologySpreadConstraints:\n    - maxSkew: 1\n      topologyKey: zone\n      whenUnsatisfiable: ScheduleAnyway\n      minDomains: 2\n'),
      'pod/min-domains-requires-do-not-schedule',
    );
  });
});

describe('security context consistency', () => {
  it('rejects runAsNonRoot together with UID 0', () => {
    expectRule(
      pod('  securityContext:\n    runAsNonRoot: true\n    runAsUser: 0\n  containers:\n    - name: web\n      image: a\n'),
      'pod/run-as-non-root-conflict',
    );
  });

  it('rejects privileged together with allowPrivilegeEscalation: false', () => {
    expectRule(
      podWithContainer('      securityContext:\n        privileged: true\n        allowPrivilegeEscalation: false\n'),
      'pod/privileged-without-escalation',
    );
  });

  it('requires localhostProfile for a Localhost seccomp profile', () => {
    expectRule(
      podWithContainer('      securityContext:\n        seccompProfile:\n          type: Localhost\n'),
      'pod/localhost-profile-missing',
    );
  });

  it('rejects localhostProfile for a RuntimeDefault profile', () => {
    expectRule(
      podWithContainer('      securityContext:\n        seccompProfile:\n          type: RuntimeDefault\n          localhostProfile: p.json\n'),
      'pod/localhost-profile-unexpected',
    );
  });
});

describe('deployment', () => {
  it('accepts a minimal Deployment', () => {
    expectRules(VALID_DEPLOYMENT, []);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('    matchLabels:\n      app: web\n', '    matchLabels: {}\n'),
        'deployment/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      app: frontend\n  template'),
        'deployment/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'metadata', 'labels', 'app'],
          value: 'frontend',
        },
      ]);
    });

    it('reports a selector label the template omits entirely', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      app: web\n      tier: api\n  template'),
        'deployment/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels']);
      expect(finding.message).toContain('tier: api');
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'deployment/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('accepts a matchExpressions selector the template satisfies', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n',
      );
      expectRules(yaml, []);
    });

    it('checks operator and values consistency under the deployment namespace', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [web]\n',
      );
      const finding = expectRule(yaml, 'deployment/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });

    it('validates selector label keys', () => {
      expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      not a key: web\n  template'),
        'meta/invalid-label-key',
      );
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      restartPolicy: OnFailure\n'),
        'deployment/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('accepts restartPolicy Always', () => {
      expectRules(deploymentWithPodSpec('      restartPolicy: Always\n'), []);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'deployment/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        deploymentWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'deployment/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_DEPLOYMENT.replace(
          '      labels:\n        app: web\n',
          '      labels:\n        app: web\n      annotations:\n        "bad key": x\n',
        ),
        'meta/invalid-annotation-key',
      );
    });
  });

  describe('counters', () => {
    it('rejects negative replicas', () => {
      const finding = expectRule(deployment('  replicas: -1\n'), 'deployment/negative-replicas');
      expect(finding.path).toEqual(['spec', 'replicas']);
    });

    it('accepts zero replicas', () => {
      expectRules(deployment('  replicas: 0\n'), []);
    });

    it('rejects a negative minReadySeconds', () => {
      expectRule(deployment('  minReadySeconds: -5\n'), 'deployment/negative-min-ready-seconds');
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        deployment('  revisionHistoryLimit: -1\n'),
        'deployment/negative-revision-history-limit',
      );
    });

    it('requires progressDeadlineSeconds above minReadySeconds', () => {
      const finding = expectRule(
        deployment('  minReadySeconds: 30\n  progressDeadlineSeconds: 30\n'),
        'deployment/invalid-progress-deadline',
      );
      expect(finding.message).toContain('greater than minReadySeconds');
    });

    it('accepts a progressDeadlineSeconds above minReadySeconds', () => {
      expectRules(deployment('  minReadySeconds: 30\n  progressDeadlineSeconds: 60\n'), []);
    });
  });

  describe('strategy', () => {
    it('rejects rollingUpdate under a Recreate strategy', () => {
      const finding = expectRule(
        deployment('  strategy:\n    type: Recreate\n    rollingUpdate:\n      maxSurge: 1\n'),
        'deployment/rolling-update-with-recreate',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'strategy', 'rollingUpdate'] },
      ]);
    });

    it('accepts rollingUpdate under a RollingUpdate strategy', () => {
      expectRules(
        deployment('  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 1\n'),
        [],
      );
    });

    it('rejects maxUnavailable and maxSurge both at zero', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 0\n'),
        'deployment/max-unavailable-and-surge-zero',
      );
    });

    it('accepts maxUnavailable 0 when maxSurge is not', () => {
      expectRules(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 1\n'),
        [],
      );
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 150%\n'),
        'deployment/percent-over-100',
      );
    });

    it('accepts percentages within range', () => {
      expectRules(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 25%\n      maxSurge: 25%\n'),
        [],
      );
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxSurge: two\n'),
        'deployment/invalid-percent',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(deployment('  strategy:\n    type: Rolling\n'), 'enum/invalid-value');
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'spec', 'dnsConfig', 'nameservers'],
          value: ['1.1.1.1'],
        },
      ]);
    });

    it('reports a bad container image at the template path', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('          image: nginx:1.27-alpine\n', ''),
        'pod/missing-image',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'containers', 0]);
    });

    it('checks the Deployment\'s own name, not the template\'s', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('  name: web\n', '  name: Web-App\n'),
        'meta/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('Deployment name');
    });
  });
});

describe('statefulset', () => {
  it('accepts a minimal StatefulSet', () => {
    expectRules(VALID_STATEFULSET, []);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('    matchLabels:\n      app: db\n', '    matchLabels: {}\n'),
        'statefulset/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('      app: db\n  template', '      app: postgres\n  template'),
        'statefulset/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'metadata', 'labels', 'app'],
          value: 'postgres',
        },
      ]);
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_STATEFULSET.replace(
        '    matchLabels:\n      app: db\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'statefulset/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('checks operator and values consistency under the statefulset namespace', () => {
      const yaml = VALID_STATEFULSET.replace(
        '    matchLabels:\n      app: db\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [db]\n',
      );
      const finding = expectRule(yaml, 'statefulset/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      restartPolicy: OnFailure\n'),
        'statefulset/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'statefulset/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        statefulSetWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'statefulset/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_STATEFULSET.replace(
          '      labels:\n        app: db\n',
          '      labels:\n        app: db\n      annotations:\n        "bad key": x\n',
        ),
        'meta/invalid-annotation-key',
      );
    });
  });

  describe('serviceName', () => {
    it('requires a DNS label, with a fix when one can be spelled', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: DB-Headless\n'),
        'statefulset/invalid-service-name',
      );
      expect(finding.path).toEqual(['spec', 'serviceName']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'serviceName'], value: 'db-headless' },
      ]);
    });

    it('withholds the fix when the obvious rewrite is still not a label', () => {
      // Lowercasing "DB.headless" leaves the dot, which a Service name may not
      // carry — a name that is a subdomain but not a label.
      const finding = expectRule(
        VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: DB.headless\n'),
        'statefulset/invalid-service-name',
      );
      expect(finding.fix).toBeUndefined();
    });

    it('accepts an empty serviceName, which asks for no governing Service', () => {
      expectRules(VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: ""\n'), []);
    });
  });

  describe('counters', () => {
    it('rejects negative replicas', () => {
      const finding = expectRule(statefulSet('  replicas: -1\n'), 'statefulset/negative-replicas');
      expect(finding.path).toEqual(['spec', 'replicas']);
    });

    it('accepts zero replicas', () => {
      expectRules(statefulSet('  replicas: 0\n'), []);
    });

    it('rejects a negative minReadySeconds', () => {
      expectRule(statefulSet('  minReadySeconds: -5\n'), 'statefulset/negative-min-ready-seconds');
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        statefulSet('  revisionHistoryLimit: -1\n'),
        'statefulset/negative-revision-history-limit',
      );
    });

    it('rejects a negative ordinals.start', () => {
      const finding = expectRule(
        statefulSet('  ordinals:\n    start: -1\n'),
        'statefulset/negative-ordinal-start',
      );
      expect(finding.path).toEqual(['spec', 'ordinals', 'start']);
    });

    it('accepts an ordinals.start above zero', () => {
      expectRules(statefulSet('  ordinals:\n    start: 5\n'), []);
    });
  });

  describe('update strategy', () => {
    it('rejects rollingUpdate under an OnDelete strategy', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      partition: 1\n'),
        'statefulset/rolling-update-with-on-delete',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] },
      ]);
    });

    it('accepts rollingUpdate under a RollingUpdate strategy', () => {
      expectRules(
        statefulSet('  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      partition: 2\n'),
        [],
      );
    });

    it('rejects a negative partition', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      partition: -1\n'),
        'statefulset/negative-partition',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'partition']);
    });

    it('rejects maxUnavailable at zero', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n'),
        'statefulset/invalid-max-unavailable',
      );
      expect(finding.message).toContain('greater than 0');
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 150%\n'),
        'statefulset/percent-over-100',
      );
    });

    it('accepts a percentage within range', () => {
      expectRules(statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 50%\n'), []);
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: two\n'),
        'statefulset/invalid-max-unavailable',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(statefulSet('  updateStrategy:\n    type: Rolling\n'), 'enum/invalid-value');
    });

    it('checks podManagementPolicy through the enum table', () => {
      expectRule(statefulSet('  podManagementPolicy: Ordered\n'), 'enum/invalid-value');
    });

    it('checks the claim retention policy through the enum table', () => {
      expectRule(
        statefulSet('  persistentVolumeClaimRetentionPolicy:\n    whenDeleted: delete\n'),
        'enum/invalid-value',
      );
    });
  });

  describe('volume claim templates', () => {
    it('lets a mount reference a claim template', () => {
      // The volume is generated by the controller, so it is nowhere in the
      // pod spec's own volumes list.
      expectNoRule(VALID_STATEFULSET, 'pod/volume-mount-not-found');
    });

    it('still reports a mount that matches neither a volume nor a claim template', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('            - name: data\n', '            - name: date\n'),
        'pod/volume-mount-not-found',
      );
      expect(finding.message).toContain('Did you mean "data"');
    });

    it('requires a name', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('    - metadata:\n        name: data\n', '    - metadata: {}\n'),
        'statefulset/claim-template-without-name',
      );
      expect(finding.path).toEqual(['spec', 'volumeClaimTemplates', 0]);
    });

    it('requires the name to be a DNS label', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('        name: data\n', '        name: Data_Volume\n'),
        'statefulset/invalid-claim-template-name',
      );
      expect(finding.path).toEqual(['spec', 'volumeClaimTemplates', 0, 'metadata', 'name']);
    });

    it('rejects two claim templates with the same name', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace(
          '    - metadata:\n        name: data\n',
          '    - metadata:\n        name: data\n      spec:\n        accessModes: ["ReadWriteOnce"]\n        resources:\n          requests:\n            storage: 1Gi\n    - metadata:\n        name: data\n',
        ),
        'statefulset/duplicate-claim-template',
      );
      expect(finding.message).toContain('entry 1');
    });

    it('warns when a claim template shadows a volume in the pod template', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace(
          '  volumeClaimTemplates:\n',
          '      volumes:\n        - name: data\n          emptyDir: {}\n  volumeClaimTemplates:\n',
        ),
        'statefulset/claim-template-shadows-volume',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('"data"');
    });

    it('validates the claim spec through the schema layer', () => {
      expectRule(
        VALID_STATEFULSET.replace('            storage: 1Gi\n', '            storage: 1 Gi\n'),
        'schema/quantity',
      );
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
    });

    it("checks the StatefulSet's own name, not the template's", () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('  name: db\n', '  name: DB-Primary\n'),
        'meta/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('StatefulSet name');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['metadata', 'name'], value: 'db-primary' },
      ]);
    });

    it('names a StatefulSet with a DNS label, where other kinds take a subdomain', () => {
      // The name is the prefix of every Pod name the set generates, and those
      // are hostnames — so a dot is fine on a Deployment and not here.
      expectRules(VALID_DEPLOYMENT.replace('  name: web\n', '  name: web.api\n'), []);
      expectRule(
        VALID_STATEFULSET.replace('  name: db\n', '  name: db.primary\n'),
        'meta/invalid-name',
      );
    });
  });
});

describe('daemonset', () => {
  it('accepts a minimal DaemonSet', () => {
    expectRules(VALID_DAEMONSET, []);
  });

  it('has no replica count, so the schema layer reports one', () => {
    // The mistake a DaemonSet invites most: its Pod count is the number of
    // matching nodes, so DaemonSetSpec has no such field.
    const finding = expectRule(daemonSet('  replicas: 3\n'), 'schema/unknown-field');
    expect(finding.path).toEqual(['spec', 'replicas']);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace(
          '    matchLabels:\n      app: node-exporter\n',
          '    matchLabels: {}\n',
        ),
        'daemonset/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace('      app: node-exporter\n  template', '      app: metrics\n  template'),
        'daemonset/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'metadata', 'labels', 'app'], value: 'metrics' },
      ]);
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_DAEMONSET.replace(
        '    matchLabels:\n      app: node-exporter\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'daemonset/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('checks operator and values consistency under the daemonset namespace', () => {
      const yaml = VALID_DAEMONSET.replace(
        '    matchLabels:\n      app: node-exporter\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [node-exporter]\n',
      );
      const finding = expectRule(yaml, 'daemonset/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      restartPolicy: OnFailure\n'),
        'daemonset/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'daemonset/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        daemonSetWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'daemonset/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_DAEMONSET.replace(
          '      labels:\n        app: node-exporter\n',
          '      labels:\n        app: node-exporter\n      annotations:\n        "bad key": x\n',
        ),
        'meta/invalid-annotation-key',
      );
    });
  });

  describe('counters', () => {
    it('rejects a negative minReadySeconds', () => {
      const finding = expectRule(
        daemonSet('  minReadySeconds: -5\n'),
        'daemonset/negative-min-ready-seconds',
      );
      expect(finding.path).toEqual(['spec', 'minReadySeconds']);
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        daemonSet('  revisionHistoryLimit: -1\n'),
        'daemonset/negative-revision-history-limit',
      );
    });
  });

  describe('update strategy', () => {
    it('warns that rollingUpdate is ignored under an OnDelete strategy', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      maxUnavailable: 1\n'),
        'daemonset/rolling-update-with-on-delete',
      );
      // Unlike a Deployment or a StatefulSet the apiserver accepts this, so it
      // is a warning and the removal is not offered as a safe fix.
      expect(finding.severity).toBe('warning');
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] },
      ]);
    });

    it('says nothing about the contents of a block the controller ignores', () => {
      // The apiserver stops validating the strategy at type: OnDelete, so a
      // rollout that would be rejected under RollingUpdate is only reported as
      // dead configuration.
      expectRules(
        daemonSet(
          '  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      maxUnavailable: 1\n      maxSurge: 1\n',
        ),
        ['daemonset/rolling-update-with-on-delete'],
      );
    });

    it('accepts maxUnavailable on its own', () => {
      expectRules(
        daemonSet('  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxUnavailable: 2\n'),
        [],
      );
    });

    it('accepts maxSurge on its own', () => {
      expectRules(daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxSurge: 1\n'), []);
    });

    it('accepts an empty rollingUpdate, which the API defaults', () => {
      expectRules(daemonSet('  updateStrategy:\n    rollingUpdate: {}\n'), []);
    });

    it('rejects maxSurge alongside a non-zero maxUnavailable', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 1\n      maxSurge: 1\n'),
        'daemonset/max-surge-with-max-unavailable',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'maxSurge']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'updateStrategy', 'rollingUpdate', 'maxUnavailable'], value: 0 },
      ]);
    });

    it('rejects both at zero', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 0\n'),
        'daemonset/max-unavailable-and-surge-zero',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'maxUnavailable']);
    });

    it('accepts maxUnavailable at zero when maxSurge takes over', () => {
      expectRules(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 30%\n'),
        [],
      );
    });

    it('rejects a negative count', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: -1\n'),
        'daemonset/invalid-percent',
      );
      expect(finding.message).toContain('must not be negative');
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxSurge: 150%\n'),
        'daemonset/percent-over-100',
      );
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: two\n'),
        'daemonset/invalid-percent',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(daemonSet('  updateStrategy:\n    type: Rolling\n'), 'enum/invalid-value');
    });
  });

  describe('volumes', () => {
    const withDisk = (readOnly: string) =>
      daemonSetWithPodSpec(
        `      volumes:\n        - name: disk\n          gcePersistentDisk:\n            pdName: data\n${readOnly}`,
      );

    it('rejects a read-write GCE persistent disk', () => {
      const finding = expectRule(
        withDisk('            readOnly: false\n'),
        'daemonset/read-write-persistent-disk',
      );
      expect(finding.path).toEqual([
        'spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk', 'readOnly',
      ]);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk', 'readOnly'],
          value: true,
        },
      ]);
    });

    it('reports an omitted readOnly on the volume source, since it defaults to false', () => {
      const finding = expectRule(withDisk(''), 'daemonset/read-write-persistent-disk');
      expect(finding.path).toEqual([
        'spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk',
      ]);
      expect(finding.message).toContain('"disk"');
    });

    it('accepts a read-only one', () => {
      expectNoRule(withDisk('            readOnly: true\n'), 'daemonset/read-write-persistent-disk');
    });

    it('leaves the same volume alone on a Deployment', () => {
      // ValidateReadOnlyPersistentDisks is the DaemonSet's own check; a
      // Deployment can perfectly well run a single Pod with a writable disk.
      expectNoRule(
        deploymentWithPodSpec(
          '      volumes:\n        - name: disk\n          gcePersistentDisk:\n            pdName: data\n',
        ),
        'daemonset/read-write-persistent-disk',
      );
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
    });

    it("checks the DaemonSet's own name, not the template's", () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace('  name: node-exporter\n', '  name: Node_Exporter\n'),
        'meta/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('DaemonSet name');
    });
  });
});

describe('job', () => {
  it('accepts a minimal Job', () => {
    expectRules(VALID_JOB, []);
  });

  describe('selector', () => {
    it('rejects a hand-written selector without manualSelector', () => {
      const finding = expectRule(
        job('  selector:\n    matchLabels:\n      app: import\n'),
        'job/generated-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
      expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['spec', 'selector'] }]);
    });

    it('accepts one that says it is manual, if the template agrees', () => {
      expectRules(
        job('  manualSelector: true\n  selector:\n    matchLabels:\n      app: import\n').replace(
          '  template:\n    spec:\n',
          '  template:\n    metadata:\n      labels:\n        app: import\n    spec:\n',
        ),
        [],
      );
    });

    it('reports a template label that contradicts a manual selector', () => {
      const finding = expectRule(
        job('  manualSelector: true\n  selector:\n    matchLabels:\n      app: import\n'),
        'job/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels']);
    });

    it('checks operator and values consistency under the job namespace', () => {
      const yaml = job(
        '  manualSelector: true\n  selector:\n    matchExpressions:\n' +
          '      - key: app\n        operator: Exists\n        values: [import]\n',
      );
      const finding = expectRule(yaml, 'job/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });
  });

  describe('pod template', () => {
    it('rejects a template with no restartPolicy, since the default is Always', () => {
      const finding = expectRule(
        VALID_JOB.replace('      restartPolicy: Never\n', ''),
        'job/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec']);
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Never' },
      ]);
    });

    it('rejects a restartPolicy written with no value, which decodes the same way', () => {
      const finding = expectRule(
        VALID_JOB.replace('restartPolicy: Never', 'restartPolicy:'),
        'job/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
    });

    it('rejects restartPolicy Always', () => {
      const finding = expectRule(
        VALID_JOB.replace('restartPolicy: Never', 'restartPolicy: Always'),
        'job/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
    });

    it('accepts OnFailure', () => {
      expectRules(VALID_JOB.replace('restartPolicy: Never', 'restartPolicy: OnFailure'), []);
    });

    it('leaves an unrecognised restart policy to the enum rule', () => {
      expectRules(VALID_JOB.replace('restartPolicy: Never', 'restartPolicy: never'), [
        'enum/invalid-value',
      ]);
    });

    it('requires Never beside a pod failure policy', () => {
      const yaml = job(
        '  podFailurePolicy:\n    rules:\n      - action: Ignore\n' +
          '        onPodConditions:\n          - type: DisruptionTarget\n            status: "True"\n',
      ).replace('restartPolicy: Never', 'restartPolicy: OnFailure');
      const finding = expectRule(yaml, 'job/restart-policy-with-pod-failure-policy');
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
    });

    it('accepts OnFailure beside backoffLimitPerIndex, which no release rejects', () => {
      const yaml = job(
        '  completionMode: Indexed\n  completions: 4\n  backoffLimitPerIndex: 1\n',
      ).replace('restartPolicy: Never', 'restartPolicy: OnFailure');
      expectRules(yaml, []);
    });

    it('forbids ephemeral containers', () => {
      const finding = expectRule(
        jobWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'job/template-ephemeral-containers',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'ephemeralContainers']);
    });
  });

  describe('counters', () => {
    it('rejects negative values', () => {
      for (const [field, ruleId] of [
        ['parallelism', 'job/negative-parallelism'],
        ['completions', 'job/negative-completions'],
        ['backoffLimit', 'job/negative-backoff-limit'],
        ['activeDeadlineSeconds', 'job/negative-active-deadline'],
        ['ttlSecondsAfterFinished', 'job/negative-ttl'],
      ] as const) {
        const finding = expectRule(job(`  ${field}: -1\n`), ruleId);
        expect(finding.path).toEqual(['spec', field]);
      }
    });

    it('accepts zero, which is how a Job is suspended by hand', () => {
      expectRules(job('  parallelism: 0\n'), []);
    });
  });

  describe('completion mode', () => {
    it('requires completions in Indexed mode', () => {
      const finding = expectRule(job('  completionMode: Indexed\n'), 'job/indexed-without-completions');
      expect(finding.path).toEqual(['spec']);
    });

    it('requires Indexed mode for the per-index fields', () => {
      const finding = expectRule(
        job('  completions: 4\n  backoffLimitPerIndex: 1\n'),
        'job/requires-indexed-completion',
      );
      expect(finding.path).toEqual(['spec', 'backoffLimitPerIndex']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'completionMode'], value: 'Indexed' },
      ]);
    });

    it('requires backoffLimitPerIndex beside maxFailedIndexes', () => {
      expectRule(
        job('  completionMode: Indexed\n  completions: 4\n  maxFailedIndexes: 2\n'),
        'job/max-failed-indexes-without-backoff-limit-per-index',
      );
    });

    it('rejects more failed indexes than there are indexes', () => {
      const finding = expectRule(
        job(
          '  completionMode: Indexed\n  completions: 4\n  backoffLimitPerIndex: 1\n  maxFailedIndexes: 5\n',
        ),
        'job/max-failed-indexes-over-completions',
      );
      expect(finding.message).toContain('(4)');
    });

    it('rejects a name too long for the highest Pod hostname', () => {
      const name = 'a'.repeat(62);
      const finding = expectRule(
        job('  completionMode: Indexed\n  completions: 100\n').replace('name: import', `name: ${name}`),
        'job/invalid-indexed-pod-hostname',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain(`${name}-99`);
    });

    it('rejects a dotted name, which is a valid Job name but not a hostname', () => {
      // metadata.ts is happy — a Job is named with a DNS subdomain — so this is
      // the rule's alone to catch.
      expectRules(
        job('  completionMode: Indexed\n  completions: 4\n').replace('name: import', 'name: nightly.import'),
        ['job/invalid-indexed-pod-hostname'],
      );
    });

    it('says nothing about a name that is short enough', () => {
      expectRules(job('  completionMode: Indexed\n  completions: 100\n'), []);
    });

    it('leaves an unrecognised completion mode to the enum rule', () => {
      // Without knowing which mode was meant there is nothing to say about the
      // fields that depend on it.
      expectRules(job('  completionMode: indexed\n  backoffLimitPerIndex: 1\n'), [
        'enum/invalid-value',
      ]);
    });
  });

  describe('pod failure policy', () => {
    const policy = (rulesFragment: string) =>
      job(`  podFailurePolicy:\n    rules:\n${rulesFragment}`);

    it('accepts a rule matching on exit codes', () => {
      expectRules(
        policy(
          '      - action: FailJob\n        onExitCodes:\n          operator: In\n          values: [1, 42]\n',
        ),
        [],
      );
    });

    it('rejects a rule matching on both onExitCodes and onPodConditions', () => {
      const finding = expectRule(
        policy(
          '      - action: Ignore\n        onExitCodes:\n          operator: In\n          values: [1]\n' +
            '        onPodConditions:\n          - type: DisruptionTarget\n            status: "True"\n',
        ),
        'job/pod-failure-policy-rule-target',
      );
      expect(finding.path).toEqual(['spec', 'podFailurePolicy', 'rules', 0]);
      expect(finding.message).toContain('both');
    });

    it('rejects a rule matching on neither', () => {
      const finding = expectRule(policy('      - action: Count\n'), 'job/pod-failure-policy-rule-target');
      expect(finding.message).toContain('nothing');
    });

    it('requires backoffLimitPerIndex for the FailIndex action', () => {
      const finding = expectRule(
        policy('      - action: FailIndex\n        onExitCodes:\n          operator: In\n          values: [1]\n'),
        'job/fail-index-without-backoff-limit-per-index',
      );
      expect(finding.path).toEqual(['spec', 'podFailurePolicy', 'rules', 0, 'action']);
    });

    it('reports a containerName the template does not declare, with a fix', () => {
      const finding = expectRule(
        policy(
          '      - action: FailJob\n        onExitCodes:\n          containerName: imports\n' +
            '          operator: In\n          values: [1]\n',
        ),
        'job/unknown-exit-code-container',
      );
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'podFailurePolicy', 'rules', 0, 'onExitCodes', 'containerName'],
          value: 'import',
        },
      ]);
    });

    it('accepts a containerName that names an init container', () => {
      const yaml = job(
        '  podFailurePolicy:\n    rules:\n      - action: FailJob\n        onExitCodes:\n' +
          '          containerName: setup\n          operator: In\n          values: [1]\n',
        '      initContainers:\n        - name: setup\n          image: busybox:1.36\n',
      );
      expectRules(yaml, []);
    });

    it('rejects an empty exit code list', () => {
      expectRule(
        policy('      - action: FailJob\n        onExitCodes:\n          operator: In\n          values: []\n'),
        'job/empty-exit-codes',
      );
    });

    it('rejects exit code 0 with the In operator', () => {
      const finding = expectRule(
        policy('      - action: FailJob\n        onExitCodes:\n          operator: In\n          values: [0, 1]\n'),
        'job/zero-exit-code',
      );
      expect(finding.path).toEqual([
        'spec', 'podFailurePolicy', 'rules', 0, 'onExitCodes', 'values', 0,
      ]);
    });

    it('accepts exit code 0 with NotIn, which is how "any failure" is written', () => {
      expectRules(
        policy('      - action: FailJob\n        onExitCodes:\n          operator: NotIn\n          values: [0]\n'),
        [],
      );
    });

    it('rejects a repeated exit code', () => {
      expectRule(
        policy('      - action: FailJob\n        onExitCodes:\n          operator: In\n          values: [1, 1]\n'),
        'job/duplicate-exit-code',
      );
    });

    it('requires the exit codes to be sorted', () => {
      const finding = expectRule(
        policy('      - action: FailJob\n        onExitCodes:\n          operator: In\n          values: [42, 1]\n'),
        'job/unordered-exit-codes',
      );
      expect(finding.path).toEqual(['spec', 'podFailurePolicy', 'rules', 0, 'onExitCodes', 'values']);
    });

    it('checks a pod condition type as a qualified name', () => {
      expectRule(
        policy('      - action: Ignore\n        onPodConditions:\n          - type: "Disruption Target"\n            status: "True"\n'),
        'job/invalid-pod-condition-type',
      );
    });
  });

  describe('pod replacement policy', () => {
    it('allows only Failed beside a pod failure policy', () => {
      const yaml = job(
        '  podReplacementPolicy: TerminatingOrFailed\n  podFailurePolicy:\n    rules:\n' +
          '      - action: Ignore\n        onPodConditions:\n          - type: DisruptionTarget\n            status: "True"\n',
      );
      const finding = expectRule(yaml, 'job/pod-replacement-policy-with-failure-policy');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'podReplacementPolicy'], value: 'Failed' },
      ]);
    });

    it('accepts either value without one', () => {
      expectRules(job('  podReplacementPolicy: TerminatingOrFailed\n'), []);
    });
  });

  describe('success policy', () => {
    const success = (rulesFragment: string, specFragment = '  completions: 4\n') =>
      job(`  completionMode: Indexed\n${specFragment}  successPolicy:\n    rules:\n${rulesFragment}`);

    it('accepts a rule naming indexes', () => {
      expectRules(success('      - succeededIndexes: "0,2-3"\n'), []);
    });

    it('requires Indexed completion', () => {
      const finding = expectRule(
        job('  successPolicy:\n    rules:\n      - succeededCount: 1\n'),
        'job/requires-indexed-completion',
      );
      expect(finding.path).toEqual(['spec', 'successPolicy']);
    });

    it('requires at least one rule', () => {
      expectRule(
        job('  completionMode: Indexed\n  completions: 4\n  successPolicy:\n    rules: []\n'),
        'job/empty-success-policy',
      );
    });

    it('requires a rule to say something', () => {
      const finding = expectRule(success('      - {}\n'), 'job/success-policy-rule-empty');
      expect(finding.path).toEqual(['spec', 'successPolicy', 'rules', 0]);
    });

    it('rejects an index above the completion count', () => {
      const finding = expectRule(
        success('      - succeededIndexes: "0,4"\n'),
        'job/invalid-succeeded-indexes',
      );
      expect(finding.message).toContain('not below completions (4)');
    });

    it('rejects indexes out of order', () => {
      expectRule(success('      - succeededIndexes: "2,1"\n'), 'job/invalid-succeeded-indexes');
    });

    it('rejects a count above the completion count', () => {
      const finding = expectRule(success('      - succeededCount: 9\n'), 'job/invalid-succeeded-count');
      expect(finding.message).toContain('completions (4)');
    });

    it('rejects a count above the indexes the rule itself names', () => {
      const finding = expectRule(
        success('      - succeededIndexes: "0-1"\n        succeededCount: 3\n'),
        'job/invalid-succeeded-count',
      );
      expect(finding.message).toContain('2 indexes');
    });
  });

  describe('managedBy', () => {
    it('accepts a domain-prefixed path', () => {
      expectRules(job('  managedBy: kueue.x-k8s.io/multikueue\n'), []);
    });

    it('rejects a bare name', () => {
      const finding = expectRule(job('  managedBy: kueue\n'), 'job/invalid-managed-by');
      expect(finding.path).toEqual(['spec', 'managedBy']);
    });

    it('rejects one that is too long', () => {
      expectRule(job(`  managedBy: example.com/${'a'.repeat(60)}\n`), 'job/managed-by-too-long');
    });
  });
});

describe('cronjob', () => {
  it('accepts a minimal CronJob', () => {
    expectRules(VALID_CRONJOB, []);
  });

  describe('schedule', () => {
    it('leaves an absent schedule to the schema layer', () => {
      expectRules(VALID_CRONJOB.replace('  schedule: "0 0 * * *"\n', ''), [
        'schema/required-field',
      ]);
    });

    it('leaves a null schedule to the schema layer', () => {
      expectRules(VALID_CRONJOB.replace('schedule: "0 0 * * *"', 'schedule:'), [
        'schema/required-field',
      ]);
    });

    it('rejects an empty schedule, which the schema layer reads as present', () => {
      const finding = expectRule(VALID_CRONJOB.replace('"0 0 * * *"', '""'), 'cronjob/missing-schedule');
      expect(finding.path).toEqual(['spec', 'schedule']);
    });

    it('rejects a TZ= prefix in favour of spec.timeZone', () => {
      const finding = expectRule(
        VALID_CRONJOB.replace('"0 0 * * *"', '"TZ=UTC 0 0 * * *"'),
        'cronjob/timezone-in-schedule',
      );
      expect(finding.path).toEqual(['spec', 'schedule']);
    });

    it('rejects a CRON_TZ= prefix the same way', () => {
      expectRule(
        VALID_CRONJOB.replace('"0 0 * * *"', '"CRON_TZ=UTC 0 0 * * *"'),
        'cronjob/timezone-in-schedule',
      );
    });

    it('rejects a schedule with the wrong number of fields', () => {
      const finding = expectRule(VALID_CRONJOB.replace('"0 0 * * *"', '"* * * *"'), 'cronjob/invalid-schedule');
      expect(finding.message).toContain('5 fields');
    });

    it('rejects a field value outside its range', () => {
      const finding = expectRule(
        VALID_CRONJOB.replace('"0 0 * * *"', '"60 * * * *"'),
        'cronjob/invalid-schedule',
      );
      expect(finding.message).toContain('minute field "60"');
    });

    it('rejects a day-of-week value outside its range', () => {
      expectRule(VALID_CRONJOB.replace('"0 0 * * *"', '"* * * * 9"'), 'cronjob/invalid-schedule');
    });

    it('rejects an unrecognised descriptor', () => {
      expectRule(VALID_CRONJOB.replace('"0 0 * * *"', '"@fortnightly"'), 'cronjob/invalid-schedule');
    });

    it('accepts every standard descriptor', () => {
      for (const descriptor of ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']) {
        expectRules(VALID_CRONJOB.replace('"0 0 * * *"', `"${descriptor}"`), []);
      }
    });

    it('accepts an @every duration', () => {
      expectRules(VALID_CRONJOB.replace('"0 0 * * *"', '"@every 1h30m"'), []);
    });

    it('rejects a malformed @every duration', () => {
      expectRule(VALID_CRONJOB.replace('"0 0 * * *"', '"@every soon"'), 'cronjob/invalid-schedule');
    });

    it('accepts named months and weekdays, ranges, steps and lists', () => {
      expectRules(VALID_CRONJOB.replace('"0 0 * * *"', '"0 0 1 JAN-MAR MON,WED,FRI"'), []);
    });

    it('accepts a step schedule', () => {
      expectRules(VALID_CRONJOB.replace('"0 0 * * *"', '"*/15 * * * *"'), []);
    });
  });

  describe('time zone', () => {
    it('rejects an empty string', () => {
      const finding = expectRule(cronJob('  timeZone: ""\n'), 'cronjob/invalid-time-zone');
      expect(finding.path).toEqual(['spec', 'timeZone']);
    });

    it('rejects a name with a malformed component', () => {
      expectRule(cronJob('  timeZone: "Europe/.."\n'), 'cronjob/invalid-time-zone');
    });

    it('rejects "Local"', () => {
      const finding = expectRule(cronJob('  timeZone: Local\n'), 'cronjob/invalid-time-zone');
      expect(finding.message).toContain('not an explicit time zone');
    });

    it('rejects a well-formed but unknown zone, with a suggestion', () => {
      const finding = expectRule(cronJob('  timeZone: "Europe/Prag"\n'), 'cronjob/unknown-time-zone');
      expect(finding.message).toContain('Did you mean "Europe/Prague"');
      expect(finding.fix).toEqual({
        title: 'Change to "Europe/Prague"',
        safe: true,
        ops: [{ op: 'set', path: ['spec', 'timeZone'], value: 'Europe/Prague' }],
      });
    });

    it('accepts a known IANA zone', () => {
      expectRules(cronJob('  timeZone: "America/New_York"\n'), []);
    });

    it('accepts UTC', () => {
      expectRules(cronJob('  timeZone: UTC\n'), []);
    });

    it('is not checked when the field is absent', () => {
      expectRules(VALID_CRONJOB, []);
    });
  });

  describe('concurrencyPolicy', () => {
    it('accepts every valid value', () => {
      for (const value of ['Allow', 'Forbid', 'Replace']) {
        expectRules(cronJob(`  concurrencyPolicy: ${value}\n`), []);
      }
    });

    it('rejects an empty string, the enum table\'s report', () => {
      expectRule(cronJob('  concurrencyPolicy: ""\n'), 'enum/invalid-value');
    });

    it('rejects an unknown value, with a suggestion', () => {
      const finding = expectRule(cronJob('  concurrencyPolicy: allow\n'), 'enum/invalid-value');
      expect(finding.message).toContain('Did you mean "Allow"');
    });
  });

  describe('deadlines and history limits', () => {
    it('rejects a negative startingDeadlineSeconds', () => {
      expectRule(cronJob('  startingDeadlineSeconds: -1\n'), 'cronjob/negative-starting-deadline');
    });

    it('accepts a zero startingDeadlineSeconds', () => {
      expectRules(cronJob('  startingDeadlineSeconds: 0\n'), []);
    });

    it('rejects a negative successfulJobsHistoryLimit', () => {
      const finding = expectRule(
        cronJob('  successfulJobsHistoryLimit: -1\n'),
        'cronjob/negative-history-limit',
      );
      expect(finding.path).toEqual(['spec', 'successfulJobsHistoryLimit']);
    });

    it('rejects a negative failedJobsHistoryLimit', () => {
      expectRule(cronJob('  failedJobsHistoryLimit: -1\n'), 'cronjob/negative-history-limit');
    });

    it('accepts a zero history limit — it means "keep none"', () => {
      expectRules(cronJob('  successfulJobsHistoryLimit: 0\n  failedJobsHistoryLimit: 0\n'), []);
    });
  });

  describe('name length', () => {
    it('accepts a name at exactly 52 characters', () => {
      expectRules(VALID_CRONJOB.replace('name: import', `name: ${'a'.repeat(52)}`), []);
    });

    it('rejects a name of 53 characters', () => {
      const finding = expectRule(
        VALID_CRONJOB.replace('name: import', `name: ${'a'.repeat(53)}`),
        'cronjob/name-too-long',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('53');
    });

    it('leaves a name that is not even a valid object name to metadata.ts', () => {
      expectRules(VALID_CRONJOB.replace('name: import', `name: ${'A'.repeat(60)}`), [
        'meta/invalid-name',
      ]);
    });
  });

  describe('jobTemplate selector', () => {
    it('rejects a hand-written selector', () => {
      const finding = expectRule(
        cronJob('', '      selector:\n        matchLabels:\n          app: import\n'),
        'cronjob/job-template-selector',
      );
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec', 'selector']);
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'jobTemplate', 'spec', 'selector'] },
      ]);
    });

    it('rejects manualSelector: true — a CronJob has nothing to adopt', () => {
      const finding = expectRule(
        cronJob('', '      manualSelector: true\n'),
        'cronjob/job-template-manual-selector',
      );
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec', 'manualSelector']);
    });

    it('accepts manualSelector: false', () => {
      expectRules(cronJob('', '      manualSelector: false\n'), []);
    });
  });

  describe('jobTemplate metadata', () => {
    it('checks jobTemplate.metadata.labels', () => {
      const finding = expectRule(
        cronJob('').replace(
          '  jobTemplate:\n    spec:\n',
          '  jobTemplate:\n    metadata:\n      labels:\n        "bad key!": x\n    spec:\n',
        ),
        'meta/invalid-label-key',
      );
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'metadata', 'labels', 'bad key!']);
    });

    it('checks jobTemplate.metadata.annotations', () => {
      expectRule(
        cronJob('').replace(
          '  jobTemplate:\n    spec:\n',
          '  jobTemplate:\n    metadata:\n      annotations:\n        "bad key!": x\n    spec:\n',
        ),
        'meta/invalid-annotation-key',
      );
    });
  });

  describe('job spec rules under the jobTemplate', () => {
    // The sharpest test that checkJobSpec is reused rather than re-derived:
    // every one of these is a `job/*` id, reported through the deeper path
    // cronjob.ts hands it, exactly as a Job's own spec would report it at
    // `spec`.
    it('rejects a negative backoffLimit', () => {
      const finding = expectRule(cronJob('', '      backoffLimit: -1\n'), 'job/negative-backoff-limit');
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec', 'backoffLimit']);
    });

    it('rejects a template with no restartPolicy, since the default is Always', () => {
      const finding = expectRule(
        VALID_CRONJOB.replace('          restartPolicy: Never\n', ''),
        'job/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec', 'template', 'spec']);
    });

    it('rejects restartPolicy: Always', () => {
      expectRule(
        VALID_CRONJOB.replace('restartPolicy: Never', 'restartPolicy: Always'),
        'job/template-restart-policy',
      );
    });

    it('requires completions on an Indexed jobTemplate', () => {
      const finding = expectRule(
        cronJob('', '      completionMode: Indexed\n'),
        'job/indexed-without-completions',
      );
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec']);
      expect(finding.anchor).toBe('key');
    });

    it('rejects a per-index field on a NonIndexed jobTemplate', () => {
      const finding = expectRule(
        cronJob('', '      maxFailedIndexes: 1\n      backoffLimitPerIndex: 1\n'),
        'job/requires-indexed-completion',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'jobTemplate', 'spec', 'completionMode'], value: 'Indexed' },
      ]);
    });

    it('rejects a managedBy that is not a domain-prefixed path', () => {
      const finding = expectRule(cronJob('', '      managedBy: kueue\n'), 'job/invalid-managed-by');
      expect(finding.path).toEqual(['spec', 'jobTemplate', 'spec', 'managedBy']);
    });

    it('accepts a well-formed job spec', () => {
      expectRules(
        cronJob(
          '',
          '      completionMode: Indexed\n      completions: 4\n      backoffLimit: 2\n',
        ),
        [],
      );
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        cronJobWithPodSpec('          hostNetwork: true\n          hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual([
        'spec',
        'jobTemplate',
        'spec',
        'template',
        'spec',
        'hostNetwork',
      ]);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(cronJobWithPodSpec('          dnsPolicy: None\n'), 'pod/dns-none-without-config');
      expect(finding.message).toContain('spec.jobTemplate.spec.template.spec.dnsConfig');
    });

    it("checks the CronJob's own name, not the template's", () => {
      const finding = expectRule(
        VALID_CRONJOB.replace('  name: import\n', '  name: Import\n'),
        'meta/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('CronJob name');
    });
  });
});

describe('service', () => {
  it('accepts a valid Service', () => {
    expectRules(VALID_SERVICE, []);
  });

  describe('name', () => {
    it('requires an RFC 1035 label, which may not start with a digit', () => {
      const finding = expectRule(
        VALID_SERVICE.replace('  name: web\n', '  name: 8080-proxy\n'),
        'meta/invalid-name',
      );
      expect(finding.message).toContain('Service name');
      expect(finding.message).toContain('must start with a letter');
    });

    it('accepts the same name on a Pod, which takes a subdomain', () => {
      expectNoRule(pod('  containers:\n    - name: web\n      image: a\n', '  name: 8080-proxy\n'), 'meta/invalid-name');
    });
  });

  describe('ports', () => {
    it('requires at least one port', () => {
      const finding = expectRule(service('  selector:\n    app: web\n'), 'service/missing-ports');
      expect(finding.message).toContain('ClusterIP');
    });

    it('reports them even with no spec at all', () => {
      // ServiceSpec is not required by the schema, but an absent one still
      // defaults to a ClusterIP Service, which the apiserver rejects for
      // having no ports.
      expectRule('apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n', 'service/missing-ports');
    });

    it('allows a headless Service to expose none', () => {
      expectRules(service('  clusterIP: None\n  selector:\n    app: web\n'), []);
    });

    it('allows an ExternalName Service to expose none', () => {
      expectRules(service('  type: ExternalName\n  externalName: shop.example.com\n'), []);
    });

    it('requires a name once there is more than one port', () => {
      const finding = expectRule(
        service('  ports:\n    - port: 80\n    - port: 443\n      protocol: SCTP\n'),
        'service/unnamed-port',
      );
      expect(finding.path).toEqual(['spec', 'ports', 0]);
    });

    it('accepts a single unnamed port', () => {
      expectRules(service('  ports:\n    - port: 80\n'), []);
    });

    it('rejects a port name that is not a DNS label', () => {
      expectRule(service('  ports:\n    - name: HTTP\n      port: 80\n'), 'service/invalid-port-name');
    });

    it('rejects duplicate port names', () => {
      const finding = expectRule(
        service('  ports:\n    - name: http\n      port: 80\n    - name: http\n      port: 8080\n'),
        'service/duplicate-port-name',
      );
      expect(finding.message).toContain('entry 1');
    });

    it('rejects two ports that both default to TCP', () => {
      // The schema layer keys ServiceSpec.ports on port + protocol, so it only
      // sees the duplicate when both entries spell the protocol out.
      const yaml = service('  ports:\n    - name: a\n      port: 80\n    - name: b\n      port: 80\n');
      expectRule(yaml, 'service/duplicate-port');
      expectNoRule(yaml, 'schema/duplicate-list-entry');
    });

    it('leaves a spelled-out duplicate to the schema layer', () => {
      const yaml = service(
        '  ports:\n    - name: a\n      port: 80\n      protocol: TCP\n' +
          '    - name: b\n      port: 80\n      protocol: TCP\n',
      );
      expectRule(yaml, 'schema/duplicate-list-entry');
      expectNoRule(yaml, 'service/duplicate-port');
    });

    it('accepts the same port number under a different protocol', () => {
      expectRules(
        service(
          '  ports:\n    - name: dns-tcp\n      port: 53\n      protocol: TCP\n' +
            '    - name: dns-udp\n      port: 53\n      protocol: UDP\n',
        ),
        [],
      );
    });

    it('rejects a port number outside the 16-bit range', () => {
      expectRule(service('  ports:\n    - port: 70000\n'), 'service/port-out-of-range');
    });

    it('rejects a named targetPort that no container port could carry', () => {
      expectRule(
        service('  ports:\n    - port: 80\n      targetPort: web--port\n'),
        'service/invalid-target-port',
      );
    });

    it('reads a quoted number as a name and offers to unquote it', () => {
      const finding = expectRule(
        service('  ports:\n    - port: 80\n      targetPort: "8080"\n'),
        'service/quoted-target-port',
      );
      expect(finding.fix).toEqual({
        title: 'Change to the number 8080',
        safe: true,
        ops: [{ op: 'set', path: ['spec', 'ports', 0, 'targetPort'], value: 8080 }],
      });
    });

    it('rejects an appProtocol that is not a qualified name', () => {
      expectRule(
        service('  ports:\n    - port: 80\n      appProtocol: my protocol\n'),
        'service/invalid-app-protocol',
      );
    });
  });

  describe('node ports', () => {
    const nodePort = (fragment: string) =>
      service(`${fragment}  ports:\n    - port: 80\n      nodePort: 30080\n`);

    it('accepts one on a NodePort Service', () => {
      expectRules(nodePort('  type: NodePort\n'), []);
    });

    it('rejects one on a ClusterIP Service', () => {
      const finding = expectRule(nodePort(''), 'service/node-port-not-allowed');
      expect(finding.fix?.ops).toEqual([{ op: 'set', path: ['spec', 'type'], value: 'NodePort' }]);
    });

    it('warns about a number outside the default range', () => {
      const finding = expectRule(
        service('  type: NodePort\n  ports:\n    - port: 80\n      nodePort: 8080\n'),
        'service/node-port-outside-default-range',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('30000-32767');
    });

    it('rejects two ports claiming the same node port', () => {
      expectRule(
        service(
          '  type: NodePort\n  ports:\n    - name: a\n      port: 80\n      nodePort: 30080\n' +
            '    - name: b\n      port: 443\n      nodePort: 30080\n',
        ),
        'service/duplicate-node-port',
      );
    });
  });

  describe('type ExternalName', () => {
    it('requires externalName', () => {
      expectRule(service('  type: ExternalName\n'), 'service/missing-external-name');
    });

    it('requires it to be a hostname', () => {
      expectRule(
        service('  type: ExternalName\n  externalName: 10.0.0.1:8080\n'),
        'service/invalid-external-name',
      );
    });

    it('accepts a fully qualified name with a trailing dot', () => {
      expectRules(service('  type: ExternalName\n  externalName: shop.example.com.\n'), []);
    });

    it('rejects a cluster IP alongside it', () => {
      expectRule(
        service('  type: ExternalName\n  externalName: shop.example.com\n  clusterIP: None\n'),
        'service/external-name-with-cluster-ip',
      );
    });

    it('rejects IP families alongside it', () => {
      expectRule(
        service('  type: ExternalName\n  externalName: shop.example.com\n  ipFamilyPolicy: SingleStack\n'),
        'service/ip-family-not-allowed',
      );
    });

    it('warns that a selector does nothing', () => {
      const finding = expectRule(
        service('  type: ExternalName\n  externalName: shop.example.com\n  selector:\n    app: web\n'),
        'service/selector-ignored',
      );
      expect(finding.severity).toBe('warning');
    });

    it('warns that externalName does nothing under another type', () => {
      const finding = expectRule(
        service('  externalName: shop.example.com\n  ports:\n    - port: 80\n'),
        'service/external-name-ignored',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'type'], value: 'ExternalName' },
      ]);
    });
  });

  describe('cluster IP', () => {
    it('rejects one that is not an address', () => {
      expectRule(service('  clusterIP: 10.0.0.300\n  ports:\n    - port: 80\n'), 'service/invalid-cluster-ip');
    });

    it('rejects an octet written with a leading zero', () => {
      // Go stopped reading these as octal, so the apiserver rejects them
      // rather than quietly resolving 010 to 8.
      expectRule(service('  clusterIP: 010.1.1.1\n  ports:\n    - port: 80\n'), 'service/invalid-cluster-ip');
    });

    it('accepts an IPv6 address', () => {
      expectRules(service('  clusterIP: 2001:db8::1\n  ports:\n    - port: 80\n'), []);
    });

    it('requires clusterIP to match the first of clusterIPs', () => {
      const finding = expectRule(
        service('  clusterIP: 10.0.0.1\n  clusterIPs: ["10.0.0.2"]\n  ports:\n    - port: 80\n'),
        'service/cluster-ip-mismatch',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'clusterIP'], value: '10.0.0.2' },
      ]);
    });

    it('rejects a headless NodePort Service', () => {
      expectRule(
        service('  type: NodePort\n  clusterIP: None\n  ports:\n    - port: 80\n'),
        'service/headless-with-external-type',
      );
    });
  });

  describe('external IPs', () => {
    it('rejects one that is not an address', () => {
      expectRule(
        service('  externalIPs: ["203.0.113"]\n  ports:\n    - port: 80\n'),
        'service/invalid-external-ip',
      );
    });

    it('rejects an address no client outside the node could use', () => {
      const finding = expectRule(
        service('  externalIPs: ["127.0.0.1"]\n  ports:\n    - port: 80\n'),
        'service/special-external-ip',
      );
      expect(finding.message).toContain('loopback');
    });

    it('allows externalTrafficPolicy on a ClusterIP Service that claims one', () => {
      // ExternallyAccessible() is what the apiserver gates the policy on, and
      // an external IP makes a ClusterIP Service exactly that.
      expectRules(
        service('  externalIPs: ["203.0.113.4"]\n  externalTrafficPolicy: Local\n  ports:\n    - port: 80\n'),
        [],
      );
    });
  });

  describe('traffic policies', () => {
    it('rejects externalTrafficPolicy on a plain ClusterIP Service', () => {
      expectRule(
        service('  externalTrafficPolicy: Local\n  ports:\n    - port: 80\n'),
        'service/external-traffic-policy-not-allowed',
      );
    });

    it('rejects internalTrafficPolicy on an ExternalName Service', () => {
      expectRule(
        service('  type: ExternalName\n  externalName: shop.example.com\n  internalTrafficPolicy: Local\n'),
        'service/internal-traffic-policy-not-allowed',
      );
    });

    it('accepts a health check node port on a Local LoadBalancer', () => {
      expectRules(
        service(
          '  type: LoadBalancer\n  externalTrafficPolicy: Local\n  healthCheckNodePort: 30500\n' +
            '  ports:\n    - port: 80\n',
        ),
        [],
      );
    });

    it('rejects one under the Cluster policy, where every node has endpoints', () => {
      expectRule(
        service('  type: LoadBalancer\n  healthCheckNodePort: 30500\n  ports:\n    - port: 80\n'),
        'service/health-check-node-port-not-allowed',
      );
    });
  });

  describe('load balancer fields', () => {
    it('rejects a source range that is not a CIDR block', () => {
      const finding = expectRule(
        service('  type: LoadBalancer\n  loadBalancerSourceRanges: ["203.0.113.4"]\n  ports:\n    - port: 80\n'),
        'service/invalid-source-range',
      );
      expect(finding.message).toContain('prefix length');
    });

    it('accepts an IPv6 block', () => {
      expectRules(
        service('  type: LoadBalancer\n  loadBalancerSourceRanges: ["2001:db8::/64"]\n  ports:\n    - port: 80\n'),
        [],
      );
    });

    it('rejects a load balancer field on a ClusterIP Service', () => {
      const finding = expectRule(
        service('  loadBalancerClass: example.com/lb\n  ports:\n    - port: 80\n'),
        'service/load-balancer-field-not-allowed',
      );
      expect(finding.message).toContain('loadBalancerClass');
    });

    it('rejects a loadBalancerClass that is not a qualified name', () => {
      expectRule(
        service('  type: LoadBalancer\n  loadBalancerClass: "not a class"\n  ports:\n    - port: 80\n'),
        'service/invalid-load-balancer-class',
      );
    });
  });

  describe('session affinity', () => {
    it('rejects a config block without ClientIP affinity', () => {
      const finding = expectRule(
        service('  sessionAffinityConfig:\n    clientIP:\n      timeoutSeconds: 60\n  ports:\n    - port: 80\n'),
        'service/session-affinity-config-not-allowed',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'sessionAffinity'], value: 'ClientIP' },
      ]);
    });

    it('rejects a timeout above a day', () => {
      expectRule(
        service(
          '  sessionAffinity: ClientIP\n  sessionAffinityConfig:\n    clientIP:\n      timeoutSeconds: 90000\n' +
            '  ports:\n    - port: 80\n',
        ),
        'service/invalid-affinity-timeout',
      );
    });
  });

  describe('ip families', () => {
    it('rejects a misspelled family and offers the right casing', () => {
      const finding = expectRule(
        service('  ipFamilies: ["ipv4"]\n  ports:\n    - port: 80\n'),
        'service/invalid-ip-family',
      );
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'ipFamilies', 0], value: 'IPv4' },
      ]);
    });

    it('rejects the same family twice', () => {
      expectRule(
        service('  ipFamilies: ["IPv4", "IPv4"]\n  ports:\n    - port: 80\n'),
        'service/duplicate-ip-family',
      );
    });

    it('rejects two families under a SingleStack policy', () => {
      expectRule(
        service('  ipFamilyPolicy: SingleStack\n  ipFamilies: ["IPv4", "IPv6"]\n  ports:\n    - port: 80\n'),
        'service/ip-family-policy-conflict',
      );
    });

    it('accepts a dual-stack pair', () => {
      expectRules(
        service('  ipFamilyPolicy: RequireDualStack\n  ipFamilies: ["IPv4", "IPv6"]\n  ports:\n    - port: 80\n'),
        [],
      );
    });
  });

  describe('an unrecognised type', () => {
    const yaml = service('  type: clusterip\n  ports:\n    - name: http\n      port: 70000\n');

    it('leaves the type itself to the enum rule', () => {
      expectRule(yaml, 'enum/invalid-value');
      expectNoRule(yaml, 'service/missing-ports');
    });

    it('still checks everything that does not depend on the type', () => {
      expectRule(yaml, 'service/port-out-of-range');
    });
  });

  it('runs none of the pod spec rules', () => {
    // A Service has no pod template, so the shared rules do not run for it at
    // all — a "containers" key here is an unknown field, nothing more.
    const ids = ruleIds(service('  containers:\n    - name: web\n      image: a\n'));
    expect(ids.every((id) => !id.startsWith('pod/'))).toBe(true);
    expect(ids).toContain('schema/unknown-field');
  });
});

describe('ingress', () => {
  it('accepts a valid Ingress', () => {
    expectRules(VALID_INGRESS, []);
  });

  it('takes a DNS subdomain name, unlike a Service', () => {
    expectNoRule(VALID_INGRESS.replace('  name: web\n', '  name: web.example\n'), 'meta/invalid-name');
  });

  describe('routing', () => {
    it('requires either rules or a default backend', () => {
      const finding = expectRule(ingress('  ingressClassName: nginx\n'), 'ingress/no-routes');
      expect(finding.message).toContain('spec.defaultBackend');
    });

    it('reports it with no spec at all', () => {
      expectRule('apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\n', 'ingress/no-routes');
    });

    it('treats an empty rule list as no rules', () => {
      const finding = expectRule(ingress('  rules: []\n'), 'ingress/no-routes');
      expect(finding.path).toEqual(['spec', 'rules']);
    });

    it('accepts a default backend on its own', () => {
      expectRules(
        ingress('  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n'),
        [],
      );
    });

    it('rejects an empty path list', () => {
      expectRule(ingress('  rules:\n    - http:\n        paths: []\n'), 'ingress/empty-paths');
    });

    it('warns about a rule that carries no http block', () => {
      const finding = expectRule(
        ingress('  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n' +
          '  rules:\n    - host: web.example.com\n'),
        'ingress/rule-without-http',
      );
      expect(finding.severity).toBe('warning');
    });
  });

  describe('hosts', () => {
    it('rejects an IP address', () => {
      const finding = expectRule(ingressWithPaths(ingressPath('/'), '10.0.0.1'), 'ingress/host-is-ip');
      expect(finding.message).toContain('DNS name');
    });

    it('rejects a host carrying a port', () => {
      expectRule(ingressWithPaths(ingressPath('/'), '"web.example.com:8080"'), 'ingress/invalid-host');
    });

    it('accepts a leading wildcard label', () => {
      expectRules(ingressWithPaths(ingressPath('/'), '"*.example.com"'), []);
    });

    it('rejects a wildcard anywhere but the leftmost label', () => {
      expectRule(ingressWithPaths(ingressPath('/'), 'web.*.example.com'), 'ingress/invalid-wildcard-host');
    });

    it('accepts a rule with no host, which matches every name', () => {
      expectRules(ingress('  rules:\n    - http:\n        paths:\n' + ingressPath('/')), []);
    });
  });

  describe('paths', () => {
    it('requires a Prefix path to be absolute', () => {
      const finding = expectRule(ingressWithPaths(ingressPath('healthz')), 'ingress/path-not-absolute');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'rules', 0, 'http', 'paths', 0, 'path'], value: '/healthz' },
      ]);
    });

    it('requires an Exact path to be present at all', () => {
      const yaml = ingressWithPaths(
        '          - pathType: Exact\n            backend:\n              service:\n' +
          '                name: web\n                port:\n                  number: 80\n',
      );
      const finding = expectRule(yaml, 'ingress/path-not-absolute');
      expect(finding.message).toContain('must set "path"');
    });

    it('lets an ImplementationSpecific path be omitted', () => {
      expectRules(
        ingressWithPaths(
          '          - pathType: ImplementationSpecific\n            backend:\n              service:\n' +
            '                name: web\n                port:\n                  number: 80\n',
        ),
        [],
      );
    });

    it('still requires an ImplementationSpecific path that is present to be absolute', () => {
      expectRule(ingressWithPaths(ingressPath('healthz', 'ImplementationSpecific')), 'ingress/path-not-absolute');
    });

    it('rejects path elements that can never match', () => {
      for (const path of ['/a//b', '/a/./b', '/a/../b', '/a%2fb']) {
        expectRule(ingressWithPaths(ingressPath(path)), 'ingress/invalid-path-sequence');
      }
    });

    it('rejects a relative element at the end', () => {
      const finding = expectRule(ingressWithPaths(ingressPath('/a/..')), 'ingress/invalid-path-sequence');
      expect(finding.message).toContain('must not end with');
    });

    it('leaves an unknown pathType to the enum rule', () => {
      const yaml = ingressWithPaths(ingressPath('relative', 'prefix'));
      expectRule(yaml, 'enum/invalid-value');
      expectNoRule(yaml, 'ingress/path-not-absolute');
    });

    it('warns about a host, type and path repeated', () => {
      const finding = expectRule(
        ingressWithPaths(ingressPath('/a', 'Exact') + ingressPath('/a', 'Exact')),
        'ingress/duplicate-path',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('rule 1, path 1');
    });

    it('does not warn when only the path type differs', () => {
      expectRules(ingressWithPaths(ingressPath('/a', 'Exact') + ingressPath('/a', 'Prefix')), []);
    });

    it('does not warn when the same path sits under two hosts', () => {
      expectRules(
        ingress(
          `  rules:\n    - host: a.example.com\n      http:\n        paths:\n${ingressPath('/')}` +
            `    - host: b.example.com\n      http:\n        paths:\n${ingressPath('/')}`,
        ),
        [],
      );
    });
  });

  describe('backends', () => {
    const backend = (fragment: string) => ingress(`  defaultBackend:\n${fragment}`);

    it('rejects one that names nothing', () => {
      expectRule(backend('    {}\n'), 'ingress/empty-backend');
    });

    it('rejects one that names both a service and a resource', () => {
      expectRule(
        backend(
          '    service:\n      name: web\n      port:\n        number: 80\n' +
            '    resource:\n      apiGroup: k8s.example.com\n      kind: StorageBucket\n      name: assets\n',
        ),
        'ingress/ambiguous-backend',
      );
    });

    it('accepts a resource backend on its own', () => {
      expectRules(
        backend('    resource:\n      apiGroup: k8s.example.com\n      kind: StorageBucket\n      name: assets\n'),
        [],
      );
    });

    it('requires a port', () => {
      expectRule(backend('    service:\n      name: web\n'), 'ingress/missing-backend-port');
    });

    it('treats port number 0 as no port at all', () => {
      // 0 is the Go zero value, so the apiserver reads it as unset rather than
      // as a port out of range.
      expectRule(
        backend('    service:\n      name: web\n      port:\n        number: 0\n'),
        'ingress/missing-backend-port',
      );
    });

    it('rejects a port name and number together', () => {
      expectRule(
        backend('    service:\n      name: web\n      port:\n        name: http\n        number: 80\n'),
        'ingress/ambiguous-backend-port',
      );
    });

    it('rejects a port number out of range', () => {
      expectRule(
        backend('    service:\n      name: web\n      port:\n        number: 70000\n'),
        'ingress/backend-port-out-of-range',
      );
    });

    it('rejects a port name that no Service port could carry', () => {
      expectRule(
        backend('    service:\n      name: web\n      port:\n        name: HTTP\n'),
        'ingress/invalid-backend-port-name',
      );
    });

    it('requires the Service name to be an RFC 1035 label', () => {
      const finding = expectRule(
        backend('    service:\n      name: web.example\n      port:\n        number: 80\n'),
        'ingress/invalid-backend-service-name',
      );
      expect(finding.message).toContain('Service name');
    });

    it('checks the backend of a path as well as the default one', () => {
      const finding = expectRule(
        ingressWithPaths(
          '          - path: /\n            pathType: Prefix\n' +
            '            backend:\n              service:\n                name: web\n',
        ),
        'ingress/missing-backend-port',
      );
      expect(finding.message).toContain('rule 1, path 1');
    });
  });

  describe('TLS', () => {
    it('rejects a host that is not a name', () => {
      expectRule(
        VALID_INGRESS.replace('        - web.example.com\n', '        - Web_Example\n'),
        'ingress/invalid-host',
      );
    });

    it('accepts a wildcard host covering the rule host', () => {
      expectRules(VALID_INGRESS.replace('        - web.example.com\n', '        - "*.example.com"\n'), []);
    });

    it('rejects a secret name that is not an object name', () => {
      expectRule(VALID_INGRESS.replace('web-tls', 'Web_TLS'), 'ingress/invalid-secret-name');
    });

    it('accepts a TLS block with no secret, which uses the default certificate', () => {
      expectRules(VALID_INGRESS.replace('      secretName: web-tls\n', ''), []);
    });

    it('warns when no rule routes the certificate host', () => {
      const finding = expectRule(
        VALID_INGRESS.replace('        - web.example.com\n', '        - other.example.com\n'),
        'ingress/tls-host-unmatched',
      );
      expect(finding.severity).toBe('warning');
    });

    it('stays quiet when no rule names a host at all', () => {
      expectRules(
        ingress(
          '  tls:\n    - hosts:\n        - web.example.com\n      secretName: web-tls\n' +
            `  rules:\n    - http:\n        paths:\n${ingressPath('/')}`,
        ),
        [],
      );
    });
  });

  describe('ingress class', () => {
    it('requires a valid class name', () => {
      expectRule(
        VALID_INGRESS.replace('ingressClassName: nginx', 'ingressClassName: NGINX'),
        'ingress/invalid-class-name',
      );
    });

    it('warns about the annotation IngressClass replaced, and offers to move it', () => {
      const yaml = ingress(
        '  defaultBackend:\n    service:\n      name: web\n      port:\n        number: 80\n',
        '  name: web\n  annotations:\n    kubernetes.io/ingress.class: nginx\n',
      );
      const finding = expectRule(yaml, 'ingress/deprecated-class-annotation');
      expect(finding.severity).toBe('warning');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'ingressClassName'], value: 'nginx' },
        { op: 'delete', path: ['metadata', 'annotations', 'kubernetes.io/ingress.class'] },
      ]);
    });

    it('says so when the annotation and the field disagree', () => {
      const finding = expectRule(
        VALID_INGRESS.replace(
          '  name: web\n',
          '  name: web\n  annotations:\n    kubernetes.io/ingress.class: traefik\n',
        ),
        'ingress/deprecated-class-annotation',
      );
      expect(finding.message).toContain('"nginx"');
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['metadata', 'annotations', 'kubernetes.io/ingress.class'] },
      ]);
    });
  });

  it('runs none of the pod spec rules', () => {
    // An Ingress has no pod template, so the shared rules do not run for it at
    // all — a "containers" key here is an unknown field, nothing more.
    const ids = ruleIds(ingress('  containers:\n    - name: web\n      image: a\n'));
    expect(ids.every((id) => !id.startsWith('pod/'))).toBe(true);
    expect(ids).toContain('schema/unknown-field');
  });
});

describe('ingressclass', () => {
  it('accepts a valid IngressClass', () => {
    expectRules(VALID_INGRESS_CLASS, []);
  });

  it('rejects a namespace, since the kind is cluster-scoped', () => {
    const finding = expectRule(
      ingressClass('  controller: k8s.io/ingress-nginx\n', '  name: nginx\n  namespace: kube-system\n'),
      'meta/namespace-not-allowed',
    );
    expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['metadata', 'namespace'] }]);
  });

  it('leaves a namespace alone on a namespaced kind', () => {
    expectNoRule(
      service('  ports:\n    - port: 80\n', '  name: web\n  namespace: kube-system\n'),
      'meta/namespace-not-allowed',
    );
  });

  describe('controller', () => {
    it('requires one', () => {
      const finding = expectRule(
        'apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata:\n  name: nginx\n',
        'ingressclass/missing-controller',
      );
      expect(finding.path).toEqual(['spec']);
    });

    it('treats an empty one as none', () => {
      const finding = expectRule(ingressClass('  controller: ""\n'), 'ingressclass/missing-controller');
      expect(finding.path).toEqual(['spec', 'controller']);
    });

    it('rejects a bare name with no domain prefix', () => {
      const finding = expectRule(ingressClass('  controller: nginx\n'), 'ingressclass/invalid-controller');
      expect(finding.message).toContain('domain-prefixed path');
    });

    it('rejects a domain prefix that is not a DNS subdomain', () => {
      const finding = expectRule(
        ingressClass('  controller: NGINX.io/ingress\n'),
        'ingressclass/invalid-controller',
      );
      expect(finding.message).toContain('"NGINX.io"');
    });

    it('rejects a path carrying characters a URL could not', () => {
      const finding = expectRule(
        ingressClass('  controller: "k8s.io/ingress nginx"\n'),
        'ingressclass/invalid-controller',
      );
      expect(finding.message).toContain('valid path');
    });

    it('accepts the punctuation a URL path may carry', () => {
      expectRules(ingressClass('  controller: k8s.io/ingress-nginx/v1_2.3~beta\n'), []);
    });

    it('rejects one longer than 250 characters', () => {
      expectRule(
        ingressClass(`  controller: k8s.io/${'a'.repeat(250)}\n`),
        'ingressclass/controller-too-long',
      );
    });
  });

  describe('parameters', () => {
    it('rejects a namespace under the default scope, which is Cluster', () => {
      const finding = expectRule(
        ingressClassParameters('    kind: IngressParameters\n    name: p\n    namespace: ns\n'),
        'ingressclass/parameters-namespace-not-allowed',
      );
      expect(finding.message).toContain('defaults to "Cluster"');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'parameters', 'scope'], value: 'Namespace' },
      ]);
    });

    it('rejects a namespace beside an explicit Cluster scope', () => {
      const finding = expectRule(
        ingressClassParameters(
          '    kind: IngressParameters\n    name: p\n    scope: Cluster\n    namespace: ns\n',
        ),
        'ingressclass/parameters-namespace-not-allowed',
      );
      expect(finding.message).toContain('is "Cluster"');
    });

    it('requires a namespace under the Namespace scope', () => {
      expectRule(
        ingressClassParameters('    kind: IngressParameters\n    name: p\n    scope: Namespace\n'),
        'ingressclass/missing-parameters-namespace',
      );
    });

    it('requires that namespace to be a DNS label', () => {
      expectRule(
        ingressClassParameters(
          '    kind: IngressParameters\n    name: p\n    scope: Namespace\n    namespace: Ingress_NS\n',
        ),
        'ingressclass/invalid-parameters-namespace',
      );
    });

    it('leaves an unrecognised scope to the enum rule', () => {
      // Without knowing which scope was meant there is nothing to say about
      // the namespace sitting beside it.
      const yaml = ingressClassParameters(
        '    kind: IngressParameters\n    name: p\n    scope: namespace\n    namespace: ns\n',
      );
      expectRule(yaml, 'enum/invalid-value');
      expectNoRule(yaml, 'ingressclass/parameters-namespace-not-allowed');
      expectNoRule(yaml, 'ingressclass/missing-parameters-namespace');
    });

    it('rejects an empty kind or name, which the schema only sees the presence of', () => {
      for (const fragment of ['    kind: ""\n    name: p\n', '    kind: K\n    name: ""\n']) {
        expectRule(ingressClassParameters(fragment), 'ingressclass/empty-parameters-reference');
      }
    });

    it('rejects a kind or name that could not be a URL path segment', () => {
      for (const fragment of ['    kind: a/b\n    name: p\n', '    kind: K\n    name: ".."\n']) {
        expectRule(ingressClassParameters(fragment), 'ingressclass/invalid-parameters-reference');
      }
    });

    it('rejects an empty apiGroup, since the core group is spelled by omission', () => {
      const finding = expectRule(
        ingressClassParameters('    apiGroup: ""\n    kind: IngressParameters\n    name: p\n'),
        'ingressclass/invalid-parameters-api-group',
      );
      expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['spec', 'parameters', 'apiGroup'] }]);
    });

    it('rejects an apiGroup that is not a DNS subdomain', () => {
      expectRule(
        ingressClassParameters('    apiGroup: K8s.Example\n    kind: IngressParameters\n    name: p\n'),
        'ingressclass/invalid-parameters-api-group',
      );
    });

    it('accepts a cluster-scoped reference with no namespace', () => {
      expectRules(ingressClassParameters('    kind: IngressParameters\n    name: p\n'), []);
    });
  });

  describe('the default class annotation', () => {
    const annotated = (value: string) =>
      ingressClass(
        '  controller: k8s.io/ingress-nginx\n',
        `  name: nginx\n  annotations:\n    ingressclass.kubernetes.io/is-default-class: ${value}\n`,
      );

    it('accepts the two values the admission plugin reads', () => {
      expectRules(annotated('"true"'), []);
      expectRules(annotated('"false"'), []);
    });

    it('warns about a value differing only in case, and offers to correct it', () => {
      const finding = expectRule(annotated('"True"'), 'ingressclass/invalid-default-annotation');
      expect(finding.severity).toBe('warning');
      expect(finding.fix).toEqual({
        title: 'Change to "true"',
        safe: true,
        ops: [
          {
            op: 'set',
            path: ['metadata', 'annotations', 'ingressclass.kubernetes.io/is-default-class'],
            value: 'true',
          },
        ],
      });
    });

    it('offers no fix for a value that only resembles a boolean', () => {
      const finding = expectRule(annotated('"yes"'), 'ingressclass/invalid-default-annotation');
      expect(finding.fix).toBeUndefined();
    });

    it('leaves an unquoted boolean to the schema layer, which sees a type error', () => {
      // Annotations are strings, so YAML's own `true` is not one at all.
      const yaml = annotated('true');
      expectRule(yaml, 'schema/type');
      expectNoRule(yaml, 'ingressclass/invalid-default-annotation');
    });
  });

  it('runs none of the pod spec rules', () => {
    const ids = ruleIds(ingressClass('  containers:\n    - name: web\n      image: a\n'));
    expect(ids.every((id) => !id.startsWith('pod/'))).toBe(true);
    expect(ids).toContain('schema/unknown-field');
  });
});

describe('persistentvolumeclaim', () => {
  const withStorage = (fragment: string) =>
    persistentVolumeClaim(
      `  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Gi\n${fragment}`,
    );

  it('accepts a valid PersistentVolumeClaim', () => {
    expectRules(VALID_PERSISTENTVOLUMECLAIM, []);
  });

  describe('access modes', () => {
    it('requires at least one', () => {
      const finding = expectRule(
        persistentVolumeClaim('  resources:\n    requests:\n      storage: 10Gi\n'),
        'persistentvolumeclaim/missing-access-modes',
      );
      expect(finding.path).toEqual(['spec']);
    });

    it('treats an empty list the same as a missing one', () => {
      const finding = expectRule(
        persistentVolumeClaim('  accessModes: []\n  resources:\n    requests:\n      storage: 10Gi\n'),
        'persistentvolumeclaim/missing-access-modes',
      );
      expect(finding.path).toEqual(['spec', 'accessModes']);
    });

    it('rejects an unknown mode, suggesting a close match', () => {
      const finding = expectRule(
        persistentVolumeClaim(
          '  accessModes:\n    - ReadWriteOnly\n  resources:\n    requests:\n      storage: 10Gi\n',
        ),
        'persistentvolumeclaim/invalid-access-mode',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'accessModes', 0], value: 'ReadWriteOnce' },
      ]);
    });

    it('rejects ReadWriteOncePod combined with another mode', () => {
      expectRule(
        persistentVolumeClaim(
          '  accessModes:\n    - ReadWriteOnce\n    - ReadWriteOncePod\n' +
            '  resources:\n    requests:\n      storage: 10Gi\n',
        ),
        'persistentvolumeclaim/read-write-once-pod-exclusive',
      );
    });

    it('accepts ReadWriteOncePod alone', () => {
      expectRules(
        persistentVolumeClaim(
          '  accessModes:\n    - ReadWriteOncePod\n  resources:\n    requests:\n      storage: 10Gi\n',
        ),
        [],
      );
    });
  });

  describe('selector', () => {
    it('validates matchLabels keys', () => {
      const finding = expectRule(withStorage('  selector:\n    matchLabels:\n      "bad key": web\n'), 'meta/invalid-label-key');
      expect(finding.path).toEqual(['spec', 'selector', 'matchLabels', 'bad key']);
    });

    it('requires values for the In operator', () => {
      expectRule(
        withStorage(
          '  selector:\n    matchExpressions:\n      - key: tier\n        operator: In\n        values: []\n',
        ),
        'persistentvolumeclaim/selector-values-required',
      );
    });
  });

  describe('storage request', () => {
    it('requires resources.requests.storage', () => {
      const finding = expectRule(
        persistentVolumeClaim('  accessModes:\n    - ReadWriteOnce\n'),
        'persistentvolumeclaim/missing-storage-request',
      );
      expect(finding.path).toEqual(['spec', 'resources']);
    });

    it('rejects a zero storage request', () => {
      expectRule(
        persistentVolumeClaim(
          '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: "0"\n',
        ),
        'persistentvolumeclaim/non-positive-storage-request',
      );
    });

    it('leaves a malformed quantity to the schema layer', () => {
      const yaml = persistentVolumeClaim(
        '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10G1\n',
      );
      expectRule(yaml, 'schema/quantity');
      expectNoRule(yaml, 'persistentvolumeclaim/non-positive-storage-request');
    });
  });

  describe('storageClassName', () => {
    it('rejects one that is not a DNS subdomain', () => {
      const finding = expectRule(
        withStorage('  storageClassName: Fast_SSD\n'),
        'persistentvolumeclaim/invalid-storage-class-name',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'storageClassName'], value: 'fast-ssd' },
      ]);
    });

    it('treats an empty storageClassName as none', () => {
      expectNoRule(withStorage('  storageClassName: ""\n'), 'persistentvolumeclaim/invalid-storage-class-name');
    });
  });

  describe('volumeAttributesClassName', () => {
    it('rejects one that is not a DNS subdomain', () => {
      expectRule(
        withStorage('  volumeAttributesClassName: Silver_Tier\n'),
        'persistentvolumeclaim/invalid-volume-attributes-class-name',
      );
    });
  });

  describe('dataSource and dataSourceRef', () => {
    it('requires a name', () => {
      const finding = expectRule(
        withStorage('  dataSource:\n    kind: PersistentVolumeClaim\n'),
        'persistentvolumeclaim/missing-data-source-name',
      );
      expect(finding.path).toEqual(['spec', 'dataSource']);
    });

    it('requires a kind', () => {
      expectRule(
        withStorage('  dataSource:\n    name: source\n'),
        'persistentvolumeclaim/missing-data-source-kind',
      );
    });

    it('accepts a PersistentVolumeClaim reference with no apiGroup', () => {
      expectRules(withStorage('  dataSource:\n    kind: PersistentVolumeClaim\n    name: source\n'), []);
    });

    it('rejects a non-core kind with no apiGroup', () => {
      expectRule(
        withStorage('  dataSource:\n    kind: VolumeSnapshot\n    name: source\n'),
        'persistentvolumeclaim/data-source-kind-requires-api-group',
      );
    });

    it('accepts a non-core kind with an apiGroup', () => {
      expectRules(
        withStorage(
          '  dataSource:\n    apiGroup: snapshot.storage.k8s.io\n    kind: VolumeSnapshot\n    name: source\n',
        ),
        [],
      );
    });

    it('rejects an apiGroup that is not a DNS subdomain', () => {
      expectRule(
        withStorage(
          '  dataSource:\n    apiGroup: Snapshot.Storage\n    kind: VolumeSnapshot\n    name: source\n',
        ),
        'persistentvolumeclaim/invalid-data-source-api-group',
      );
    });

    it('rejects dataSource set alongside a cross-namespace dataSourceRef', () => {
      const finding = expectRule(
        withStorage(
          '  dataSource:\n    kind: PersistentVolumeClaim\n    name: source\n' +
            '  dataSourceRef:\n    kind: PersistentVolumeClaim\n    name: source\n    namespace: other\n',
        ),
        'persistentvolumeclaim/data-source-with-cross-namespace-ref',
      );
      expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['spec', 'dataSource'] }]);
    });

    it('rejects dataSource and dataSourceRef naming different objects', () => {
      expectRule(
        withStorage(
          '  dataSource:\n    kind: PersistentVolumeClaim\n    name: a\n' +
            '  dataSourceRef:\n    kind: PersistentVolumeClaim\n    name: b\n',
        ),
        'persistentvolumeclaim/data-source-mismatch',
      );
    });

    it('accepts dataSource and dataSourceRef naming the same object', () => {
      expectRules(
        withStorage(
          '  dataSource:\n    kind: PersistentVolumeClaim\n    name: a\n' +
            '  dataSourceRef:\n    kind: PersistentVolumeClaim\n    name: a\n',
        ),
        [],
      );
    });

    it('rejects a dataSourceRef.namespace that is not a DNS label', () => {
      expectRule(
        withStorage(
          '  dataSourceRef:\n    kind: PersistentVolumeClaim\n    name: source\n    namespace: Other_NS\n',
        ),
        'persistentvolumeclaim/invalid-data-source-namespace',
      );
    });
  });

  it('runs none of the pod spec rules', () => {
    const ids = ruleIds(persistentVolumeClaim('  containers:\n    - name: web\n      image: a\n'));
    expect(ids.every((id) => !id.startsWith('pod/'))).toBe(true);
    expect(ids).toContain('schema/unknown-field');
  });

  describe('claim spec reuse', () => {
    it('checks a StatefulSet volume claim template spec the same way', () => {
      const yaml = statefulSet(
        '  volumeClaimTemplates:\n    - metadata:\n        name: data\n      spec:\n' +
          '        accessModes:\n          - ReadWriteOnly\n        resources:\n          requests:\n            storage: 10Gi\n',
      );
      const finding = expectRule(yaml, 'persistentvolumeclaim/invalid-access-mode');
      expect(finding.path).toEqual(['spec', 'volumeClaimTemplates', 0, 'spec', 'accessModes', 0]);
    });

    it('checks a Pod ephemeral volume claim template spec the same way', () => {
      const yaml = pod(
        '  containers:\n    - name: web\n      image: nginx:1.27\n' +
          '  volumes:\n    - name: scratch\n      ephemeral:\n        volumeClaimTemplate:\n          spec:\n' +
          '            accessModes:\n              - ReadWriteOnly\n            resources:\n              requests:\n                storage: 1Gi\n',
      );
      const finding = expectRule(yaml, 'persistentvolumeclaim/invalid-access-mode');
      expect(finding.path).toEqual([
        'spec',
        'volumes',
        0,
        'ephemeral',
        'volumeClaimTemplate',
        'spec',
        'accessModes',
        0,
      ]);
    });
  });
});

describe('persistentvolume', () => {
  it('accepts a valid PersistentVolume', () => {
    expectRules(VALID_PERSISTENTVOLUME, []);
  });

  it('runs none of the pod spec rules', () => {
    const ids = ruleIds(persistentVolume('  containers:\n    - name: web\n      image: a\n'));
    expect(ids.every((id) => !id.startsWith('pod/'))).toBe(true);
    expect(ids).toContain('schema/unknown-field');
  });

  it('rejects a namespace, being cluster-scoped', () => {
    expectRule(
      persistentVolume(
        '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n',
        '  name: archive\n  namespace: storage\n',
      ),
      'meta/namespace-not-allowed',
    );
  });

  describe('access modes', () => {
    it('requires at least one', () => {
      expectRule(
        persistentVolume('  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n'),
        'persistentvolume/missing-access-modes',
      );
    });

    it('treats an empty list the same as a missing one', () => {
      expectRule(
        persistentVolume(
          '  accessModes: []\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/missing-access-modes',
      );
    });

    it('rejects an unknown mode, suggesting a close match', () => {
      const finding = expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnly\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/invalid-access-mode',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'accessModes', 0], value: 'ReadWriteOnce' },
      ]);
    });

    it('rejects ReadWriteOncePod combined with another mode', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n    - ReadWriteOncePod\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/read-write-once-pod-exclusive',
      );
    });

    it('accepts ReadWriteOncePod alone', () => {
      expectRules(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOncePod\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n',
        ),
        [],
      );
    });
  });

  describe('capacity', () => {
    it('requires it', () => {
      expectRule(
        persistentVolume('  accessModes:\n    - ReadWriteOnce\n  hostPath:\n    path: /mnt/data\n'),
        'persistentvolume/missing-capacity',
      );
    });

    it('treats an empty object the same as a missing one', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity: {}\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/missing-capacity',
      );
    });

    it('rejects a resource other than storage', () => {
      const finding = expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n    cpu: "1"\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/unsupported-capacity-resource',
      );
      expect(finding.message).toContain('cpu');
    });

    it('rejects capacity with no storage key at all', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    cpu: "1"\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/unsupported-capacity-resource',
      );
    });

    it('rejects a zero capacity', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 0\n  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/non-positive-capacity',
      );
    });

    it('leaves a malformed quantity to the schema layer', () => {
      const yaml = persistentVolume(
        '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: not-a-quantity\n  hostPath:\n    path: /mnt/data\n',
      );
      expectRule(yaml, 'schema/quantity');
      expectNoRule(yaml, 'persistentvolume/non-positive-capacity');
    });
  });

  describe('volume source', () => {
    it('requires one', () => {
      expectRule(
        persistentVolume('  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n'),
        'persistentvolume/missing-volume-source',
      );
    });

    it('rejects more than one', () => {
      const finding = expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n' +
            '  nfs:\n    server: nfs.example.com\n    path: /export\n',
        ),
        'persistentvolume/multiple-volume-sources',
      );
      expect(finding.message).toContain('hostPath');
      expect(finding.message).toContain('nfs');
    });
  });

  describe('node affinity', () => {
    it('requires it for a local volume', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/disks/ssd\n',
        ),
        'persistentvolume/missing-node-affinity',
      );
    });

    it('requires nodeAffinity.required', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/disks/ssd\n' +
            '  nodeAffinity: {}\n',
        ),
        'persistentvolume/missing-node-affinity-required',
      );
    });

    it('rejects empty nodeSelectorTerms', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/disks/ssd\n' +
            '  nodeAffinity:\n    required:\n      nodeSelectorTerms: []\n',
        ),
        'persistentvolume/empty-node-selector-terms',
      );
    });

    it('requires values for the In operator in a match expression', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/disks/ssd\n' +
            '  nodeAffinity:\n    required:\n      nodeSelectorTerms:\n        - matchExpressions:\n' +
            '            - key: disktype\n              operator: In\n',
        ),
        'persistentvolume/selector-values-required',
      );
    });

    it('accepts a local volume with node affinity', () => {
      expectRules(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/disks/ssd\n' +
            '  nodeAffinity:\n    required:\n      nodeSelectorTerms:\n        - matchExpressions:\n' +
            '            - key: disktype\n              operator: In\n              values:\n                - ssd\n',
        ),
        [],
      );
    });
  });

  describe('hostPath', () => {
    it('rejects a path with backsteps', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/../data\n',
        ),
        'persistentvolume/path-with-backsteps',
      );
    });

    it('rejects a root mount with a Recycle reclaim policy', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  persistentVolumeReclaimPolicy: Recycle\n' +
            '  hostPath:\n    path: /\n',
        ),
        'persistentvolume/recycle-host-path-root',
      );
    });

    it('accepts a non-root mount with a Recycle reclaim policy', () => {
      expectNoRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  persistentVolumeReclaimPolicy: Recycle\n' +
            '  hostPath:\n    path: /mnt/data\n',
        ),
        'persistentvolume/recycle-host-path-root',
      );
    });
  });

  describe('local', () => {
    it('rejects a path with backsteps', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  local:\n    path: /mnt/../disks\n' +
            '  nodeAffinity:\n    required:\n      nodeSelectorTerms:\n        - matchExpressions:\n' +
            '            - key: disktype\n              operator: Exists\n',
        ),
        'persistentvolume/path-with-backsteps',
      );
    });
  });

  describe('nfs', () => {
    it('rejects a relative path', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  nfs:\n    server: nfs.example.com\n    path: export/data\n',
        ),
        'persistentvolume/relative-nfs-path',
      );
    });

    it('accepts an absolute path', () => {
      expectNoRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  nfs:\n    server: nfs.example.com\n    path: /export/data\n',
        ),
        'persistentvolume/relative-nfs-path',
      );
    });
  });

  describe('csi', () => {
    it('rejects a driver name that is not a DNS subdomain', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
            '  csi:\n    driver: not_a_driver\n    volumeHandle: vol-1\n',
        ),
        'persistentvolume/invalid-csi-driver',
      );
    });

    it('accepts an upper-case driver name, which the apiserver lowercases first', () => {
      expectNoRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
            '  csi:\n    driver: EBS.csi.aws.com\n    volumeHandle: vol-1\n',
        ),
        'persistentvolume/invalid-csi-driver',
      );
    });

    it('rejects a driver name over 63 characters', () => {
      const longName = `${'a'.repeat(61)}.io`;
      expectRule(
        persistentVolume(
          `  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n` +
            `  csi:\n    driver: ${longName}\n    volumeHandle: vol-1\n`,
        ),
        'persistentvolume/invalid-csi-driver',
      );
    });
  });

  describe('storageClassName', () => {
    it('rejects one that is not a DNS subdomain', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n' +
            '  storageClassName: Fast_SSD\n',
        ),
        'persistentvolume/invalid-storage-class-name',
      );
    });

    it('treats an empty storageClassName as none', () => {
      expectNoRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n' +
            '  storageClassName: ""\n',
        ),
        'persistentvolume/invalid-storage-class-name',
      );
    });
  });

  describe('volumeAttributesClassName', () => {
    it('rejects an empty string', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
            '  csi:\n    driver: csi.example.com\n    volumeHandle: vol-1\n  volumeAttributesClassName: ""\n',
        ),
        'persistentvolume/empty-volume-attributes-class-name',
      );
    });

    it('rejects one that is not a DNS subdomain', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
            '  csi:\n    driver: csi.example.com\n    volumeHandle: vol-1\n  volumeAttributesClassName: Not_Valid\n',
        ),
        'persistentvolume/invalid-volume-attributes-class-name',
      );
    });

    it('requires a csi source', () => {
      expectRule(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n  hostPath:\n    path: /mnt/data\n' +
            '  volumeAttributesClassName: silver\n',
        ),
        'persistentvolume/volume-attributes-class-without-csi',
      );
    });

    it('accepts one alongside a csi source', () => {
      expectRules(
        persistentVolume(
          '  accessModes:\n    - ReadWriteOnce\n  capacity:\n    storage: 10Gi\n' +
            '  csi:\n    driver: csi.example.com\n    volumeHandle: vol-1\n  volumeAttributesClassName: silver\n',
        ),
        [],
      );
    });
  });
});

describe('httproute', () => {
  it('accepts a valid HTTPRoute', () => {
    expectRules(VALID_HTTPROUTE, []);
  });

  describe('parentRefs', () => {
    it('requires sectionName when two refs point at the same parent', () => {
      const yaml = httpRoute(
        '  parentRefs:\n    - name: shared-gateway\n    - name: shared-gateway\n' +
          '  rules:\n    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      const finding = expectRule(yaml, 'httproute/parent-ref-needs-section-name');
      expect(finding.message).toContain('sectionName');
    });

    it('accepts two refs to the same parent with distinct sectionNames', () => {
      const yaml = httpRoute(
        '  parentRefs:\n    - name: shared-gateway\n      sectionName: http\n' +
          '    - name: shared-gateway\n      sectionName: https\n' +
          '  rules:\n    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRules(yaml, []);
    });

    it('rejects two refs to the same parent naming the same sectionName', () => {
      const yaml = httpRoute(
        '  parentRefs:\n    - name: shared-gateway\n      sectionName: http\n' +
          '    - name: shared-gateway\n      sectionName: http\n' +
          '  rules:\n    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/duplicate-parent-ref-section');
    });

    it('does not flag two refs to different parents', () => {
      const yaml = httpRoute(
        '  parentRefs:\n    - name: gateway-a\n    - name: gateway-b\n' +
          '  rules:\n    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRules(yaml, []);
    });
  });

  it('rejects more than 128 matches across all rules', () => {
    const oneRuleWith = (n: number) => {
      const matches = Array.from(
        { length: n },
        (_, i) => `        - path:\n            type: Exact\n            value: /r${i}\n`,
      ).join('');
      return `    - matches:\n${matches}      backendRefs:\n        - name: web\n          port: 80\n`;
    };
    const yaml = httpRouteWithRule(oneRuleWith(50) + oneRuleWith(50) + oneRuleWith(50));
    const finding = expectRule(yaml, 'httproute/too-many-matches');
    expect(finding.message).toContain('150');
  });

  it('rejects a RequestRedirect filter alongside backendRefs on the same rule', () => {
    const yaml = httpRouteWithRule(
      '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
        '      filters:\n        - type: RequestRedirect\n          requestRedirect:\n            statusCode: 302\n' +
        '      backendRefs:\n        - name: web\n          port: 80\n',
    );
    expectRule(yaml, 'httproute/redirect-with-backend-refs');
  });

  describe('ReplacePrefixMatch', () => {
    it('requires exactly one PathPrefix match', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: Exact\n            value: /a\n' +
          '      filters:\n        - type: URLRewrite\n          urlRewrite:\n            path:\n' +
          '              type: ReplacePrefixMatch\n              replacePrefixMatch: /b\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/replace-prefix-needs-single-match');
    });

    it('accepts it with exactly one PathPrefix match', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /a\n' +
          '      filters:\n        - type: URLRewrite\n          urlRewrite:\n            path:\n' +
          '              type: ReplacePrefixMatch\n              replacePrefixMatch: /b\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectNoRule(yaml, 'httproute/replace-prefix-needs-single-match');
    });
  });

  describe('backend references', () => {
    it('requires a port on a Service backendRef', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n',
      );
      expectRule(yaml, 'httproute/backend-port-required');
    });

    it('does not require a port on a non-Service backendRef', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          group: example.com\n          kind: Function\n',
      );
      expectNoRule(yaml, 'httproute/backend-port-required');
    });

    it('requires a port on a requestMirror Service backendRef too', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestMirror\n          requestMirror:\n            backendRef:\n              name: shadow\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/backend-port-required');
    });
  });

  describe('filters', () => {
    it('rejects a filter list with both RequestRedirect and URLRewrite', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestRedirect\n          requestRedirect:\n            statusCode: 302\n' +
          '        - type: URLRewrite\n          urlRewrite:\n            hostname: other.example.com\n',
      );
      expectRule(yaml, 'httproute/redirect-and-rewrite');
    });

    it('rejects the same filter type twice in one list', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestHeaderModifier\n          requestHeaderModifier:\n' +
          '            add:\n              - name: X-A\n                value: "1"\n' +
          '        - type: RequestHeaderModifier\n          requestHeaderModifier:\n' +
          '            add:\n              - name: X-B\n                value: "2"\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/duplicate-filter');
    });

    it('requires the field matching the declared filter type, both directions', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestHeaderModifier\n          urlRewrite:\n            hostname: other.example.com\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      const mismatches = ruleIds(yaml).filter((id) => id === 'httproute/filter-type-mismatch');
      expect(mismatches.length).toBe(2);
    });

    it('rejects requestMirror setting both percent and fraction', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestMirror\n          requestMirror:\n' +
          '            backendRef:\n              name: shadow\n              port: 80\n' +
          '            percent: 10\n            fraction:\n              numerator: 1\n              denominator: 10\n',
      );
      expectRule(yaml, 'httproute/mirror-percent-and-fraction');
    });

    it('rejects a fraction numerator above its denominator', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: RequestMirror\n          requestMirror:\n' +
          '            backendRef:\n              name: shadow\n              port: 80\n' +
          '            fraction:\n              numerator: 11\n              denominator: 10\n',
      );
      expectRule(yaml, 'httproute/fraction-numerator-exceeds-denominator');
    });

    it('requires the field matching a path modifier type, both directions', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      filters:\n        - type: URLRewrite\n          urlRewrite:\n            path:\n' +
          '              type: ReplaceFullPath\n              replacePrefixMatch: /b\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      const mismatches = ruleIds(yaml).filter((id) => id === 'httproute/path-modifier-mismatch');
      expect(mismatches.length).toBe(2);
    });
  });

  describe('timeouts', () => {
    it('rejects a backendRequest timeout longer than the request timeout', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n' +
          '      timeouts:\n        request: 1s\n        backendRequest: 2s\n',
      );
      const finding = expectRule(yaml, 'httproute/timeout-order');
      expect(finding.message).toContain('backendRequest');
    });

    it('accepts a request timeout of 0s, meaning no limit', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: /\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n' +
          '      timeouts:\n        request: 0s\n        backendRequest: 5s\n',
      );
      expectNoRule(yaml, 'httproute/timeout-order');
    });
  });

  describe('match paths', () => {
    it('rejects a relative path', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: PathPrefix\n            value: a\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/path-value');
    });

    it('rejects a path containing "/../"', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: Exact\n            value: /a/../b\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectRule(yaml, 'httproute/path-value');
    });

    it('does not apply the same checks to a RegularExpression path', () => {
      const yaml = httpRouteWithRule(
        '    - matches:\n        - path:\n            type: RegularExpression\n            value: "^/a.*"\n' +
          '      backendRefs:\n        - name: web\n          port: 80\n',
      );
      expectNoRule(yaml, 'httproute/path-value');
    });
  });
});

describe('storageclass', () => {
  const topologies = (fragment: string) => storageClassWith(`allowedTopologies:\n${fragment}`);

  it('accepts a valid StorageClass', () => {
    expectRules(VALID_STORAGE_CLASS, []);
  });

  it('accepts a class that only groups statically provisioned volumes', () => {
    expectRules(storageClass('provisioner: kubernetes.io/no-provisioner\n'), []);
  });

  describe('provisioner', () => {
    it('leaves a missing provisioner to the schema layer', () => {
      const yaml = storageClass('reclaimPolicy: Delete\n');
      expectRule(yaml, 'schema/required-field');
      expectNoRule(yaml, 'storageclass/missing-provisioner');
    });

    it('reports an empty provisioner itself', () => {
      const finding = expectRule(
        storageClass("provisioner: ''\n"),
        'storageclass/missing-provisioner',
      );
      expect(finding.path).toEqual(['provisioner']);
    });

    it('accepts a domain-prefixed in-tree provisioner', () => {
      expectRules(storageClass('provisioner: kubernetes.io/aws-ebs\n'), []);
    });

    it('accepts an upper-case provisioner, which the apiserver lowercases first', () => {
      expectRules(storageClass('provisioner: EBS.csi.aws.com\n'), []);
    });

    it('rejects a provisioner with more than one slash', () => {
      const finding = expectRule(
        storageClass('provisioner: kubernetes.io/aws/ebs\n'),
        'storageclass/invalid-provisioner',
      );
      expect(finding.path).toEqual(['provisioner']);
      expect(finding.message).toContain('must not contain more than one "/"');
    });

    it('rejects a provisioner whose name part carries a space, and offers a fix', () => {
      const finding = expectRule(
        storageClass('provisioner: ebs csi driver\n'),
        'storageclass/invalid-provisioner',
      );
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['provisioner'], value: 'ebs-csi-driver' },
      ]);
    });

    it('rejects a provisioner with an invalid domain prefix', () => {
      const finding = expectRule(
        storageClass('provisioner: Kubernetes_io/aws-ebs\n'),
        'storageclass/invalid-provisioner',
      );
      expect(finding.message).toContain('prefix part');
    });
  });

  describe('parameters', () => {
    it('accepts an empty parameters map', () => {
      expectRules(storageClassWith('parameters: {}\n'), []);
    });

    it('rejects an empty key', () => {
      const finding = expectRule(
        storageClassWith("parameters:\n  '': gp3\n"),
        'storageclass/empty-parameter-key',
      );
      expect(finding.path).toEqual(['parameters']);
    });

    it('rejects more than 512 entries', () => {
      const entries = Array.from({ length: 513 }, (_, i) => `  key${i}: value\n`).join('');
      const finding = expectRule(
        storageClassWith(`parameters:\n${entries}`),
        'storageclass/too-many-parameters',
      );
      expect(finding.message).toContain('513');
    });

    it('rejects a map totalling more than 256 KiB', () => {
      const value = 'x'.repeat(60_000);
      const entries = Array.from({ length: 5 }, (_, i) => `  key${i}: ${value}\n`).join('');
      expectRule(storageClassWith(`parameters:\n${entries}`), 'storageclass/parameters-too-large');
    });
  });

  describe('reclaimPolicy and volumeBindingMode', () => {
    it('leaves both enums to the enum rule', () => {
      const finding = expectRule(
        storageClassWith('reclaimPolicy: delete\n'),
        'enum/invalid-value',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['reclaimPolicy'], value: 'Delete' },
      ]);
    });

    it('rejects Recycle, which only a PersistentVolume may say', () => {
      expectRule(storageClassWith('reclaimPolicy: Recycle\n'), 'enum/invalid-value');
    });

    it('reports nothing for an absent volumeBindingMode, which defaults', () => {
      expectRules(storageClass('provisioner: ebs.csi.aws.com\n'), []);
    });

    it('suggests the right binding mode for a near miss', () => {
      const finding = expectRule(
        storageClassWith('volumeBindingMode: WaitForFirstConsumers\n'),
        'enum/invalid-value',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['volumeBindingMode'], value: 'WaitForFirstConsumer' },
      ]);
    });
  });

  describe('allowedTopologies', () => {
    const zone = (values: string[], key = 'topology.kubernetes.io/zone') =>
      `  - matchLabelExpressions:\n      - key: ${key}\n        values:\n${values
        .map((value) => `          - ${value}\n`)
        .join('')}`;

    it('accepts a term restricting one label to two zones', () => {
      expectRules(topologies(zone(['us-east-1a', 'us-east-1b'])), []);
    });

    it('leaves a missing key to the schema layer', () => {
      const yaml = topologies(
        '  - matchLabelExpressions:\n      - values:\n          - us-east-1a\n',
      );
      expectRule(yaml, 'schema/required-field');
      expectNoRule(yaml, 'storageclass/invalid-topology-key');
    });

    it('rejects an empty values list', () => {
      const finding = expectRule(
        topologies(
          '  - matchLabelExpressions:\n      - key: topology.kubernetes.io/zone\n        values: []\n',
        ),
        'storageclass/empty-topology-values',
      );
      expect(finding.path).toEqual([
        'allowedTopologies',
        0,
        'matchLabelExpressions',
        0,
        'values',
      ]);
    });

    it('rejects a repeated value, and offers to remove it', () => {
      const finding = expectRule(
        topologies(zone(['us-east-1a', 'us-east-1a'])),
        'storageclass/duplicate-topology-value',
      );
      expect(finding.path).toEqual([
        'allowedTopologies',
        0,
        'matchLabelExpressions',
        0,
        'values',
        1,
      ]);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['allowedTopologies', 0, 'matchLabelExpressions', 0, 'values', 1] },
      ]);
    });

    it('rejects an invalid topology key', () => {
      const finding = expectRule(
        topologies(zone(['us-east-1a'], 'topology kubernetes io/zone')),
        'storageclass/invalid-topology-key',
      );
      expect(finding.path).toEqual(['allowedTopologies', 0, 'matchLabelExpressions', 0, 'key']);
    });

    it('rejects the same key twice in one term', () => {
      const yaml = topologies(
        '  - matchLabelExpressions:\n' +
          '      - key: topology.kubernetes.io/zone\n        values:\n          - us-east-1a\n' +
          '      - key: topology.kubernetes.io/zone\n        values:\n          - us-east-1b\n',
      );
      const finding = expectRule(yaml, 'storageclass/duplicate-topology-key');
      expect(finding.path).toEqual(['allowedTopologies', 0, 'matchLabelExpressions', 1, 'key']);
    });

    it('accepts the same key in two different terms', () => {
      expectRules(topologies(zone(['us-east-1a']) + zone(['us-east-1b'])), []);
    });

    it('rejects two terms requiring exactly the same thing', () => {
      const finding = expectRule(
        topologies(zone(['us-east-1a']) + zone(['us-east-1a'])),
        'storageclass/duplicate-topology-term',
      );
      expect(finding.path).toEqual(['allowedTopologies', 1, 'matchLabelExpressions']);
    });

    it('sees through the order values and expressions were written in', () => {
      const yaml = topologies(
        '  - matchLabelExpressions:\n' +
          '      - key: topology.kubernetes.io/zone\n        values:\n          - a\n          - b\n' +
          '      - key: topology.kubernetes.io/region\n        values:\n          - us-east-1\n' +
          '  - matchLabelExpressions:\n' +
          '      - key: topology.kubernetes.io/region\n        values:\n          - us-east-1\n' +
          '      - key: topology.kubernetes.io/zone\n        values:\n          - b\n          - a\n',
      );
      expectRule(yaml, 'storageclass/duplicate-topology-term');
    });
  });

  describe('default class annotation', () => {
    const annotated = (value: string, annotation = 'storageclass.kubernetes.io/is-default-class') =>
      storageClass(
        'provisioner: ebs.csi.aws.com\n',
        `  name: fast\n  annotations:\n    ${annotation}: ${value}\n`,
      );

    it('accepts the exact strings', () => {
      expectRules(annotated('"true"'), []);
      expectRules(annotated('"false"'), []);
    });

    it('reports a capitalised value, and offers to correct it', () => {
      const finding = expectRule(annotated('"True"'), 'storageclass/invalid-default-annotation');
      expect(finding.severity).toBe('warning');
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['metadata', 'annotations', 'storageclass.kubernetes.io/is-default-class'],
          value: 'true',
        },
      ]);
    });

    it('reports a value that is not a near miss, with no fix', () => {
      const finding = expectRule(annotated('"yes"'), 'storageclass/invalid-default-annotation');
      expect(finding.fix).toBeUndefined();
    });

    it('checks the beta annotation the admission plugin still honours', () => {
      const finding = expectRule(
        annotated('"True"', 'storageclass.beta.kubernetes.io/is-default-class'),
        'storageclass/invalid-default-annotation',
      );
      expect(finding.path).toEqual([
        'metadata',
        'annotations',
        'storageclass.beta.kubernetes.io/is-default-class',
      ]);
    });
  });

  describe('metadata', () => {
    it('rejects a namespace, since the kind is cluster-scoped', () => {
      const yaml = storageClass(
        'provisioner: ebs.csi.aws.com\n',
        '  name: fast\n  namespace: storage\n',
      );
      expectRule(yaml, 'meta/namespace-not-allowed');
    });

    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(
        storageClass('provisioner: ebs.csi.aws.com\n', '  name: Fast_Class\n'),
        'meta/invalid-name',
      );
    });
  });
});

describe('networkpolicy', () => {
  it('accepts a valid NetworkPolicy', () => {
    expectRules(VALID_NETWORKPOLICY, []);
  });

  it('accepts an empty podSelector, which selects every Pod in the namespace', () => {
    expectRules(networkPolicy('  podSelector: {}\n'), []);
  });

  describe('podSelector', () => {
    it('leaves an unrecognised operator to the enum rule', () => {
      const yaml = networkPolicy(
        '  podSelector:\n    matchExpressions:\n      - key: env\n        operator: Bogus\n',
      );
      expectRule(yaml, 'enum/invalid-value');
      expectNoRule(yaml, 'networkpolicy/selector-values-required');
    });

    it('rejects an In operator with no values', () => {
      const yaml = networkPolicy(
        '  podSelector:\n    matchExpressions:\n      - key: env\n        operator: In\n',
      );
      const finding = expectRule(yaml, 'networkpolicy/selector-values-required');
      expect(finding.path).toEqual(['spec', 'podSelector', 'matchExpressions', 0]);
    });

    it('rejects an invalid label key in matchLabels', () => {
      const yaml = networkPolicy('  podSelector:\n    matchLabels:\n      "": web\n');
      expectRule(yaml, 'meta/invalid-label-key');
    });
  });

  describe('policyTypes', () => {
    it('rejects an unrecognised entry, with a suggestion', () => {
      const finding = expectRule(
        networkPolicy('  podSelector: {}\n  policyTypes:\n    - ingress\n'),
        'networkpolicy/invalid-policy-type',
      );
      expect(finding.message).toContain('Did you mean "Ingress"');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'policyTypes', 0], value: 'Ingress' },
      ]);
    });

    it('rejects more than two entries', () => {
      const finding = expectRule(
        networkPolicy('  podSelector: {}\n  policyTypes:\n    - Ingress\n    - Egress\n    - Ingress\n'),
        'networkpolicy/too-many-policy-types',
      );
      expect(finding.path).toEqual(['spec', 'policyTypes']);
    });

    it('warns when egress rules are declared but policyTypes omits Egress', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  policyTypes:\n    - Ingress\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 10.0.0.0/8\n',
      );
      const finding = expectRule(yaml, 'networkpolicy/policy-type-mismatch');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['spec', 'egress']);
      expect(finding.fix?.safe).toBe(false);
    });

    it('does not warn when the rule list is covered', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  policyTypes:\n    - Egress\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 10.0.0.0/8\n',
      );
      expectNoRule(yaml, 'networkpolicy/policy-type-mismatch');
    });

    it('does not warn when policyTypes is left out entirely', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 10.0.0.0/8\n',
      );
      expectNoRule(yaml, 'networkpolicy/policy-type-mismatch');
    });

    it('does not double-report coverage on top of an already-invalid entry', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  policyTypes:\n    - ingress\n  egress:\n    - to:\n        - ipBlock:\n            cidr: 10.0.0.0/8\n',
      );
      expectNoRule(yaml, 'networkpolicy/policy-type-mismatch');
    });
  });

  describe('peers', () => {
    it('rejects a peer naming none of podSelector, namespaceSelector or ipBlock', () => {
      const finding = expectRule(networkPolicyWithPeer('        - {}\n'), 'networkpolicy/empty-peer');
      expect(finding.path).toEqual(['spec', 'ingress', 0, 'from', 0]);
    });

    it('rejects ipBlock combined with podSelector', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 10.0.0.0/8\n          podSelector:\n            matchLabels:\n              role: db\n',
      );
      expectRule(yaml, 'networkpolicy/ipblock-with-selector');
    });

    it('accepts a peer naming only a namespaceSelector', () => {
      expectRules(
        networkPolicyWithPeer('        - namespaceSelector:\n            matchLabels:\n              team: payments\n'),
        [],
      );
    });

    it('checks matchExpressions on a peer podSelector', () => {
      const yaml = networkPolicyWithPeer(
        '        - podSelector:\n            matchExpressions:\n              - key: role\n                operator: In\n',
      );
      expectRule(yaml, 'networkpolicy/selector-values-required');
    });
  });

  describe('ipBlock', () => {
    it('leaves a missing cidr to the schema layer', () => {
      const yaml = networkPolicyWithPeer('        - ipBlock: {}\n');
      expectRule(yaml, 'schema/required-field');
      expectNoRule(yaml, 'networkpolicy/missing-cidr');
    });

    it('reports an empty cidr itself', () => {
      const yaml = networkPolicyWithPeer("        - ipBlock:\n            cidr: ''\n");
      const finding = expectRule(yaml, 'networkpolicy/missing-cidr');
      expect(finding.path).toEqual(['spec', 'ingress', 0, 'from', 0, 'ipBlock', 'cidr']);
    });

    it('rejects a cidr with no prefix length', () => {
      const yaml = networkPolicyWithPeer('        - ipBlock:\n            cidr: 10.0.0.0\n');
      const finding = expectRule(yaml, 'networkpolicy/invalid-cidr');
      expect(finding.message).toContain('prefix length');
    });

    it('warns about a cidr with bits set beyond its prefix, and offers the masked fix', () => {
      const yaml = networkPolicyWithPeer('        - ipBlock:\n            cidr: 10.1.1.5/8\n');
      const finding = expectRule(yaml, 'networkpolicy/cidr-host-bits');
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('10.0.0.0/8');
      expect(finding.fix).toEqual({
        title: 'Change to "10.0.0.0/8"',
        safe: true,
        ops: [
          { op: 'set', path: ['spec', 'ingress', 0, 'from', 0, 'ipBlock', 'cidr'], value: '10.0.0.0/8' },
        ],
      });
    });

    it('does not warn about a cidr that is already masked', () => {
      const yaml = networkPolicyWithPeer('        - ipBlock:\n            cidr: 10.0.0.0/8\n');
      expectNoRule(yaml, 'networkpolicy/cidr-host-bits');
    });

    it('accepts an except that is a strict subset of cidr', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 10.0.0.0/8\n            except:\n              - 10.0.0.0/24\n',
      );
      expectRules(yaml, []);
    });

    it('rejects an except that is not inside cidr', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 10.0.0.0/8\n            except:\n              - 11.0.0.0/24\n',
      );
      const finding = expectRule(yaml, 'networkpolicy/except-not-subset');
      expect(finding.path).toEqual(['spec', 'ingress', 0, 'from', 0, 'ipBlock', 'except', 0]);
    });

    it('rejects an except with the same or a wider prefix than cidr', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 10.0.0.0/8\n            except:\n              - 10.0.0.0/8\n',
      );
      expectRule(yaml, 'networkpolicy/except-not-subset');
    });

    it('rejects an except that is not a CIDR block', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 10.0.0.0/8\n            except:\n              - not-a-cidr\n',
      );
      expectRule(yaml, 'networkpolicy/invalid-cidr');
    });

    it('accepts an IPv6 block with a strict-subset except', () => {
      const yaml = networkPolicyWithPeer(
        '        - ipBlock:\n            cidr: 2001:db8::/32\n            except:\n              - 2001:db8:1::/48\n',
      );
      expectRules(yaml, []);
    });
  });

  describe('ports', () => {
    it('leaves an unrecognised protocol to the enum rule', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  ingress:\n    - ports:\n        - protocol: udp\n          port: 80\n',
      );
      expectRule(yaml, 'enum/invalid-value');
    });

    it('rejects a port number out of range', () => {
      const yaml = networkPolicy('  podSelector: {}\n  ingress:\n    - ports:\n        - port: 70000\n');
      const finding = expectRule(yaml, 'networkpolicy/invalid-port');
      expect(finding.path).toEqual(['spec', 'ingress', 0, 'ports', 0, 'port']);
    });

    it('rejects an invalid port name', () => {
      // Quoted, this is read as a name — and a name of only digits has no
      // letter, which IsValidPortName requires.
      const yaml = networkPolicy('  podSelector: {}\n  ingress:\n    - ports:\n        - port: "8080"\n');
      const finding = expectRule(yaml, 'networkpolicy/invalid-port-name');
      expect(finding.message).toContain('at least one letter');
    });

    it('accepts a named port', () => {
      expectRules(
        networkPolicy('  podSelector: {}\n  ingress:\n    - ports:\n        - port: http\n'),
        [],
      );
    });

    it('rejects endPort without port', () => {
      const yaml = networkPolicy('  podSelector: {}\n  ingress:\n    - ports:\n        - endPort: 90\n');
      const finding = expectRule(yaml, 'networkpolicy/endport-without-port');
      expect(finding.path).toEqual(['spec', 'ingress', 0, 'ports', 0, 'endPort']);
    });

    it('rejects endPort with a named port', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  ingress:\n    - ports:\n        - port: http\n          endPort: 90\n',
      );
      expectRule(yaml, 'networkpolicy/endport-with-named-port');
    });

    it('rejects endPort below port', () => {
      const yaml = networkPolicy(
        '  podSelector: {}\n  ingress:\n    - ports:\n        - port: 8080\n          endPort: 80\n',
      );
      const finding = expectRule(yaml, 'networkpolicy/endport-before-port');
      expect(finding.message).toContain('greater than or equal to');
    });

    it('accepts a valid port range', () => {
      expectRules(
        networkPolicy(
          '  podSelector: {}\n  ingress:\n    - ports:\n        - port: 8000\n          endPort: 9000\n',
        ),
        [],
      );
    });
  });
});

describe('configmap', () => {
  it('accepts a valid ConfigMap', () => {
    expectRules(VALID_CONFIGMAP, []);
  });

  it('accepts a ConfigMap with no data at all', () => {
    expectRules(configMap(''), []);
  });

  describe('keys', () => {
    it('rejects a key with a character a filename may not carry', () => {
      const finding = expectRule(
        configMapData('  "log level": info\n'),
        'configmap/invalid-key',
      );
      expect(finding.path).toEqual(['data', 'log level']);
      expect(finding.fix?.ops).toEqual([
        { op: 'rename', path: ['data', 'log level'], to: 'log_level' },
      ]);
      // Every Pod referring to the key would have to change with it.
      expect(finding.fix?.safe).toBe(false);
    });

    it('rejects a key with a "/" and does not suggest a path', () => {
      const finding = expectRule(configMapData('  app/config: info\n'), 'configmap/invalid-key');
      expect(finding.fix?.ops).toEqual([
        { op: 'rename', path: ['data', 'app/config'], to: 'app_config' },
      ]);
    });

    it('rejects a key over 253 characters, with no fix to offer', () => {
      const finding = expectRule(
        configMapData(`  ${'k'.repeat(254)}: info\n`),
        'configmap/invalid-key',
      );
      expect(finding.message).toContain('at most 253 characters');
      expect(finding.fix).toBeUndefined();
    });

    it('checks binaryData keys the same way', () => {
      const finding = expectRule(
        configMap('binaryData:\n  "icon file": AAAA\n'),
        'configmap/invalid-key',
      );
      expect(finding.path).toEqual(['binaryData', 'icon file']);
    });

    it('accepts uppercase, digits, "-", "_" and "."', () => {
      expectRules(configMapData('  LOG_LEVEL.2: info\n  my-file.conf: a\n'), []);
    });

    it('rejects "." and ".." as paths rather than as spellings', () => {
      for (const key of ['.', '..', '..data']) {
        const finding = expectRule(configMapData(`  "${key}": a\n`), 'configmap/relative-path-key');
        expect(finding.path).toEqual(['data', key]);
        expect(finding.fix).toBeUndefined();
      }
    });

    it('accepts a leading single dot, which is only a hidden file', () => {
      expectRules(configMapData('  .env: A=1\n'), []);
    });
  });

  describe('data and binaryData overlapping', () => {
    it('rejects a key present in both maps', () => {
      const yaml = configMap('data:\n  config: a\nbinaryData:\n  config: YQ==\n');
      const finding = expectRule(yaml, 'configmap/duplicate-key');
      expect(finding.path).toEqual(['data', 'config']);
    });

    it('accepts the two maps when their keys are distinct', () => {
      expectRules(configMap('data:\n  config: a\nbinaryData:\n  icon: YQ==\n'), []);
    });
  });

  describe('binaryData values', () => {
    it('leaves a value that is not base64 to the schema layer', () => {
      const yaml = configMap('binaryData:\n  icon: not base64!\n');
      const finding = expectRule(yaml, 'schema/base64');
      expect(finding.path).toEqual(['binaryData', 'icon']);
      expectNoRule(yaml, 'configmap/too-large');
    });

    it('rejects base64 that is not padded to a multiple of four', () => {
      expectRule(configMap('binaryData:\n  icon: YQ\n'), 'schema/base64');
    });

    it('accepts a value wrapped across lines', () => {
      expectRules(configMap('binaryData:\n  icon: |\n    YWJjZGVm\n    Z2hpamts\n'), []);
    });

    it('says nothing about a plain data value, which is not base64 at all', () => {
      expectNoRule(configMapData('  greeting: hello world!\n'), 'schema/base64');
    });
  });

  describe('total size', () => {
    it('rejects data and binaryData that together exceed 1 MiB', () => {
      const finding = expectRule(
        configMap(`data:\n  a: ${'x'.repeat(600 * 1024)}\nbinaryData:\n  b: ${'A'.repeat(700 * 1024)}\n`),
        'configmap/too-large',
      );
      expect(finding.path).toEqual([]);
      expect(finding.message).toContain('1.0 MiB limit');
    });

    it('measures a data value in bytes rather than characters', () => {
      // Three bytes per "€", so 400k of them are over the cap that 400k
      // ASCII characters would sit well under.
      expectRule(
        configMapData(`  a: ${'€'.repeat(400 * 1024)}\n`),
        'configmap/too-large',
      );
      expectRules(configMapData(`  a: ${'x'.repeat(400 * 1024)}\n`), []);
    });
  });

  describe('metadata', () => {
    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(configMap('', '  name: Web_Config\n'), 'meta/invalid-name');
    });

    it('accepts a namespace, since a ConfigMap is namespaced', () => {
      expectRules(configMap('', '  name: web-config\n  namespace: shop\n'), []);
    });
  });
});

describe('secret', () => {
  it('accepts a valid Secret', () => {
    expectRules(VALID_SECRET, []);
  });

  it('accepts an empty Opaque Secret', () => {
    expectRules(secret(''), []);
  });

  describe('keys', () => {
    it('rejects a key with a character a filename may not carry', () => {
      const finding = expectRule(secretData('  "log level": dGVzdA==\n'), 'secret/invalid-key');
      expect(finding.path).toEqual(['data', 'log level']);
      expect(finding.fix?.ops).toEqual([
        { op: 'rename', path: ['data', 'log level'], to: 'log_level' },
      ]);
      // Every Pod referring to the key would have to change with it.
      expect(finding.fix?.safe).toBe(false);
    });

    it('rejects a key with a "/" and does not suggest a path', () => {
      const finding = expectRule(secretData('  app/config: dGVzdA==\n'), 'secret/invalid-key');
      expect(finding.fix?.ops).toEqual([
        { op: 'rename', path: ['data', 'app/config'], to: 'app_config' },
      ]);
    });

    it('rejects a key over 253 characters, with no fix to offer', () => {
      const finding = expectRule(
        secretData(`  ${'k'.repeat(254)}: dGVzdA==\n`),
        'secret/invalid-key',
      );
      expect(finding.message).toContain('at most 253 characters');
      expect(finding.fix).toBeUndefined();
    });

    it('checks stringData keys the same way', () => {
      const finding = expectRule(
        secret('stringData:\n  "log level": debug\n'),
        'secret/invalid-key',
      );
      expect(finding.path).toEqual(['stringData', 'log level']);
    });

    it('accepts uppercase, digits, "-", "_" and "."', () => {
      expectRules(secretData('  LOG_LEVEL.2: dGVzdA==\n  my-file.conf: dGVzdA==\n'), []);
    });

    it('rejects "." and ".." as paths rather than as spellings', () => {
      for (const key of ['.', '..', '..data']) {
        const finding = expectRule(secretData(`  "${key}": dGVzdA==\n`), 'secret/relative-path-key');
        expect(finding.path).toEqual(['data', key]);
        expect(finding.fix).toBeUndefined();
      }
    });

    it('accepts a leading single dot, which is only a hidden file', () => {
      expectRules(secretData('  .env: QT0x\n'), []);
    });
  });

  describe('data and stringData overlapping', () => {
    it('warns about a key present in both maps, rather than rejecting it', () => {
      const yaml = secret('data:\n  password: cGFzcw==\nstringData:\n  password: hunter2\n');
      const finding = expectRule(yaml, 'secret/overlapping-key');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['stringData', 'password']);
    });

    it('accepts the two maps when their keys are distinct', () => {
      expectRules(secret('data:\n  a: dGVzdA==\nstringData:\n  b: test\n'), []);
    });
  });

  describe('total size', () => {
    it('rejects data and stringData that together exceed 1 MiB', () => {
      const finding = expectRule(
        secret(`data:\n  a: ${'A'.repeat(600 * 1024)}\nstringData:\n  b: ${'x'.repeat(600 * 1024)}\n`),
        'secret/too-large',
      );
      expect(finding.path).toEqual([]);
      expect(finding.message).toContain('1.0 MiB limit');
    });

    it('measures a stringData value in bytes rather than characters', () => {
      // Three bytes per "€", so 400k of them are over the cap that 400k
      // ASCII characters would sit well under.
      expectRule(secret(`stringData:\n  a: ${'€'.repeat(400 * 1024)}\n`), 'secret/too-large');
      expectRules(secret(`stringData:\n  a: ${'x'.repeat(400 * 1024)}\n`), []);
    });

    it('measures an overlapping key by its stringData value, not its data value', () => {
      // data's own value alone decodes to a few bytes; stringData overwrites
      // it with something large enough to be over the cap on its own.
      const finding = expectRule(
        secret(`data:\n  a: dGVzdA==\nstringData:\n  a: ${'x'.repeat(1200 * 1024)}\n`),
        'secret/too-large',
      );
      expect(finding.path).toEqual([]);
    });

    it('does not count an overlapping key under both maps', () => {
      // Each half sits under the cap alone; if the overlapping key were
      // counted under both maps at once the total would clear it.
      const half = 'x'.repeat(600 * 1024);
      expectRules(secret(`data:\n  a: ${btoa(half)}\nstringData:\n  a: ${half}\n`), [
        'secret/overlapping-key',
      ]);
    });
  });

  describe('type: kubernetes.io/tls', () => {
    it('requires tls.crt and tls.key to both be present', () => {
      expectRules(secret('type: kubernetes.io/tls\ndata:\n  tls.crt: dGVzdA==\n'), [
        'secret/missing-tls-key',
      ]);
      expectRules(secret('type: kubernetes.io/tls\n'), ['secret/missing-tls-key']);
    });

    it('accepts an empty value, since only presence is required', () => {
      expectRules(secret('type: kubernetes.io/tls\ndata:\n  tls.crt: ""\n  tls.key: ""\n'), []);
    });
  });

  describe('type: kubernetes.io/basic-auth', () => {
    it('requires at least one of username or password, non-empty', () => {
      expectRule(secret('type: kubernetes.io/basic-auth\n'), 'secret/missing-basic-auth-key');
    });

    it('rejects both keys present but empty', () => {
      expectRule(
        secret('type: kubernetes.io/basic-auth\ndata:\n  username: ""\n  password: ""\n'),
        'secret/missing-basic-auth-key',
      );
    });

    it('accepts a username with no password', () => {
      expectRules(secret('type: kubernetes.io/basic-auth\nstringData:\n  username: admin\n'), []);
    });
  });

  describe('type: kubernetes.io/ssh-auth', () => {
    it('requires a non-empty ssh-privatekey', () => {
      expectRule(secret('type: kubernetes.io/ssh-auth\n'), 'secret/missing-ssh-key');
    });

    it('rejects an empty ssh-privatekey', () => {
      expectRule(
        secret('type: kubernetes.io/ssh-auth\ndata:\n  ssh-privatekey: ""\n'),
        'secret/missing-ssh-key',
      );
    });

    it('accepts a non-empty one', () => {
      expectRules(secret('type: kubernetes.io/ssh-auth\ndata:\n  ssh-privatekey: dGVzdA==\n'), []);
    });
  });

  describe('type: kubernetes.io/dockercfg', () => {
    it('requires a non-empty .dockercfg key', () => {
      expectRule(secret('type: kubernetes.io/dockercfg\n'), 'secret/missing-docker-config');
    });

    it('rejects a value that does not decode to a JSON object', () => {
      const finding = expectRule(
        secret("type: kubernetes.io/dockercfg\nstringData:\n  .dockercfg: '[1,2,3]'\n"),
        'secret/invalid-docker-config',
      );
      expect(finding.path).toEqual(['data', '.dockercfg']);
    });

    it("accepts null, which Go's json.Unmarshal accepts into a map", () => {
      expectRules(secret('type: kubernetes.io/dockercfg\nstringData:\n  .dockercfg: "null"\n'), []);
    });

    it('accepts a well-formed registry config', () => {
      expectRules(
        secret(
          "type: kubernetes.io/dockercfg\nstringData:\n  .dockercfg: '{\"registry.example.com\":{\"auth\":\"dGVzdA==\"}}'\n",
        ),
        [],
      );
    });
  });

  describe('type: kubernetes.io/dockerconfigjson', () => {
    it('requires a non-empty .dockerconfigjson key', () => {
      expectRule(secret('type: kubernetes.io/dockerconfigjson\n'), 'secret/missing-docker-config');
    });

    it('rejects a value that does not decode to a JSON object', () => {
      expectRule(
        secret('type: kubernetes.io/dockerconfigjson\nstringData:\n  .dockerconfigjson: "not json"\n'),
        'secret/invalid-docker-config',
      );
    });

    it('accepts a well-formed auths document', () => {
      expectRules(
        secret("type: kubernetes.io/dockerconfigjson\nstringData:\n  .dockerconfigjson: '{\"auths\":{}}'\n"),
        [],
      );
    });
  });

  describe('type: kubernetes.io/service-account-token', () => {
    it('requires a non-empty service-account name annotation', () => {
      expectRule(
        secret('type: kubernetes.io/service-account-token\n'),
        'secret/missing-service-account-name',
      );
    });

    it('accepts one with the annotation set', () => {
      expectRules(
        secret(
          'type: kubernetes.io/service-account-token\n',
          '  name: web-tls\n  annotations:\n    kubernetes.io/service-account.name: web\n',
        ),
        [],
      );
    });
  });

  describe('unknown type', () => {
    it('warns on a near-miss of a well-known type, with a safe fix', () => {
      const finding = expectRule(secret('type: kubernetes.io/TLS\n'), 'secret/unknown-type');
      expect(finding.severity).toBe('warning');
      expect(finding.fix).toEqual({
        title: 'Change to "kubernetes.io/tls"',
        safe: true,
        ops: [{ op: 'set', path: ['type'], value: 'kubernetes.io/tls' }],
      });
    });

    it('says nothing about an arbitrary third-party type', () => {
      expectRules(secret('type: helm.sh/release.v1\n'), []);
    });

    it('says nothing about Opaque, the default', () => {
      expectRules(secret('type: Opaque\n'), []);
    });
  });

  describe('metadata', () => {
    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(secret('', '  name: Web_TLS\n'), 'meta/invalid-name');
    });

    it('accepts a namespace, since a Secret is namespaced', () => {
      expectRules(secret('', '  name: web-tls\n  namespace: shop\n'), []);
    });
  });
});

describe('ResourceQuota rules', () => {
  it('lints a valid ResourceQuota cleanly', () => {
    expectRules(VALID_RESOURCEQUOTA, []);
  });

  describe('hard', () => {
    it('rejects an unprefixed name the quota system does not count', () => {
      const finding = expectRule(
        resourceQuotaHard('    deployments: "10"\n'),
        'resourcequota/unknown-resource-name',
      );
      expect(finding.path).toEqual(['spec', 'hard', 'deployments']);
    });

    it('accepts a domain-prefixed extended resource and the generic object counter', () => {
      expectRules(
        resourceQuotaHard('    "count/deployments.apps": "10"\n    "nvidia.com/gpu": "4"\n'),
        [],
      );
    });

    it('rejects a key that is not a qualified name', () => {
      expectRule(resourceQuotaHard('    "not a name": "1"\n'), 'resourcequota/invalid-resource-name');
    });

    it('rejects a negative limit', () => {
      expectRule(resourceQuotaHard('    pods: "-1"\n'), 'resourcequota/negative-quantity');
    });

    it('rejects a fractional count of objects', () => {
      expectRule(resourceQuotaHard('    pods: "20.5"\n'), 'resourcequota/fractional-count');
    });

    it('accepts a fractional amount of compute, which is not a count', () => {
      expectRules(resourceQuotaHard('    requests.cpu: "1.5"\n    limits.memory: 512Mi\n'), []);
    });
  });

  describe('scopes', () => {
    it('rejects an unrecognised scope, with a safe fix', () => {
      const finding = expectRule(
        resourceQuota('  scopes:\n    - besteffort\n'),
        'resourcequota/unknown-scope',
      );
      expect(finding.fix).toEqual({
        title: 'Change to "BestEffort"',
        safe: true,
        ops: [{ op: 'set', path: ['spec', 'scopes', 0], value: 'BestEffort' }],
      });
    });

    it('rejects two scopes that select complementary sets of Pods', () => {
      expectRule(
        resourceQuota('  scopes:\n    - Terminating\n    - NotTerminating\n'),
        'resourcequota/conflicting-scopes',
      );
    });

    it('rejects a Pod-selecting scope beside a resource a Pod does not consume', () => {
      expectRule(
        resourceQuota('  hard:\n    secrets: "10"\n  scopes:\n    - NotBestEffort\n'),
        'resourcequota/scope-not-valid-for-resource',
      );
    });

    it('rejects compute beside BestEffort, which can only count Pods', () => {
      expectRule(
        resourceQuota('  hard:\n    requests.cpu: "4"\n  scopes:\n    - BestEffort\n'),
        'resourcequota/scope-not-valid-for-resource',
      );
    });

    it('says nothing about compute beside a scope that allows it', () => {
      expectRules(
        resourceQuota('  hard:\n    requests.cpu: "4"\n    pods: "10"\n  scopes:\n    - Terminating\n'),
        [],
      );
    });

    it('says nothing about an extended resource beside any scope', () => {
      expectRules(
        resourceQuota('  hard:\n    "nvidia.com/gpu": "4"\n  scopes:\n    - BestEffort\n'),
        [],
      );
    });
  });

  describe('scopeSelector', () => {
    const expressions = (fragment: string) =>
      resourceQuota(`  scopeSelector:\n    matchExpressions:\n${fragment}`);

    it('rejects an operator other than Exists on a scope with no values to match', () => {
      const finding = expectRule(
        expressions('      - scopeName: BestEffort\n        operator: In\n        values:\n          - high\n'),
        'resourcequota/scope-operator',
      );
      expect(finding.path).toEqual([
        'spec', 'scopeSelector', 'matchExpressions', 0, 'operator',
      ]);
    });

    it('accepts In on PriorityClass, the one scope that carries a value', () => {
      expectRules(
        expressions('      - scopeName: PriorityClass\n        operator: In\n        values:\n          - high\n'),
        [],
      );
    });

    it('requires values under In', () => {
      expectRule(
        expressions('      - scopeName: PriorityClass\n        operator: In\n'),
        'resourcequota/missing-scope-values',
      );
    });

    it('forbids values under Exists', () => {
      expectRule(
        expressions('      - scopeName: PriorityClass\n        operator: Exists\n        values:\n          - high\n'),
        'resourcequota/unexpected-scope-values',
      );
    });

    it('leaves an unrecognised scopeName to the enum rule', () => {
      expectRules(
        expressions('      - scopeName: BestEfort\n        operator: Exists\n'),
        ['enum/invalid-value'],
      );
    });

    it('rejects conflicting scopes across two requirements', () => {
      expectRule(
        expressions(
          '      - scopeName: Terminating\n        operator: Exists\n' +
            '      - scopeName: NotTerminating\n        operator: Exists\n',
        ),
        'resourcequota/conflicting-scopes',
      );
    });
  });

  describe('metadata', () => {
    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(resourceQuota('  hard:\n    pods: "1"\n', '  name: Compute_Quota\n'), 'meta/invalid-name');
    });

    it('accepts a namespace, since a ResourceQuota is namespaced', () => {
      expectRules(
        resourceQuota('  hard:\n    pods: "1"\n', '  name: compute\n  namespace: shop\n'),
        [],
      );
    });
  });
});

describe('LimitRange rules', () => {
  it('lints a valid LimitRange cleanly', () => {
    expectRules(VALID_LIMITRANGE, []);
  });

  describe('limits entries', () => {
    it('rejects a second entry for the same type', () => {
      const finding = expectRule(
        limitRange('  limits:\n    - type: Container\n    - type: Container\n'),
        'limitrange/duplicate-type',
      );
      expect(finding.path).toEqual(['spec', 'limits', 1, 'type']);
    });

    it('accepts one entry per type', () => {
      expectRules(
        limitRange(
          '  limits:\n    - type: Container\n    - type: Pod\n' +
            '    - type: PersistentVolumeClaim\n      min:\n        storage: 1Gi\n',
        ),
        [],
      );
    });

    it('leaves an unrecognised type to the enum rule', () => {
      expectRules(limitRange('  limits:\n    - type: container\n'), ['enum/invalid-value']);
    });

    it('forbids a default on a Pod entry, which has nothing to default', () => {
      const finding = expectRule(
        limitRangeItem('      default:\n        cpu: "1"\n', 'Pod'),
        'limitrange/default-not-allowed',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'default']);
    });

    it('forbids a defaultRequest on a Pod entry too', () => {
      expectRule(
        limitRangeItem('      defaultRequest:\n        cpu: "1"\n', 'Pod'),
        'limitrange/default-not-allowed',
      );
    });

    it('requires a storage bound on a PersistentVolumeClaim entry', () => {
      expectRule(
        limitRangeItem('      max:\n        cpu: "1"\n', 'PersistentVolumeClaim'),
        'limitrange/missing-storage-constraint',
      );
    });

    it('accepts a PersistentVolumeClaim entry bounding either end of storage', () => {
      expectRules(limitRangeItem('      max:\n        storage: 10Gi\n', 'PersistentVolumeClaim'), []);
    });
  });

  describe('resource names', () => {
    it('rejects an unprefixed name the API does not define, with a safe fix', () => {
      const finding = expectRule(
        limitRangeItem('      max:\n        memroy: 1Gi\n'),
        'limitrange/unknown-resource-name',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'max', 'memroy']);
      expect(finding.fix).toEqual({
        title: 'Rename to "memory"',
        safe: true,
        ops: [{ op: 'rename', path: ['spec', 'limits', 0, 'max', 'memroy'], to: 'memory' }],
      });
    });

    it('accepts bare storage, which a quota may not bound', () => {
      expectRules(limitRangeItem('      max:\n        storage: 10Gi\n', 'PersistentVolumeClaim'), []);
    });

    it('accepts a domain-prefixed extended resource and a hugepages size', () => {
      expectRules(
        limitRangeItem('      max:\n        "nvidia.com/gpu": "4"\n        hugepages-2Mi: 100Mi\n'),
        [],
      );
    });

    it('rejects a key that is not a qualified name', () => {
      expectRule(
        limitRangeItem('      min:\n        "not a name": "1"\n'),
        'limitrange/invalid-resource-name',
      );
    });

    it('does not read the keys of a Pod entry\'s defaults, which are forbidden outright', () => {
      expectRules(limitRangeItem('      default:\n        memroy: 1Gi\n', 'Pod'), [
        'limitrange/default-not-allowed',
      ]);
    });
  });

  describe('consistency', () => {
    it('rejects a min above its own max', () => {
      const finding = expectRule(
        limitRangeItem('      min:\n        memory: 2Gi\n      max:\n        memory: 1Gi\n'),
        'limitrange/conflicting-constraints',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'min', 'memory']);
    });

    it('rejects a defaultRequest below the min', () => {
      const finding = expectRule(
        limitRangeItem('      min:\n        cpu: 500m\n      defaultRequest:\n        cpu: 100m\n'),
        'limitrange/conflicting-constraints',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'defaultRequest', 'cpu']);
    });

    it('rejects a default above the max', () => {
      const finding = expectRule(
        limitRangeItem('      max:\n        cpu: "1"\n      default:\n        cpu: "2"\n'),
        'limitrange/conflicting-constraints',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'default', 'cpu']);
    });

    it('rejects a defaultRequest above its own default', () => {
      expectRule(
        limitRangeItem('      default:\n        cpu: 100m\n      defaultRequest:\n        cpu: 200m\n'),
        'limitrange/conflicting-constraints',
      );
    });

    it('says nothing when the four constraints are ordered', () => {
      expectRules(
        limitRangeItem(
          '      min:\n        cpu: 100m\n      defaultRequest:\n        cpu: 200m\n' +
            '      default:\n        cpu: 500m\n      max:\n        cpu: "1"\n',
        ),
        [],
      );
    });

    it('compares each resource on its own', () => {
      expectRules(
        limitRangeItem('      min:\n        cpu: 100m\n        memory: 64Mi\n      max:\n        cpu: "1"\n'),
        [],
      );
    });
  });

  describe('maxLimitRequestRatio', () => {
    it('rejects a ratio below 1', () => {
      const finding = expectRule(
        limitRangeItem('      maxLimitRequestRatio:\n        cpu: "0.5"\n'),
        'limitrange/ratio-below-one',
      );
      expect(finding.path).toEqual(['spec', 'limits', 0, 'maxLimitRequestRatio', 'cpu']);
    });

    it('rejects a ratio wider than the min and max already allow', () => {
      expectRule(
        limitRangeItem(
          '      min:\n        cpu: 500m\n      max:\n        cpu: "1"\n' +
            '      maxLimitRequestRatio:\n        cpu: "4"\n',
        ),
        'limitrange/ratio-above-max-min',
      );
    });

    it('accepts a ratio the min and max leave room for', () => {
      expectRules(
        limitRangeItem(
          '      min:\n        cpu: 250m\n      max:\n        cpu: "1"\n' +
            '      maxLimitRequestRatio:\n        cpu: "4"\n',
        ),
        [],
      );
    });
  });

  describe('overcommit', () => {
    it('requires the two defaults to agree for an extended resource', () => {
      const finding = expectRule(
        limitRangeItem(
          '      default:\n        "nvidia.com/gpu": "2"\n' +
            '      defaultRequest:\n        "nvidia.com/gpu": "1"\n',
        ),
        'limitrange/overcommit-not-allowed',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'limits', 0, 'defaultRequest', 'nvidia.com/gpu'], value: '2' },
      ]);
    });

    it('requires them to agree for hugepages too', () => {
      expectRule(
        limitRangeItem(
          '      default:\n        hugepages-2Mi: 100Mi\n' +
            '      defaultRequest:\n        hugepages-2Mi: 50Mi\n',
        ),
        'limitrange/overcommit-not-allowed',
      );
    });

    it('allows them to differ for cpu, which can be overcommitted', () => {
      expectRules(
        limitRangeItem('      default:\n        cpu: "1"\n      defaultRequest:\n        cpu: 500m\n'),
        [],
      );
    });
  });

  describe('metadata', () => {
    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(
        limitRange('  limits:\n    - type: Container\n', '  name: Compute_Limits\n'),
        'meta/invalid-name',
      );
    });

    it('accepts a namespace, since a LimitRange is namespaced', () => {
      expectRules(
        limitRange('  limits:\n    - type: Container\n', '  name: compute\n  namespace: shop\n'),
        [],
      );
    });
  });
});

describe('ServiceAccount rules', () => {
  it('lints a valid ServiceAccount cleanly', () => {
    expectRules(VALID_SERVICE_ACCOUNT, []);
  });

  describe('secret references', () => {
    it('reports a namespace, which the apiserver discards', () => {
      const finding = expectRule(
        serviceAccountSecrets('  - name: build-token\n    namespace: shared\n'),
        'serviceaccount/ignored-secret-field',
      );
      expect(finding.path).toEqual(['secrets', 0, 'namespace']);
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('its own namespace');
    });

    it('reports every other ObjectReference field the same way', () => {
      const finding = expectRule(
        serviceAccountSecrets('  - name: build-token\n    kind: Secret\n    uid: abc-123\n'),
        'serviceaccount/ignored-secret-field',
      );
      // Both fields are dropped, so both are reported rather than only the first.
      expect(
        findings(serviceAccountSecrets('  - name: build-token\n    kind: Secret\n    uid: abc-123\n'))
          .filter((entry) => entry.ruleId === 'serviceaccount/ignored-secret-field')
          .map((entry) => entry.path),
      ).toEqual([
        ['secrets', 0, 'kind'],
        ['secrets', 0, 'uid'],
      ]);
      expect(finding.fix?.safe).toBe(true);
    });

    it('says nothing about a bare name', () => {
      expectRules(serviceAccountSecrets('  - name: build-token\n'), []);
    });

    it('reports an entry naming no Secret', () => {
      const finding = expectRule(
        serviceAccountSecrets('  - namespace: shared\n'),
        'serviceaccount/missing-secret-name',
      );
      expect(finding.path).toEqual(['secrets', 0]);
    });

    it('reports an empty name on the name itself', () => {
      const finding = expectRule(
        serviceAccountSecrets('  - name: ""\n'),
        'serviceaccount/missing-secret-name',
      );
      expect(finding.path).toEqual(['secrets', 0, 'name']);
    });

    it('reports a name no Secret could have', () => {
      const finding = expectRule(
        serviceAccountSecrets('  - name: Build_Token\n'),
        'serviceaccount/invalid-secret-name',
      );
      expect(finding.path).toEqual(['secrets', 0, 'name']);
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['secrets', 0, 'name'], value: 'build-token' },
      ]);
    });

    it('leaves duplicate secrets to the schema layer, which owns that list', () => {
      // `secrets` is an x-kubernetes-list-type: map keyed by name from 1.30 on,
      // so layer 1 reports the duplicate and this module deliberately does not.
      const ids = ruleIds(serviceAccountSecrets('  - name: build-token\n  - name: build-token\n'));
      expect(ids).toContain('schema/duplicate-list-entry');
      expect(ids).not.toContain('serviceaccount/duplicate-image-pull-secret');
    });
  });

  describe('imagePullSecrets', () => {
    it('reports the same Secret listed twice', () => {
      const finding = expectRule(
        serviceAccount('imagePullSecrets:\n  - name: registry\n  - name: registry\n'),
        'serviceaccount/duplicate-image-pull-secret',
      );
      expect(finding.path).toEqual(['imagePullSecrets', 1, 'name']);
      expect(finding.message).toContain('entry 1');
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['imagePullSecrets', 1] }]);
    });

    it('says nothing about two different pull secrets', () => {
      expectRules(serviceAccount('imagePullSecrets:\n  - name: registry\n  - name: mirror\n'), []);
    });

    it('checks the name the same way it checks a secrets entry', () => {
      const finding = expectRule(
        serviceAccount('imagePullSecrets:\n  - name: Registry_Creds\n'),
        'serviceaccount/invalid-secret-name',
      );
      expect(finding.path).toEqual(['imagePullSecrets', 0, 'name']);
    });

    it('reports an entry naming nothing', () => {
      expectRule(serviceAccount('imagePullSecrets:\n  - {}\n'), 'serviceaccount/missing-secret-name');
    });
  });

  describe('enforce-mountable-secrets annotation', () => {
    it('says nothing about a value ParseBool accepts', () => {
      for (const value of ['"true"', '"false"', '"T"', '"1"', '"FALSE"']) {
        expectNoRule(serviceAccountEnforcing(value), 'serviceaccount/invalid-enforce-mountable-secrets');
      }
    });

    it('reports a value that reads as off rather than as the true it meant', () => {
      const finding = expectRule(
        serviceAccountEnforcing('"yes"'),
        'serviceaccount/invalid-enforce-mountable-secrets',
      );
      expect(finding.path).toEqual([
        'metadata',
        'annotations',
        'kubernetes.io/enforce-mountable-secrets',
      ]);
      expect(finding.severity).toBe('warning');
      // "yes" is a guess at intent, so no fix is offered for it.
      expect(finding.fix).toBeUndefined();
    });

    it('offers a safe fix for a spelling that differs only in case', () => {
      // "True" is one of the twelve ParseBool accepts; "TRue" is not, and
      // differs from a spelling that is by case alone.
      const finding = expectRule(
        serviceAccountEnforcing('"TRue"'),
        'serviceaccount/invalid-enforce-mountable-secrets',
      );
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['metadata', 'annotations', 'kubernetes.io/enforce-mountable-secrets'],
          value: 'true',
        },
      ]);
    });

    it('leaves a non-string value to the schema layer', () => {
      const ids = ruleIds(serviceAccountEnforcing('true'));
      expect(ids).toContain('schema/type');
      expect(ids).not.toContain('serviceaccount/invalid-enforce-mountable-secrets');
    });

    it('reports the annotation as deprecated on the default version', () => {
      // The default bundle is 1.36; the per-version split is pinned in
      // tests/versions.test.ts, which is where the 1.32 boundary belongs.
      const finding = expectRule(
        serviceAccountEnforcing('"true"'),
        'serviceaccount/deprecated-enforce-mountable-secrets',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('1.32');
    });

    it('says nothing when the annotation is absent', () => {
      expectNoRule(VALID_SERVICE_ACCOUNT, 'serviceaccount/deprecated-enforce-mountable-secrets');
    });
  });

  describe('metadata', () => {
    it('rejects a name that is not a DNS subdomain', () => {
      expectRule(serviceAccount('', '  name: Build_Runner\n'), 'meta/invalid-name');
    });

    it('accepts a namespace, since a ServiceAccount is namespaced', () => {
      expectRules(serviceAccount('', '  name: build-runner\n  namespace: ci\n'), []);
    });
  });
});

describe('Role rules', () => {
  it('lints a valid Role cleanly', () => {
    expectRules(VALID_ROLE, []);
  });

  describe('the name, which RBAC validates as a path segment', () => {
    it('accepts what no other kind here would', () => {
      // ValidateRBACName is path.IsValidPathSegmentName and nothing else, so
      // the colons and capitals the built-in roles use are all legal.
      for (const name of ['system:controller:token-cleaner', 'MyRole', 'read_only', 'a.b.c']) {
        expectRules(role('rules: []\n', `  name: ${name}\n`), ['role/no-rules']);
      }
    });

    it('reports the four spellings a path segment cannot have', () => {
      for (const [name, reason] of [
        ['.', 'must not be "."'],
        ['..', 'must not be ".."'],
        ['my/role', 'must not contain "/"'],
        ['my%role', 'must not contain "%"'],
      ] as const) {
        const finding = expectRule(role('rules: []\n', `  name: "${name}"\n`), 'meta/invalid-name');
        expect(finding.message).toContain(reason);
      }
    });

    it('accepts a namespace, since a Role is namespaced', () => {
      expectRules(VALID_ROLE, []);
      expectNoRule(VALID_ROLE, 'meta/namespace-not-allowed');
    });
  });

  describe('rules', () => {
    it('reports a Role that grants nothing', () => {
      const finding = expectRule(role('rules: []\n'), 'role/no-rules');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['rules']);
    });

    it('reports an absent rules list the same way, anchored on the document', () => {
      const finding = expectRule(role(''), 'role/no-rules');
      expect(finding.path).toEqual([]);
    });

    it('leaves a rules list of the wrong type to the schema layer', () => {
      const ids = ruleIds(role('rules: nothing\n'));
      expect(ids).toContain('schema/type');
      expect(ids).not.toContain('role/no-rules');
    });

    it('reads a key written with no value as the empty list the apiserver reads', () => {
      const finding = expectRule(role('rules:\n'), 'role/no-rules');
      expect(finding.path).toEqual(['rules']);
    });
  });

  describe('the fields a policy rule must supply', () => {
    it('leaves an absent verbs to the schema layer, which has it as required', () => {
      const ids = ruleIds(policyRule('    apiGroups: [""]\n    resources: ["pods"]\n'));
      expect(ids).toContain('schema/required-field');
      expect(ids).not.toContain('role/missing-verbs');
    });

    it('reports an empty verbs, which the schema cannot express', () => {
      const finding = expectRule(roleVerbs('[]'), 'role/missing-verbs');
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['rules', 0, 'verbs']);
    });

    it('reports an absent apiGroups on the rule itself', () => {
      const finding = expectRule(
        policyRule('    resources: ["pods"]\n    verbs: ["get"]\n'),
        'role/missing-api-groups',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['rules', 0]);
      expect(finding.anchor).toBe('key');
    });

    it('reports a valueless apiGroups key on the key itself', () => {
      const finding = expectRule(
        policyRule('    apiGroups:\n    resources: ["pods"]\n    verbs: ["get"]\n'),
        'role/missing-api-groups',
      );
      expect(finding.path).toEqual(['rules', 0, 'apiGroups']);
    });

    it('reports an empty apiGroups on the field', () => {
      const finding = expectRule(
        policyRule('    apiGroups: []\n    resources: ["pods"]\n    verbs: ["get"]\n'),
        'role/missing-api-groups',
      );
      expect(finding.path).toEqual(['rules', 0, 'apiGroups']);
    });

    it('accepts "" as the core group rather than reading it as empty', () => {
      expectRules(policyRule('    apiGroups: [""]\n    resources: ["pods"]\n    verbs: ["get"]\n'), []);
    });

    it('reports a missing resources', () => {
      const finding = expectRule(
        policyRule('    apiGroups: [""]\n    verbs: ["get"]\n'),
        'role/missing-resources',
      );
      expect(finding.severity).toBe('error');
    });
  });

  describe('nonResourceURLs', () => {
    it('reports any use of them, since a Role is namespaced', () => {
      const finding = expectRule(
        policyRule('    nonResourceURLs: ["/healthz"]\n    verbs: ["get"]\n'),
        'role/non-resource-urls',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['rules', 0, 'nonResourceURLs']);
      // Deleting the URLs and moving the rule to a ClusterRole are both
      // plausible readings, so the fix is offered but never applied for you.
      expect(finding.fix?.safe).toBe(false);
    });

    it('does not go on to ask a URL rule for an api group', () => {
      // validatePolicyRule returns after the non-resource branch, so upstream
      // asks for neither apiGroups nor resources here and neither do we.
      const ids = ruleIds(policyRule('    nonResourceURLs: ["/healthz"]\n    verbs: ["get"]\n'));
      expect(ids).not.toContain('role/missing-api-groups');
      expect(ids).not.toContain('role/missing-resources');
    });
  });

  describe('list hygiene', () => {
    it('reports an entry repeated in a list', () => {
      const finding = expectRule(roleVerbs('["get", "list", "get"]'), 'role/duplicate-entry');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 2]);
      expect(finding.message).toContain('entry 1');
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([{ op: 'delete', path: ['rules', 0, 'verbs', 2] }]);
    });

    it('reports an entry a "*" beside it already covers', () => {
      const finding = expectRule(roleVerbs('["*", "get"]'), 'role/redundant-wildcard');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 1]);
      // Provably inert: the "*" grants at least as much as the entry does.
      expect(finding.fix?.safe).toBe(true);
    });

    it('says nothing about a "*" on its own', () => {
      expectRules(roleVerbs('["*"]'), []);
    });

    it('reads "*" in resourceNames as a name rather than a wildcard', () => {
      const yaml = policyRule(
        '    apiGroups: [""]\n    resources: ["pods"]\n    resourceNames: ["*", "web"]\n    verbs: ["get"]\n',
      );
      const finding = expectRule(yaml, 'role/wildcard-resource-name');
      expect(finding.path).toEqual(['rules', 0, 'resourceNames', 0]);
      // Removing it widens the rule from nothing to everything, which is not
      // something to do unasked.
      expect(finding.fix?.safe).toBe(false);
      // And "web" beside it is not redundant, since nothing here is a wildcard.
      expect(ruleIds(yaml)).not.toContain('role/redundant-wildcard');
    });

    it('reports an empty string where one matches nothing', () => {
      const finding = expectRule(roleVerbs('["get", ""]'), 'role/empty-entry');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 1]);
      expect(finding.fix?.safe).toBe(true);
    });

    it('says nothing about an empty apiGroups entry, which is the core group', () => {
      expectNoRule(
        policyRule('    apiGroups: ["", "apps"]\n    resources: ["pods"]\n    verbs: ["get"]\n'),
        'role/empty-entry',
      );
    });
  });

  describe('verbs', () => {
    it('reports a near-miss of a real verb', () => {
      const finding = expectRule(roleVerbs('["gets"]'), 'role/unknown-verb');
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('did you mean "get"');
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['rules', 0, 'verbs', 0], value: 'get' },
      ]);
    });

    it('reports a verb spelled with the wrong case, which never matches', () => {
      expect(expectRule(roleVerbs('["List"]'), 'role/unknown-verb').message).toContain('"list"');
    });

    it('says nothing about a verb that belongs to one resource', () => {
      for (const verb of ['bind', 'escalate', 'impersonate', 'approve', 'use']) {
        expectNoRule(roleVerbs(`["${verb}"]`), 'role/unknown-verb');
      }
    });

    it('says nothing about a verb far enough from every known one to be deliberate', () => {
      // An aggregated apiserver may define verbs of its own, so only a
      // near-miss is worth a word.
      expectNoRule(roleVerbs('["teleport"]'), 'role/unknown-verb');
    });
  });

  describe('resources', () => {
    it('reports a resource written as a Kind', () => {
      const finding = expectRule(
        policyRule('    apiGroups: [""]\n    resources: ["Pod"]\n    verbs: ["get"]\n'),
        'role/uppercase-resource',
      );
      expect(finding.severity).toBe('warning');
      // Lowercasing is necessary but not sufficient — "pod" is still not "pods".
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['rules', 0, 'resources', 0], value: 'pod' },
      ]);
    });

    it('accepts a subresource and a wildcard', () => {
      expectRules(
        policyRule('    apiGroups: [""]\n    resources: ["pods/log", "*"]\n    verbs: ["get"]\n'),
        ['role/redundant-wildcard'],
      );
    });
  });

  describe('resourceNames against the verbs they narrow', () => {
    const named = (verbs: string) =>
      policyRule(
        `    apiGroups: [""]\n    resources: ["pods"]\n    resourceNames: ["web"]\n    verbs: ${verbs}\n`,
      );

    it('reports a create, whose name lives in the body the authorizer never reads', () => {
      const finding = expectRule(named('["create"]'), 'role/unrestrictable-verb');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 0]);
      expect(finding.explanation).toContain('inside the body');
    });

    it('reports a deletecollection, which addresses no member of the collection', () => {
      const finding = expectRule(named('["get", "deletecollection"]'), 'role/unrestrictable-verb');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 1]);
    });

    it('says nothing about the verbs a name can narrow', () => {
      expectRules(named('["get", "update", "patch", "delete"]'), []);
    });

    it('leaves a "*" alone', () => {
      // A "*" grants the eight ordinary verbs at once, and that the two
      // unnameable ones fall out of a name-restricted rule reads as intended
      // rather than as a mistake.
      expectRules(named('["*"]'), []);
    });

    it('says nothing about a create with no resourceNames to narrow it', () => {
      expectRules(roleVerbs('["create"]'), []);
    });
  });
});

describe('ClusterRole rules', () => {
  it('lints a valid ClusterRole cleanly', () => {
    expectRules(VALID_CLUSTER_ROLE, []);
  });

  it('rejects a namespace, since a ClusterRole is cluster-scoped', () => {
    expectRule(
      clusterRole('rules: []\n', '  name: node-reader\n  namespace: default\n'),
      'meta/namespace-not-allowed',
    );
  });

  it('validates the name as a path segment, exactly as a Role is', () => {
    expectRules(clusterRole('rules: []\n', '  name: system:node-reader\n'), ['role/no-rules']);
  });

  describe('the policy rule checks it shares with a Role', () => {
    it('reports the same things under the same ids', () => {
      // validatePolicyRule is one function taking an isNamespaced flag, so
      // everything but the non-resource branch is the Role module's, run
      // unchanged and keeping its role/* ids.
      const ids = ruleIds(
        clusterPolicyRule('    apiGroups: [""]\n    resources: ["Nodes"]\n    verbs: ["gets"]\n'),
      );
      expect(ids).toEqual(['role/uppercase-resource', 'role/unknown-verb']);
    });

    it('names the kind it was reached through in the empty-rules message', () => {
      const finding = expectRule(clusterRole('rules: []\n'), 'role/no-rules');
      expect(finding.message).toContain('This ClusterRole');
    });

    it('still leaves an absent verbs to the schema layer', () => {
      const ids = ruleIds(clusterPolicyRule('    apiGroups: [""]\n    resources: ["nodes"]\n'));
      expect(ids).toContain('schema/required-field');
      expect(ids).not.toContain('role/missing-verbs');
    });
  });

  describe('nonResourceURLs, which only a ClusterRole may carry', () => {
    it('accepts a rule that names nothing but URLs', () => {
      expectRules(urlRule('["/healthz", "/version/*"]'), []);
    });

    it('reports a rule naming resources beside them', () => {
      const finding = expectRule(
        clusterPolicyRule(
          '    nonResourceURLs: ["/healthz"]\n    apiGroups: [""]\n    resources: ["nodes"]\n    verbs: ["get"]\n',
        ),
        'clusterrole/mixed-rule',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['rules', 0, 'nonResourceURLs']);
      expect(finding.message).toContain('apiGroups and resources');
    });

    it('counts resourceNames as the resource half too', () => {
      const finding = expectRule(
        clusterPolicyRule(
          '    nonResourceURLs: ["/healthz"]\n    resourceNames: ["web"]\n    verbs: ["get"]\n',
        ),
        'clusterrole/mixed-rule',
      );
      expect(finding.message).toContain('resourceNames');
    });

    it('says nothing more about a rule it has already rejected', () => {
      // Upstream returns at that error, so the advice below it has nothing to
      // say about an object that will not be stored.
      const ids = ruleIds(
        clusterPolicyRule(
          '    nonResourceURLs: ["healthz"]\n    apiGroups: [""]\n    resources: ["nodes"]\n    verbs: ["list"]\n',
        ),
      );
      expect(ids).toEqual(['clusterrole/mixed-rule']);
    });

    it('does not go on to ask a URL rule for an api group', () => {
      const ids = ruleIds(urlRule('["/healthz"]'));
      expect(ids).not.toContain('role/missing-api-groups');
      expect(ids).not.toContain('role/missing-resources');
    });

    it('reports a URL that is not an absolute path', () => {
      const finding = expectRule(urlRule('["healthz"]'), 'clusterrole/relative-non-resource-url');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['rules', 0, 'nonResourceURLs', 0]);
      // Every path this could have meant starts with a slash.
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['rules', 0, 'nonResourceURLs', 0], value: '/healthz' },
      ]);
    });

    it('reports a "*" that is not the last character', () => {
      const finding = expectRule(
        urlRule('["/apis/*/healthz"]'),
        'clusterrole/embedded-wildcard-url',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.fix).toBeUndefined();
    });

    it('says nothing about a trailing "*" or a bare one', () => {
      expectRules(urlRule('["/healthz*"]'), []);
      expectRules(urlRule('["*"]'), []);
    });

    it('applies the shared list hygiene to the URLs as well', () => {
      expectRules(urlRule('["/healthz", "/healthz"]'), ['role/duplicate-entry']);
      expectRules(urlRule('["*", "/healthz"]'), ['role/redundant-wildcard']);
    });

    it('reports a verb a non-resource request never carries', () => {
      const finding = expectRule(
        urlRule('["/healthz"]', '["get", "list"]'),
        'clusterrole/non-resource-verb',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['rules', 0, 'verbs', 1]);
      // Which HTTP method was wanted is the author's to say.
      expect(finding.fix?.safe).toBe(false);
    });

    it('accepts the HTTP methods a non-resource request is authorized as', () => {
      expectRules(urlRule('["/healthz"]', '["get", "post", "put", "patch", "delete", "head", "options"]'), []);
      expectRules(urlRule('["/healthz"]', '["*"]'), []);
    });
  });

  describe('aggregationRule', () => {
    const bySelector = '    - matchLabels:\n        rbac.example.com/aggregate-to-view: "true"\n';

    it('accepts an aggregated ClusterRole written without rules', () => {
      expectRules(aggregatedClusterRole(bySelector), []);
    });

    it('says nothing about its empty rules, which the controller fills in', () => {
      // The inverse of the plain case: a ClusterRole that grants nothing today
      // is exactly how an aggregated one is meant to be written.
      expectNoRule(aggregatedClusterRole(bySelector), 'role/no-rules');
      expectNoRule(aggregatedClusterRole(bySelector, 'rules: []\n'), 'role/no-rules');
    });

    it('reports rules written beside it, which the controller overwrites', () => {
      const finding = expectRule(
        aggregatedClusterRole(
          bySelector,
          'rules:\n  - apiGroups: [""]\n    resources: ["nodes"]\n    verbs: ["get"]\n',
        ),
        'clusterrole/aggregated-rules',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['rules']);
      // A permission grant disappearing is never applied unasked.
      expect(finding.fix?.safe).toBe(false);
    });

    it('still checks the rules it is about to lose', () => {
      const ids = ruleIds(
        aggregatedClusterRole(
          bySelector,
          'rules:\n  - apiGroups: [""]\n    resources: ["Nodes"]\n    verbs: ["get"]\n',
        ),
      );
      expect(ids).toContain('role/uppercase-resource');
    });

    it('reports an aggregationRule that selects nothing', () => {
      const finding = expectRule(
        clusterRole('aggregationRule: {}\n'),
        'clusterrole/no-aggregation-selectors',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['aggregationRule']);
    });

    it('anchors that on the selectors key when there is one', () => {
      const finding = expectRule(
        clusterRole('aggregationRule:\n  clusterRoleSelectors: []\n'),
        'clusterrole/no-aggregation-selectors',
      );
      expect(finding.path).toEqual(['aggregationRule', 'clusterRoleSelectors']);
    });

    it('reports an empty selector, which matches every ClusterRole rather than none', () => {
      const finding = expectRule(
        aggregatedClusterRole('    - {}\n'),
        'clusterrole/empty-aggregation-selector',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['aggregationRule', 'clusterRoleSelectors', 0]);
    });

    it('checks a selector the way every other LabelSelector here is checked', () => {
      const finding = expectRule(
        aggregatedClusterRole(
          '    - matchExpressions:\n        - key: tier\n          operator: In\n',
        ),
        'clusterrole/selector-values-required',
      );
      expect(finding.path).toEqual([
        'aggregationRule',
        'clusterRoleSelectors',
        0,
        'matchExpressions',
        0,
      ]);
    });

    it('checks a selector label key as a label key', () => {
      expectRule(
        aggregatedClusterRole('    - matchLabels:\n        Not A Key: "true"\n'),
        'meta/invalid-label-key',
      );
    });

    it('leaves an aggregationRule of the wrong type to the schema layer', () => {
      const ids = ruleIds(clusterRole('aggregationRule: everything\n'));
      expect(ids).toContain('schema/type');
      expect(ids).not.toContain('clusterrole/no-aggregation-selectors');
    });
  });
});

describe('RoleBinding rules', () => {
  it('lints a valid RoleBinding cleanly', () => {
    expectRules(VALID_ROLE_BINDING, []);
  });

  it('validates the name as a path segment, exactly as a Role is', () => {
    expectRules(
      `apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: system:read-pods\n  namespace: default\nroleRef:\n  kind: Role\n  name: pod-reader\nsubjects:\n  - kind: User\n    name: alice\n`,
      [],
    );
  });

  describe('roleRef', () => {
    it('accepts an absent apiGroup, which the apiserver defaults', () => {
      // SetDefaults_RoleBinding fills a zero-length api group in with the RBAC
      // group before validation runs, so the field is optional in practice
      // even though only one value is ever accepted.
      expectRules(roleBinding('subjects:\n  - kind: User\n    name: alice\n', '  kind: Role\n  name: pod-reader\n'), []);
    });

    it('accepts an apiGroup written as the empty string, for the same reason', () => {
      expectRules(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: ""\n  kind: Role\n  name: pod-reader\n',
        ),
        [],
      );
    });

    it('reports an apiGroup that is not RBAC\'s own', () => {
      const finding = expectRule(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io/v1\n  kind: Role\n  name: pod-reader\n',
        ),
        'rolebinding/invalid-role-ref-api-group',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['roleRef', 'apiGroup']);
      expect(finding.fix?.safe).toBe(true);
    });

    it('reports an unknown kind through the enum table', () => {
      const finding = expectRule(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRoleBinding\n  name: pod-reader\n',
        ),
        'enum/invalid-value',
      );
      expect(finding.path).toEqual(['roleRef', 'kind']);
    });

    it('reports an empty name where the schema layer reports a missing one', () => {
      const finding = expectRule(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: ""\n',
        ),
        'rolebinding/missing-role-ref-name',
      );
      expect(finding.severity).toBe('error');

      const ids = ruleIds(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n',
        ),
      );
      expect(ids).toContain('schema/required-field');
      expect(ids).not.toContain('rolebinding/missing-role-ref-name');
    });

    it('validates the referenced name as a path segment', () => {
      const finding = expectRule(
        roleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: apps/pod-reader\n',
        ),
        'rolebinding/invalid-role-ref-name',
      );
      expect(finding.path).toEqual(['roleRef', 'name']);
      expect(finding.message).toContain('must not contain "/"');
    });
  });

  describe('subjects', () => {
    it('reports a binding with no subjects at all', () => {
      const finding = expectRule(roleBinding(''), 'rolebinding/no-subjects');
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual([]);
    });

    it('anchors the same finding on an empty list', () => {
      const finding = expectRule(roleBinding('subjects: []\n'), 'rolebinding/no-subjects');
      expect(finding.path).toEqual(['subjects']);
    });

    it('reports an empty name where the schema layer reports a missing one', () => {
      const finding = expectRule(
        bindingSubject('    kind: User\n    name: ""\n'),
        'rolebinding/missing-subject-name',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['subjects', 0, 'name']);

      const ids = ruleIds(bindingSubject('    kind: User\n'));
      expect(ids).toContain('schema/required-field');
      expect(ids).not.toContain('rolebinding/missing-subject-name');
    });

    it('reports an unknown kind through the enum table and says nothing more', () => {
      const ids = ruleIds(bindingSubject('    kind: user\n    name: alice\n    namespace: default\n'));
      expect(ids).toEqual(['enum/invalid-value']);
    });

    it('rejects an apiGroup on a ServiceAccount subject, whatever it says', () => {
      const finding = expectRule(
        bindingSubject(
          '    kind: ServiceAccount\n    name: reader\n    apiGroup: rbac.authorization.k8s.io\n',
        ),
        'rolebinding/invalid-subject-api-group',
      );
      expect(finding.severity).toBe('error');
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.title).toBe('Remove apiGroup');
    });

    it('rejects an apiGroup on a Group subject that is not RBAC\'s own', () => {
      const finding = expectRule(
        bindingSubject('    kind: Group\n    name: devs\n    apiGroup: user.example.com\n'),
        'rolebinding/invalid-subject-api-group',
      );
      expect(finding.severity).toBe('error');
      expect(finding.fix?.title).toContain('rbac.authorization.k8s.io');
    });

    it('accepts an apiGroup written as the empty string on any kind', () => {
      // SetDefaults_Subject rewrites a zero-length api group from the kind, so
      // an explicit "" is as correct as leaving the field out — on a User and
      // a Group as much as on the ServiceAccount whose value it becomes.
      expectRules(
        bindingSubjects(
          '  - kind: ServiceAccount\n    name: reader\n    apiGroup: ""\n  - kind: User\n    name: alice\n    apiGroup: ""\n',
        ),
        [],
      );
    });

    it('accepts an absent apiGroup on every kind, since the default fills it in', () => {
      expectRules(
        bindingSubjects(
          '  - kind: ServiceAccount\n    name: reader\n  - kind: User\n    name: alice\n  - kind: Group\n    name: devs\n',
        ),
        [],
      );
    });

    it('validates a ServiceAccount subject name as a DNS subdomain', () => {
      const finding = expectRule(
        bindingSubject('    kind: ServiceAccount\n    name: Reader\n'),
        'rolebinding/invalid-subject-name',
      );
      expect(finding.severity).toBe('error');
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops[0]).toMatchObject({ value: 'reader' });
    });

    it('leaves a User or Group name unchecked, those coming from the authenticator', () => {
      expectRules(
        bindingSubjects('  - kind: User\n    name: Alice@example.com\n  - kind: Group\n    name: system:masters\n'),
        [],
      );
    });

    it('reports a namespace beside a User, which no comparison reads', () => {
      const finding = expectRule(
        bindingSubject('    kind: User\n    name: alice\n    namespace: default\n'),
        'rolebinding/ignored-subject-namespace',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['subjects', 0, 'namespace']);
      // Which half is the mistake is a real question: a namespace beside a
      // name often means a ServiceAccount was meant instead.
      expect(finding.fix?.safe).toBe(false);
    });

    it('says nothing about a ServiceAccount subject without one', () => {
      // For a RoleBinding the authorizer defaults it to the binding's own
      // namespace, which is how such a subject is normally written.
      expectNoRule(
        bindingSubject('    kind: ServiceAccount\n    name: reader\n'),
        'rolebinding/ignored-subject-namespace',
      );
    });

    it('reports the same subject listed twice', () => {
      const finding = expectRule(
        bindingSubjects('  - kind: User\n    name: alice\n  - kind: User\n    name: alice\n'),
        'rolebinding/duplicate-subject',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['subjects', 1]);
      expect(finding.message).toContain('entry 1');
      expect(finding.fix?.safe).toBe(true);
    });

    it('does not confuse two kinds sharing a name', () => {
      expectNoRule(
        bindingSubjects('  - kind: User\n    name: alice\n  - kind: Group\n    name: alice\n'),
        'rolebinding/duplicate-subject',
      );
    });

    it('sees through an ignored namespace, which is not part of the identity', () => {
      // No branch of appliesToUser reads a User's namespace, so two entries
      // differing only in one are the same subject to the authorizer.
      const finding = expectRule(
        bindingSubjects(
          '  - kind: User\n    name: alice\n    namespace: default\n  - kind: User\n    name: alice\n',
        ),
        'rolebinding/duplicate-subject',
      );
      expect(finding.path).toEqual(['subjects', 1]);
    });

    it('does not confuse two service accounts in different namespaces', () => {
      expectNoRule(
        bindingSubjects(
          '  - kind: ServiceAccount\n    name: reader\n    namespace: web\n  - kind: ServiceAccount\n    name: reader\n    namespace: api\n',
        ),
        'rolebinding/duplicate-subject',
      );
    });

    it('leaves a subjects of the wrong type to the schema layer', () => {
      const ids = ruleIds(roleBinding('subjects: everyone\n'));
      expect(ids).toContain('schema/type');
      expect(ids).not.toContain('rolebinding/no-subjects');
    });
  });
});

describe('ClusterRoleBinding rules', () => {
  it('lints a valid ClusterRoleBinding cleanly', () => {
    expectRules(VALID_CLUSTER_ROLE_BINDING, []);
  });

  it('validates the name as a path segment, exactly as a RoleBinding does', () => {
    expectRules(
      `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: system:node-reader\nroleRef:\n  kind: ClusterRole\n  name: node-reader\nsubjects:\n  - kind: User\n    name: alice\n`,
      [],
    );
  });

  it('forbids a metadata.namespace, the kind being cluster-scoped', () => {
    const finding = expectRule(
      `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: read-nodes\n  namespace: default\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: node-reader\nsubjects:\n  - kind: User\n    name: alice\n`,
      'meta/namespace-not-allowed',
    );
    expect(finding.severity).toBe('error');
    expect(finding.path).toEqual(['metadata', 'namespace']);
  });

  describe('roleRef', () => {
    it('reports a Role, which only a RoleBinding may name', () => {
      const finding = expectRule(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: node-reader\n',
        ),
        'clusterrolebinding/namespaced-role-ref',
      );
      expect(finding.severity).toBe('error');
      expect(finding.path).toEqual(['roleRef', 'kind']);
      // Pointing at a ClusterRole of the same name is a different object, and
      // the other correction is to the document's own kind.
      expect(finding.fix?.safe).toBe(false);
    });

    it('leaves a Role alone on a RoleBinding, where it is the ordinary case', () => {
      expectNoRule(VALID_ROLE_BINDING, 'clusterrolebinding/namespaced-role-ref');
    });

    it('adds nothing to a kind the enum table has already rejected', () => {
      const ids = ruleIds(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRoleBinding\n  name: node-reader\n',
        ),
      );
      expect(ids).toContain('enum/invalid-value');
      expect(ids).not.toContain('clusterrolebinding/namespaced-role-ref');
    });

    it('accepts an absent apiGroup, which the apiserver defaults', () => {
      // SetDefaults_ClusterRoleBinding is SetDefaults_RoleBinding's twin.
      expectRules(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  kind: ClusterRole\n  name: node-reader\n',
        ),
        [],
      );
    });

    it('reports an apiGroup that is not RBAC\'s own, under the shared id', () => {
      const finding = expectRule(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io/v1\n  kind: ClusterRole\n  name: node-reader\n',
        ),
        'rolebinding/invalid-role-ref-api-group',
      );
      expect(finding.severity).toBe('error');
      expect(finding.fix?.safe).toBe(true);
    });

    it('reports an empty roleRef name under the shared id', () => {
      const finding = expectRule(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: ""\n',
        ),
        'rolebinding/missing-role-ref-name',
      );
      expect(finding.severity).toBe('error');
    });

    it('reports a roleRef name that is not a path segment, under the shared id', () => {
      const finding = expectRule(
        clusterRoleBinding(
          'subjects:\n  - kind: User\n    name: alice\n',
          '  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: node/reader\n',
        ),
        'rolebinding/invalid-role-ref-name',
      );
      expect(finding.path).toEqual(['roleRef', 'name']);
    });
  });

  describe('subjects', () => {
    it('requires a namespace on a ServiceAccount subject', () => {
      // ValidateRoleBindingSubject is handed isNamespaced=false here, and this
      // is the single branch that reads it.
      const finding = expectRule(
        clusterBindingSubject('    kind: ServiceAccount\n    name: reader\n'),
        'clusterrolebinding/missing-subject-namespace',
      );
      expect(finding.severity).toBe('error');
      // With no key to anchor on the finding lands on the subject itself.
      expect(finding.path).toEqual(['subjects', 0]);
      // Which namespace was meant cannot be read off the document.
      expect(finding.fix).toBeUndefined();
    });

    it('treats a namespace written as the empty string as missing', () => {
      const finding = expectRule(
        clusterBindingSubject('    kind: ServiceAccount\n    name: reader\n    namespace: ""\n'),
        'clusterrolebinding/missing-subject-namespace',
      );
      expect(finding.path).toEqual(['subjects', 0, 'namespace']);
    });

    it('accepts a ServiceAccount subject that names one', () => {
      expectRules(
        clusterBindingSubject(
          '    kind: ServiceAccount\n    name: reader\n    namespace: default\n',
        ),
        [],
      );
    });

    it('asks for no namespace on a User or a Group, neither of which lives in one', () => {
      expectNoRule(
        clusterBindingSubjects('  - kind: User\n    name: alice\n  - kind: Group\n    name: devs\n'),
        'clusterrolebinding/missing-subject-namespace',
      );
    });

    it('says nothing about it on a RoleBinding, which lends its own namespace', () => {
      expectNoRule(
        bindingSubject('    kind: ServiceAccount\n    name: reader\n'),
        'clusterrolebinding/missing-subject-namespace',
      );
    });

    it('still reports a namespace beside a User, under the shared id', () => {
      const finding = expectRule(
        clusterBindingSubject('    kind: User\n    name: alice\n    namespace: default\n'),
        'rolebinding/ignored-subject-namespace',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.path).toEqual(['subjects', 0, 'namespace']);
    });

    it('still reports a ServiceAccount subject carrying an apiGroup', () => {
      const finding = expectRule(
        clusterBindingSubject(
          '    kind: ServiceAccount\n    name: reader\n    namespace: default\n    apiGroup: rbac.authorization.k8s.io\n',
        ),
        'rolebinding/invalid-subject-api-group',
      );
      expect(finding.fix?.safe).toBe(true);
    });

    it('still reports a ServiceAccount name that is not a DNS subdomain', () => {
      const finding = expectRule(
        clusterBindingSubject(
          '    kind: ServiceAccount\n    name: Reader\n    namespace: default\n',
        ),
        'rolebinding/invalid-subject-name',
      );
      expect(finding.severity).toBe('error');
    });

    it('still reports the same subject listed twice', () => {
      const finding = expectRule(
        clusterBindingSubjects(
          '  - kind: User\n    name: alice\n  - kind: User\n    name: alice\n',
        ),
        'rolebinding/duplicate-subject',
      );
      expect(finding.path).toEqual(['subjects', 1]);
    });

    it('names the kind it is checking when there are no subjects', () => {
      const finding = expectRule(clusterRoleBinding(''), 'rolebinding/no-subjects');
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('ClusterRoleBinding');
    });
  });
});

describe('gateway', () => {
  it('accepts a valid Gateway', () => {
    expectRules(VALID_GATEWAY, []);
  });

  describe('addresses', () => {
    it('rejects a hostname written as an IPAddress, which is the default type', () => {
      const finding = expectRule(
        gateway('  addresses:\n    - value: gateway.example.com\n' + '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n'),
        'gateway/invalid-address-value',
      );
      expect(finding.path).toEqual(['spec', 'addresses', 0, 'value']);
    });

    it('rejects an invalid hostname', () => {
      expectRule(
        gateway(
          '  addresses:\n    - type: Hostname\n      value: Gateway.Example.Com\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        'gateway/invalid-address-value',
      );
    });

    it('accepts a wildcard hostname and a literal address', () => {
      expectRules(
        gateway(
          '  addresses:\n    - type: Hostname\n      value: "*.example.com"\n' +
            '    - value: 10.0.0.1\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        [],
      );
    });

    it('rejects the same address asked for twice', () => {
      const finding = expectRule(
        gateway(
          '  addresses:\n    - value: 10.0.0.1\n    - value: 10.0.0.1\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        'gateway/duplicate-address',
      );
      expect(finding.path).toEqual(['spec', 'addresses', 1, 'value']);
    });

    it('does not flag the same value under two different types', () => {
      expectRules(
        gateway(
          '  addresses:\n    - type: NamedAddress\n      value: shared\n' +
            '    - type: Hostname\n      value: shared\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        [],
      );
    });
  });

  describe('infrastructure', () => {
    it('reports an invalid label key', () => {
      const finding = expectRule(
        gateway(
          '  infrastructure:\n    labels:\n      "not a key": web\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        'meta/invalid-label-key',
      );
      expect(finding.path).toEqual(['spec', 'infrastructure', 'labels', 'not a key']);
    });

    it('accepts a prefixed annotation key', () => {
      expectRules(
        gateway(
          '  infrastructure:\n    annotations:\n      example.com/owner: platform\n' +
            '  listeners:\n    - name: http\n      protocol: HTTP\n      port: 80\n',
        ),
        [],
      );
    });
  });

  describe('listeners', () => {
    it('rejects tls on a plaintext listener', () => {
      const finding = expectRule(
        gatewayWithListener(
          '    - name: http\n      protocol: HTTP\n      port: 80\n' +
            '      tls:\n        certificateRefs:\n          - name: web-cert\n',
        ),
        'gateway/tls-not-allowed',
      );
      expect(finding.path).toEqual(['spec', 'listeners', 0, 'tls']);
      expect(finding.fix?.title).toBe('Remove tls');
    });

    it('rejects a passthrough HTTPS listener', () => {
      const finding = expectRule(
        gatewayWithListener(
          '    - name: https\n      protocol: HTTPS\n      port: 443\n' +
            '      tls:\n        mode: Passthrough\n',
        ),
        'gateway/tls-mode',
      );
      expect(finding.path).toEqual(['spec', 'listeners', 0, 'tls', 'mode']);
    });

    it('accepts a passthrough TLS listener', () => {
      expectRules(
        gatewayWithListener(
          '    - name: tls\n      protocol: TLS\n      port: 443\n' +
            '      tls:\n        mode: Passthrough\n',
        ),
        [],
      );
    });

    it('requires a certificate when the mode defaults to Terminate', () => {
      const finding = expectRule(
        gatewayWithListener(
          '    - name: https\n      protocol: HTTPS\n      port: 443\n      tls:\n        options: {}\n',
        ),
        'gateway/tls-needs-certificate',
      );
      expect(finding.message).toContain('certificateRefs');
    });

    it('accepts a terminating listener naming a certificate', () => {
      expectRules(
        gatewayWithListener(
          '    - name: https\n      protocol: HTTPS\n      port: 443\n' +
            '      tls:\n        mode: Terminate\n' +
            '        certificateRefs:\n          - name: web-cert\n',
        ),
        [],
      );
    });

    it('rejects a hostname on a TCP listener', () => {
      const finding = expectRule(
        gatewayWithListener(
          '    - name: db\n      protocol: TCP\n      port: 5432\n      hostname: db.example.com\n',
        ),
        'gateway/hostname-not-allowed',
      );
      expect(finding.path).toEqual(['spec', 'listeners', 0, 'hostname']);
    });

    it('rejects two listeners sharing a port, protocol and hostname', () => {
      const finding = expectRule(
        gatewayWithListener(
          '    - name: web-a\n      protocol: HTTP\n      port: 80\n      hostname: web.example.com\n' +
            '    - name: web-b\n      protocol: HTTP\n      port: 80\n      hostname: web.example.com\n',
        ),
        'gateway/duplicate-listener',
      );
      expect(finding.path).toEqual(['spec', 'listeners', 1]);
    });

    it('accepts two listeners on one port distinguished by hostname', () => {
      expectRules(
        gatewayWithListener(
          '    - name: web-a\n      protocol: HTTP\n      port: 80\n      hostname: a.example.com\n' +
            '    - name: web-b\n      protocol: HTTP\n      port: 80\n      hostname: b.example.com\n',
        ),
        [],
      );
    });

    it('leaves two listeners sharing a name to the schema layer', () => {
      expectRules(
        gatewayWithListener(
          '    - name: http\n      protocol: HTTP\n      port: 80\n' +
            '    - name: http\n      protocol: HTTP\n      port: 8080\n',
        ),
        ['schema/duplicate-list-entry'],
      );
    });
  });
});
