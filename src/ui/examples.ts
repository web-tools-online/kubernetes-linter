export interface Example {
  id: string;
  label: string;
  blurb: string;
  yaml: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'broken',
    label: 'A Pod with problems',
    blurb: 'A misspelled field, a bad enum, an impossible port and a mount that points nowhere.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: Broken-Pod
  labels:
    app: web
spec:
  # "containers" is misspelled, so everything below it is invisible to the API.
  contaienrs:
    - name: web
      image: nginx:1.27-alpine
      imagePullPolicy: always
      ports:
        - containerPort: 70000
          name: http
      resources:
        requests:
          cpu: "500m"
          memory: 512m
        limits:
          cpu: "200m"
      livenessProbe:
        httpGet:
          port: htpp
        successThreshold: 3
      volumeMounts:
        - name: data-volme
          mountPath: /data
  volumes:
    - name: data-volume
      emptyDir: {}
  restartPolicy: always
`,
  },
  {
    id: 'valid',
    label: 'A valid Pod',
    blurb: 'Nothing to report — useful for checking that a clean manifest stays clean.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: web
  namespace: default
  labels:
    app.kubernetes.io/name: web
spec:
  restartPolicy: Always
  containers:
    - name: web
      image: nginx:1.27-alpine
      ports:
        - name: http
          containerPort: 8080
          protocol: TCP
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
      readinessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
      volumeMounts:
        - name: cache
          mountPath: /var/cache/nginx
  volumes:
    - name: cache
      emptyDir: {}
`,
  },
  {
    id: 'sidecar',
    label: 'Init containers and sidecars',
    blurb: 'Probes on a plain init container are rejected; a sidecar needs restartPolicy: Always.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: app-with-sidecar
spec:
  initContainers:
    # A log shipper meant to run for the lifetime of the Pod.
    - name: log-shipper
      image: fluent/fluent-bit:3.1
      readinessProbe:
        tcpSocket:
          port: 2020
    - name: migrate
      image: migrate/migrate:v4
      command: ["migrate", "up"]
  containers:
    - name: app
      image: app:1.4.2
      env:
        - name: DATABASE_URL
          value: postgres://db/app
          valueFrom:
            secretKeyRef:
              name: db
              key: url
`,
  },
  {
    id: 'conflicts',
    label: 'Contradictory settings',
    blurb: 'Settings that are individually valid but cannot be combined.',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: conflicted
spec:
  hostNetwork: true
  hostPID: true
  shareProcessNamespace: true
  serviceAccount: legacy
  serviceAccountName: modern
  dnsPolicy: None
  securityContext:
    runAsNonRoot: true
    runAsUser: 0
  tolerations:
    - key: dedicated
      operator: Exists
      value: batch
      effect: NoSchedule
      tolerationSeconds: 30
  containers:
    - name: app
      image: app:1.0.0
      ports:
        - containerPort: 8080
          hostPort: 9090
      securityContext:
        privileged: true
        allowPrivilegeEscalation: false
`,
  },
  {
    id: 'deployment',
    label: 'A Deployment with problems',
    blurb: 'A selector that does not match its template, a run-to-completion pod spec and an impossible rollout.',
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      # The template below labels its Pods "web", so this selects nothing.
      app: frontend
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 0
  minReadySeconds: 30
  progressDeadlineSeconds: 30
  template:
    metadata:
      labels:
        app: web
    spec:
      restartPolicy: OnFailure
      activeDeadlineSeconds: 600
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports:
            - containerPort: 8080
              name: http
`,
  },
  {
    id: 'statefulset',
    label: 'A StatefulSet with problems',
    blurb: 'A governing Service that is not a valid name, a mount that matches no claim template, and an update strategy that contradicts itself.',
    yaml: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  # A Service name is a DNS label, so it cannot carry a dot or a capital.
  serviceName: DB.headless
  replicas: 3
  podManagementPolicy: Ordered
  selector:
    matchLabels:
      app: db
  updateStrategy:
    type: OnDelete
    rollingUpdate:
      partition: -1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
              name: postgres
          volumeMounts:
            # The claim template below is called "data", not "date".
            - name: date
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10G1
`,
  },
  {
    id: 'daemonset',
    label: 'A DaemonSet with problems',
    blurb: 'A replica count that does not exist, a rollout that asks for both update modes at once, and a mount that points nowhere.',
    yaml: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  # A DaemonSet runs one Pod per matching node, so it has no replica count.
  replicas: 3
  selector:
    matchLabels:
      app: node-exporter
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      restartPolicy: OnFailure
      hostNetwork: true
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.2
          ports:
            - name: metrics
              containerPort: 9100
              hostPort: 9101
          volumeMounts:
            # The volume below is called "procfs", not "proc".
            - name: proc
              mountPath: /host/proc
              readOnly: true
      volumes:
        - name: procfs
          hostPath:
            path: /proc
`,
  },
  {
    id: 'service',
    label: 'A Service with problems',
    blurb: 'A name that is not a DNS label, a headless Service asking for a node port, and two ports that collide.',
    yaml: `apiVersion: v1
kind: Service
metadata:
  # A Service name is an RFC 1035 label, so it cannot start with a digit.
  name: 8080-proxy
spec:
  type: NodePort
  # NodePort builds on a cluster IP, so this Service cannot also be headless.
  clusterIP: None
  externalTrafficPolicy: local
  selector:
    app: web
  ports:
    - name: http
      port: 80
      # Quoted, this names a container port rather than the number 8080.
      targetPort: "8080"
      nodePort: 8080
    - name: http
      port: 80
`,
  },
  {
    id: 'ingress',
    label: 'An Ingress with problems',
    blurb:
      'A class set two ways at once, a host that is an IP, a relative path, a backend port named twice and a certificate for a host nothing routes.',
    yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  annotations:
    # IngressClass replaced this in 1.18, and it disagrees with the field below.
    kubernetes.io/ingress.class: nginx
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - checkout.example.com
      secretName: shop-tls
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /
            pathType: prefix
            backend:
              service:
                name: shop-web
                port:
                  # A backend picks a Service port by name or by number, not both.
                  name: http
                  number: 80
          - path: api/v1
            pathType: Prefix
            backend:
              service:
                name: shop-api
    # An Ingress routes by the Host header, so a rule names a host, not an address.
    - host: 203.0.113.10
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: shop-web
                port:
                  number: 80
`,
  },
  {
    id: 'ingressclass',
    label: 'An IngressClass with problems',
    blurb:
      'A namespace on a cluster-scoped object, a controller that is not domain-prefixed, a parameters reference whose scope and namespace contradict each other, and a default annotation that marks nothing.',
    yaml: `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: internal
  # An IngressClass belongs to no namespace; it is visible from all of them.
  namespace: ingress-nginx
  annotations:
    # The admission plugin compares this to "true" exactly, so this class is
    # not the default after all.
    ingressclass.kubernetes.io/is-default-class: "True"
spec:
  # A controller is a domain-prefixed path, so a bare name has no owner.
  controller: ingress-nginx
  parameters:
    apiGroup: k8s.example.com
    kind: IngressParameters
    name: internal-lb
    # Scope defaults to "Cluster", which forbids the namespace below it.
    namespace: ingress-nginx
`,
  },
  {
    id: 'job',
    label: 'A Job with problems',
    blurb:
      'A pod template that restarts forever, a selector the apiserver generates itself, per-index settings without indexes, and a failure policy matching on nothing.',
    yaml: `apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-import
spec:
  completions: 8
  parallelism: 4
  backoffLimit: -1
  # Per-index retries only exist for an Indexed Job; this one is NonIndexed.
  backoffLimitPerIndex: 2
  selector:
    matchLabels:
      job-name: nightly-import
  podFailurePolicy:
    rules:
      # A rule matches on an exit code or on a Pod condition, never on neither.
      - action: Ignore
      - action: FailJob
        onExitCodes:
          containerName: importer
          operator: In
          values: [137, 42]
  template:
    spec:
      # restartPolicy defaults to Always, which a Job cannot use.
      containers:
        - name: import
          image: importer:1.2.0
          args: ["--source", "s3://exports/nightly"]
`,
  },
  {
    id: 'cronjob',
    label: 'A CronJob with problems',
    blurb:
      'A time zone folded into the schedule instead of its own field, a lowercase enum value, a negative history limit, and a jobTemplate whose pod carries the same restart-policy and counter problems a Job would.',
    yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  # "TZ=" belongs in spec.timeZone, not folded into the schedule string.
  schedule: "TZ=America/New_York 0 6 * * *"
  concurrencyPolicy: allow
  successfulJobsHistoryLimit: -1
  jobTemplate:
    spec:
      backoffLimit: -1
      template:
        spec:
          # restartPolicy defaults to Always, which a CronJob's Job cannot use.
          containers:
            - name: report
              image: reporter:2.4.0
`,
  },
  {
    id: 'persistentvolumeclaim',
    label: 'A PersistentVolumeClaim with problems',
    blurb:
      'Two access modes that contradict each other, a storage class name that is not a DNS subdomain, a quantity with an invented byte suffix, and a dataSource that disagrees with dataSourceRef.',
    yaml: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: reports-data
spec:
  # ReadWriteOncePod already guarantees the volume to a single Pod, so pairing
  # it with another mode contradicts that guarantee.
  accessModes:
    - ReadWriteOnce
    - ReadWriteOncePod
  # storageClassName is a DNS subdomain, so it cannot carry an underscore.
  storageClassName: fast_ssd
  resources:
    requests:
      # A quantity has no "B" suffix for bytes.
      storage: 10GB
  dataSource:
    kind: PersistentVolumeClaim
    name: reports-data-snapshot
  dataSourceRef:
    # dataSourceRef is the newer form of the same setting, so the apiserver
    # keeps the two in sync automatically — it rejects them naming different objects.
    kind: PersistentVolumeClaim
    name: reports-data-backup
`,
  },
  {
    id: 'persistentvolume',
    label: 'A PersistentVolume with problems',
    blurb:
      'A namespace on a cluster-scoped object, two access modes that contradict each other, a capacity of zero, a lowercase reclaim policy, and two volume sources — one of them local, which needs node affinity this omits.',
    yaml: `apiVersion: v1
kind: PersistentVolume
metadata:
  name: build-cache
  # PersistentVolume is cluster-scoped, so a namespace is not allowed on it.
  namespace: ci
spec:
  # ReadWriteOncePod already guarantees the volume to a single Pod, so pairing
  # it with another mode contradicts that guarantee.
  accessModes:
    - ReadWriteMany
    - ReadWriteOncePod
  capacity:
    # A volume with no capacity describes nothing usable.
    storage: "0"
  # Reclaim policy values are case-sensitive; "recycle" is not "Recycle".
  persistentVolumeReclaimPolicy: recycle
  # Exactly one volume source is allowed, and a local one also needs
  # nodeAffinity to say which node it lives on — this has neither.
  local:
    path: /mnt/disks/ssd0
  nfs:
    server: nfs.example.com
    path: /export/build-cache
`,
  },
  {
    id: 'httproute',
    label: 'An HTTPRoute with problems',
    blurb:
      "A path containing \"/../\", a Service backend with no port, a backendRequest timeout longer than the request timeout, and a ReplacePrefixMatch rewrite on a rule with two matches instead of exactly one.",
    yaml: `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout
spec:
  parentRefs:
    - name: web-gateway
  hostnames:
    - checkout.example.com
  rules:
    - matches:
        - path:
            type: Exact
            # A path is matched element by element after a split on "/", so a
            # ".." element can never match a request path.
            value: /checkout/../admin
      backendRefs:
        # group and kind default to a reference to a Service, which can expose
        # more than one port — this backend does not say which.
        - name: checkout-api
      timeouts:
        request: 2s
        # backendRequest only bounds the part of the exchange spent waiting on
        # the backend, so it can never be longer than the request timeout.
        backendRequest: 5s
    - matches:
        - path:
            type: PathPrefix
            value: /api
        - path:
            type: PathPrefix
            value: /api/v2
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              # ReplacePrefixMatch only knows how to rewrite the prefix a
              # single PathPrefix match consumed — this rule has two.
              type: ReplacePrefixMatch
              replacePrefixMatch: /internal
      backendRefs:
        - name: checkout-api
          port: 8080
`,
  },
  {
    id: 'storageclass',
    label: 'A StorageClass with problems',
    blurb:
      'A default-class annotation that is quietly not "true", a namespace on a cluster-scoped object, a provisioner with a space in it, a reclaim policy a PersistentVolume may say but a class may not, and one topology term requiring the same label twice.',
    yaml: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    # The admission plugin compares this to "true" character by character, so
    # "True" leaves the cluster with no default class at all.
    storageclass.kubernetes.io/is-default-class: "True"
  # StorageClass is cluster-scoped, so a namespace is not allowed on it.
  namespace: storage
# A provisioner is a qualified name, so it cannot carry a space.
provisioner: ebs csi driver
# A StorageClass may only say Delete or Retain — Recycle is a PersistentVolume's
# to say, and even there it is deprecated.
reclaimPolicy: Recycle
# Binding mode values are case-sensitive.
volumeBindingMode: waitForFirstConsumer
parameters:
  type: gp3
allowedTopologies:
  - matchLabelExpressions:
      # The requirements in one term are combined with AND, so a second one on
      # the same label can only narrow or contradict the first. One requirement
      # listing both zones is what was meant.
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1b
`,
  },
  {
    id: 'networkpolicy',
    label: 'A NetworkPolicy with problems',
    blurb:
      'An ipBlock combined with a namespaceSelector on the same peer, an except entry that falls outside its own cidr, a cidr with bits set beyond its prefix, an endPort below its port, and an egress block that policyTypes never turns on.',
    yaml: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-policy
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: web
  policyTypes:
    - Ingress
  ingress:
    - from:
        # ipBlock selects by raw address rather than by label, so it cannot be
        # combined with a selector — the apiserver rejects the pair rather
        # than guess which one is meant.
        - namespaceSelector:
            matchLabels:
              team: payments
          ipBlock:
            # 10.1.1.5/24's own network is 10.1.1.0/24; the ".5" is ignored by
            # the CNI, so writing it invites the reader to think it matters.
            cidr: 10.1.1.5/24
            except:
              # 10.2.0.0/24 lies outside 10.1.1.0/24 entirely, so it excludes
              # nothing.
              - 10.2.0.0/24
      ports:
        - protocol: TCP
          port: 8443
          # A range's end can't sit below where it starts.
          endPort: 8080
  # policyTypes only lists "Ingress", so this block is stored but never
  # enforced.
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
`,
  },
  {
    id: 'configmap',
    label: 'A ConfigMap with problems',
    blurb:
      'A key with a space in it, one that names a path rather than a file, a key claimed by both data and binaryData, a value that is not base64 and one that YAML read as a number.',
    yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: shop
data:
  # Keys become filenames when the map is mounted, so a space is not allowed.
  log level: debug
  # "8080" is quoted in the API: data is a map of strings, and an unquoted
  # number is not one.
  PORT: 8080
  # A key starting with ".." would be written outside the mount directory.
  ..cache: /var/cache
  # Claimed by binaryData below as well; the two maps share one namespace of
  # keys, so only one of them may carry it.
  favicon.ico: placeholder
binaryData:
  favicon.ico: AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAA=
  # Not base64, so the apiserver cannot decode it into bytes at all.
  logo.png: <svg />
`,
  },
  {
    id: 'secret',
    label: 'A Secret with problems',
    blurb:
      'A key with a space in it, one that names a path outside the mount directory, a TLS secret missing tls.key, and a key claimed by both data and stringData that stringData silently overwrites.',
    yaml: `apiVersion: v1
kind: Secret
metadata:
  name: web-tls
  namespace: shop
type: kubernetes.io/tls
data:
  # Keys become filenames when the Secret is mounted, so a space is not allowed.
  "tls certificate": dGVzdA==
  # A key starting with ".." would be written outside the mount directory.
  ..backup: dGVzdA==
  # tls.key is missing entirely: only presence is required for a TLS secret,
  # so an empty value would have been fine, but an absent one is not.
  tls.crt: dGVzdA==
  # Claimed by stringData below as well; stringData silently overwrites it
  # rather than the apiserver rejecting the overlap, as it would for a
  # ConfigMap's data and binaryData.
  token: cGxhY2Vob2xkZXI=
stringData:
  token: replaced-value
`,
  },
  {
    id: 'resourcequota',
    label: 'A ResourceQuota with problems',
    blurb:
      'A resource name a quota cannot bound, a fractional object count, a scope that contradicts the resources beside it, and two scopes that select complementary sets of Pods.',
    yaml: `apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: shop
spec:
  hard:
    requests.cpu: "4"
    # Unprefixed keys are limited to what the quota system counts natively;
    # a Deployment count is written "count/deployments.apps".
    deployments: "10"
    # A count of objects has to be a whole number.
    pods: "20.5"
    # Bounded below by a Pod-selecting scope, which cannot count Secrets.
    secrets: "10"
  scopes:
    # Every Pod is one or the other, so the two together select none of them.
    - Terminating
    - NotTerminating
  scopeSelector:
    matchExpressions:
      # Only PriorityClass has values to match against; every other scope can
      # only be asked whether it applies.
      - scopeName: BestEffort
        operator: In
        values:
          - high
`,
  },
  {
    id: 'limitrange',
    label: 'A LimitRange with problems',
    blurb:
      'A default on a Pod-typed entry, a min above its own max, a ratio the min and max have already ruled out, and a PersistentVolumeClaim entry that bounds no storage.',
    yaml: `apiVersion: v1
kind: LimitRange
metadata:
  name: compute
  namespace: shop
spec:
  limits:
    - type: Pod
      max:
        cpu: "4"
      # A Pod entry bounds the total across the containers; defaults are
      # filled in per container, so there is nothing here to apply them to.
      defaultRequest:
        cpu: 500m
    - type: Container
      min:
        # Above the max below it, so no container can satisfy both.
        memory: 2Gi
      max:
        memory: 1Gi
      maxLimitRequestRatio:
        # The min and max above already cap the spread at 1Gi/2Gi.
        memory: "4"
    - type: PersistentVolumeClaim
      # Size is all a claim can be bounded by, and neither end is set.
      max:
        cpu: "1"
`,
  },
  {
    id: 'serviceaccount',
    label: 'A ServiceAccount with problems',
    blurb:
      'A secret reference reaching for another namespace, a name no Secret could have, the same pull secret twice, and an annotation that reads as "off" rather than as the "true" it was meant to say.',
    yaml: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: build-runner
  namespace: ci
  annotations:
    # Parsed with Go's ParseBool, whose error is thrown away — so anything it
    # cannot read leaves every Secret in the namespace mountable.
    kubernetes.io/enforce-mountable-secrets: "yes"
secrets:
  # Only the name survives: the apiserver rewrites each entry to {name} before
  # storing it, so a namespace here is dropped rather than honoured.
  - name: registry-token
    namespace: shared
  - name: Build_Cache
imagePullSecrets:
  - name: registry-credentials
  # Already listed above; the kubelet collects these into a set.
  - name: registry-credentials
automountServiceAccountToken: false
`,
  },
  {
    id: 'role',
    label: 'A Role with problems',
    blurb:
      'A rule reaching for a non-resource URL a namespace has no say over, a resource written as its Kind, a name restriction on the one verb that carries no name, and a "*" that means the opposite of what it looks like.',
    yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  # Capitals and colons are fine: RBAC validates a name as a path segment,
  # not as a DNS subdomain.
  name: ci:Deployer
  namespace: ci
rules:
  - apiGroups: [""]
    # Named as the request path spells it — "pods" — not as the manifest's
    # "kind" does.
    resources: ["Pod"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    # The name of a created object is in the body, which the authorizer never
    # reads, so this rule grants no create at all.
    resourceNames: ["web"]
    verbs: ["create", "patch"]
  - apiGroups: [""]
    resources: ["secrets"]
    # Not a wildcard here: resourceNames is compared by string equality, so
    # this asks for the Secret literally called "*".
    resourceNames: ["*"]
    verbs: ["get"]
  # A namespaced rule cannot reach a path that belongs to the server itself.
  - nonResourceURLs: ["/healthz"]
    verbs: ["get"]
`,
  },
  {
    id: 'clusterrole',
    label: 'A ClusterRole with problems',
    blurb:
      'A rule mixing a server path with a resource, a URL missing the slash every request path starts with, a verb no non-resource request ever carries, and an aggregation rule that quietly owns the rules written beside it.',
    yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
# Setting this hands "rules" to the aggregation controller, which recomputes
# the list from every ClusterRole the selectors match and writes it back.
aggregationRule:
  clusterRoleSelectors:
    # An empty selector imposes no requirement, so it matches every ClusterRole
    # in the cluster rather than none of them.
    - {}
rules:
  # A rule is either about resources or about server paths, never both.
  - nonResourceURLs: ["/metrics"]
    apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get"]
  - nonResourceURLs:
      # Compared against the path from the request line, which always begins
      # with a slash.
      - healthz
      # Only a trailing "*" is a wildcard; anywhere else it is just a character.
      - /apis/*/healthz
    # A non-resource request is authorized as its HTTP method, so "list" is
    # never the verb being asked about here.
    verbs: ["get", "list"]
`,
  },
  {
    id: 'rolebinding',
    label: 'A RoleBinding with problems',
    blurb:
      'A roleRef pointing at the wrong API group, a ServiceAccount subject carrying an apiGroup it may not have, a namespace beside a User the authorizer never reads, and the same subject listed twice.',
    yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: default
roleRef:
  # The API group, not the apiVersion — and RBAC's own is the only one a
  # binding can name. Leaving the field out fills it in correctly.
  apiGroup: rbac.authorization.k8s.io/v1
  kind: Role
  name: pod-reader
subjects:
  # A ServiceAccount belongs to the core group, whose name is the empty string,
  # and the apiserver checks this field's length rather than its value.
  - kind: ServiceAccount
    name: reader
    apiGroup: rbac.authorization.k8s.io
  # A User is whatever the authenticator called the requester, so it lives in
  # no namespace and this is stored and then never consulted.
  - kind: User
    name: alice
    apiGroup: rbac.authorization.k8s.io
    namespace: default
  # Matching stops at the first subject the request's user answers to.
  - kind: User
    name: alice
    apiGroup: rbac.authorization.k8s.io
`,
  },
  {
    id: 'clusterrolebinding',
    label: 'A ClusterRoleBinding with problems',
    blurb:
      'A namespace on a kind that has none, a roleRef naming a Role no cluster-wide binding can bind, and a ServiceAccount subject leaving out the namespace only a RoleBinding could have supplied.',
    yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: read-nodes
  # A ClusterRoleBinding is attached to no namespace, so this is not merely
  # unusual but rejected outright.
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  # A Role's rules are written to be read inside its own namespace, and this
  # binding has none to read them in.
  kind: Role
  name: node-reader
subjects:
  # A RoleBinding would fill this in from its own namespace. Nothing here can,
  # so the apiserver asks for it.
  - kind: ServiceAccount
    name: reader
`,
  },
  {
    id: 'gateway',
    label: 'A Gateway with problems',
    blurb:
      'A hostname written where an IP address is expected, a tls block on a plaintext listener, an HTTPS listener asking to pass TLS through, a terminating listener with no certificate, and two listeners nothing could tell apart.',
    yaml: `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
spec:
  gatewayClassName: example
  addresses:
    # The address type defaults to IPAddress, whose value has to be a literal
    # address — a name needs "type: Hostname" beside it.
    - value: gateway.example.com
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      # An HTTP listener is not TLS-terminated, so there is no handshake for
      # any of this to apply to.
      tls:
        certificateRefs:
          - name: web-cert
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        # Passthrough leaves the Gateway unable to read the request it would
        # have to route on; a listener that passes TLS through speaks TLS.
        mode: Passthrough
    - name: https-alt
      protocol: HTTPS
      port: 8443
      # The mode defaults to Terminate, which cannot complete a handshake
      # without a certificate to complete it with.
      tls: {}
    - name: https-dup
      protocol: HTTPS
      port: 8443
      # Same port, protocol and (absent) hostname as the listener above, so
      # nothing would ever be routed by this one.
      tls:
        certificateRefs:
          - name: web-cert
`,
  },
];
