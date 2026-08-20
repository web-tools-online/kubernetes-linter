# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                        # vite dev server at /kubernetes-linter/
npm test                           # vitest run (CI gate — build does not run without it)
npm run test:watch
npm run build                      # tsc --noEmit && vite build
npm run gen:schema                 # regenerate every version bundle from upstream
npm run gen:schema -- 1.37         # regenerate one

npx vitest run tests/rules.test.ts          # one file
npx vitest run -t "rejects a bad quantity"  # one test by name
```

`npm run gen:schema` fetches ~4 MB of `swagger.json` per version from
raw.githubusercontent.com, so it needs network access. Its output is committed; nothing is
fetched at runtime.

## Architecture

A browser-only linter — no server, no backend, no CLI. `index.html` → `src/main.ts` →
CodeMirror editor + findings panel. The manifest never leaves the tab (the Share button puts
it in the URL fragment).

### Two lint layers

`lint(text, schema)` in `src/lint/index.ts` is the entire public API. Per YAML document:

1. **Layer 1 — schema conformance** (`src/lint/schema.ts`). `lintSchema()` walks the parsed
   value alongside the generated OpenAPI closure: unknown fields, missing required fields,
   type mismatches, `x-kubernetes-list-map-keys` duplicates. Generic and exhaustive by
   construction — do not hand-write checks that this layer already derives.
2. **Layer 2 — API validation rules** (`src/lint/rules/`). One module per area, listed in
   `registry.ts`, each a `Rule { id, run(ctx) }`. These are the checks the apiserver performs
   that OpenAPI cannot express (cross-field consistency, name formats, enum values).

Adding a rule means writing a `Rule` in `src/lint/rules/` and appending it to `registry.ts` —
to `POD_RULES` if it reads `ctx.spec`, to `RULES` if it addresses the document and is therefore
correct for every kind — or, for a rule that only applies to one kind, to that kind's `rules`
in `src/lint/kinds.ts`. Nothing else is wired by hand.

Scope discipline: the project deliberately reports **only** what the apiserver would reject or
what is a genuine misconfiguration. No security posture, no house style.

### `Path` is the currency

Every finding carries a `Path` (`['spec','containers',0,'image']`). The same array is used to

- resolve a source range for the editor marker (`locate()` in `parse.ts`, which falls back to
  the nearest resolvable ancestor and clamps markers to one line), and
- address the node a `FixOp` edits (`fix.ts`).

Tests assert exact `path` arrays, so changing a path is a visible, intentional change.

### Fixes

`fix.ts` applies ops to the **YAML AST** and re-serialises, so comments, key order, quoting and
blank lines survive; `detectFormat()` re-derives indentation from the input. Fixes are `safe`
(unambiguous — a misspelled key, an enum value differing only in case) or not; "apply all"
runs only safe ones, re-linting after each because fixing `contaienrs:` reveals everything
underneath it. Note `ensureParents()`: intermediate levels must be built with
`doc.createNode({})`, since `setIn`'s own `Map` objects serialise as `!!omap` under YAML 1.1.

YAML is parsed as **1.1**, not 1.2, deliberately — the apiserver decodes via `sigs.k8s.io/yaml`,
so bare `no`/`on`/`off` must resolve to booleans here too and get reported as type mismatches.

### Kubernetes versions (1.25–1.36)

There is no version table in TypeScript. `src/lint/schemas.ts` derives `AVAILABLE_VERSIONS`
from an `import.meta.glob` over `src/schema/k8s-*.json`, and `DEFAULT_VERSION` from the
`k8sVersion` field of the statically imported default bundle. The only bounds live in
`scripts/generate-schema.mjs` (`OLDEST_MINOR` / `NEWEST_MINOR`). Dropping in a new
`src/schema/k8s-1.37.json` makes it appear in the picker; moving the default means changing
the static import.

The glob must stay lazy — Vite rewrites its chunk URLs for the configured `base`, which a
hand-built `fetch('/schema/…')` would not survive under the `/kubernetes-linter/` sub-path.

**Feature gating is schema-driven.** `ctx.supports(path)` is just
`schema.describe(path) !== undefined`, so a field absent from a version's closure is
automatically unsupported. When a rule's *advice* names a field that arrived in a particular
release, gate it: report the problem on every version but withhold the fix, naming the version
in the explanation (see the sidecar case in `rules/containers.ts`, `Container.restartPolicy`,
1.28+). `tests/versions.test.ts` is where per-version behaviour is pinned.

The one thing that gate cannot express is an *annotation*, which is not a schema field, so its
presence in a version's closure says nothing: `rules/serviceaccount.ts` reads
`ctx.schema.version` directly to decide whether to report the
`kubernetes.io/enforce-mountable-secrets` deprecation, since below 1.32 the mechanism is
current and saying anything would be wrong rather than merely early. That is the only
version-conditional *report* in the codebase — everywhere else the finding fires on every
version and only the fix or the wording varies.

Two things do not come from OpenAPI and need manual attention when adding a version: the enum
table in `rules/enums.ts`, and any version-gated rule advice. Known limitation: enum *values*
added in a later release are accepted on older ones, because the table has no per-value
`since`.

Note that `ctx.supports()` takes an **absolute** path, so a pod-spec gate must be written
`ctx.supports(ctx.at(field))` — passing a bare `['spec', field]` would resolve against the
wrong node on a Deployment and silently close the gate on every version.

### Kinds (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, IngressClass, PersistentVolume, PersistentVolumeClaim, StorageClass, NetworkPolicy, ConfigMap, Secret, ResourceQuota, LimitRange, ServiceAccount, Role, ClusterRole, RoleBinding, HTTPRoute)

The kind comes from the **document**, not from a picker or a `lint()` argument: `lintSchema()`
reads `kind`, resolves it against the bundle's `roots` map, and returns the name; `index.ts`
looks that up in `KINDS` (`src/lint/kinds.ts`) to get a `KindDescriptor`. A kind the bundle has
no root for still yields `unsupportedKind` and a `lint/unsupported-kind` note. Because one
bundle carries every root, a multi-document manifest can mix kinds with no extra chunk load —
which is what keeps `lint()` synchronous.

A `KindDescriptor` is only `{ kind, podTemplate?, nameFormat?, clusterScoped?, rules }`. The
root `$ref` is
deliberately *not* in it: that lives in the generated bundle, so the generator stays the
single source of truth for definition names — and `apiVersion` is derived from that definition
name too, never declared. `nameFormat` defaults to `'subdomain'`, is `'label'` for a kind whose
name prefixes generated Pod names (StatefulSet) and `'rfc1035'` for a Service, whose name has
to start with a letter. It is `'path-segment'` for the three RBAC kinds, which are the loose end of the same
scale: RBAC validates a name with `path.IsValidPathSegmentName` and nothing else, so anything
spellable as one segment of a URL is legal there — capitals, `_` and the `:` the built-in roles
use — and only `.`, `..`, `/` and `%` are refused. `metadata.ts` reads it. `clusterScoped` is the other thing that module
reads: on a kind that lives outside namespaces (IngressClass, PersistentVolume, ClusterRole) a
`metadata.namespace` is not a name to validate but a field the apiserver forbids, so it is
reported as `meta/namespace-not-allowed` and the format check is skipped.

`podTemplate` is `{ specPath, metadataPath, claimTemplatesPath? }`, and **it is optional**:
a Service, an Ingress, an IngressClass, a PersistentVolume, a PersistentVolumeClaim, a
StorageClass, a NetworkPolicy, a ConfigMap, a Secret, a ResourceQuota, a LimitRange, a
ServiceAccount, a Role, a ClusterRole, a RoleBinding and an HTTPRoute describe no Pod at all. Its absence is what makes `POD_RULES`
skip the kind (`index.ts`), so a kind with no pod template is checked by layer 1, by `RULES` — the
document-level rules, `metadata.ts` and `enums.ts` — and by its own module, and by nothing
else. `claimTemplatesPath` is the one concession to a kind that generates volumes: a
StatefulSet's controller adds one Pod volume per `volumeClaimTemplates` entry, named after it,
so those names reach `volumes.ts` through `ctx.generatedVolumes` and a mount referring to one
is not reported as undeclared.

**Rules address the PodSpec relatively.** `ctx.at(...)` prefixes `podTemplate.specPath`,
`ctx.meta(...)` prefixes `podTemplate.metadataPath`, and `ctx.field(...)` renders a dotted name
for a message. There are no `['spec', …]` literals left in the PodSpec rules; reintroducing one
silently breaks Deployment. The deliberate exceptions are `rules/deployment.ts`,
`rules/statefulset.ts`, `rules/daemonset.ts`, `rules/job.ts`, `rules/cronjob.ts`,
`rules/service.ts`, `rules/ingress.ts`, `rules/ingressclass.ts`,
`rules/persistentvolume.ts`, `rules/persistentvolumeclaim.ts`, `rules/storageclass.ts`,
`rules/configmap.ts`, `rules/secret.ts`, `rules/resourcequota.ts`, `rules/limitrange.ts`,
`rules/serviceaccount.ts`, `rules/role.ts`, `rules/rolebinding.ts` and `rules/httproute.ts`,
which address
`spec.selector`,
`spec.strategy`, `spec.updateStrategy`,
`spec.completionMode`, `spec.schedule`, `spec.ports`, `spec.rules`, `spec.controller`,
`spec.accessModes`, `spec.capacity` and the like — fields of the object itself, not of any pod
spec.
`storageclass.ts`, `configmap.ts`, `secret.ts`, `serviceaccount.ts`, `role.ts`,
`clusterrole.ts` and `rolebinding.ts` go one step further and address `ctx.doc` directly: none
of the seven has a `spec` at all, so `provisioner`, `data`, `secrets`, `rules`,
`aggregationRule`, `roleRef` and the rest are document-root fields.

`ctx.doc` is the document root (used by `metadata.ts`, `enums.ts` and every per-kind module);
`ctx.spec` is the PodSpec wherever this kind keeps it, and `{}` for a kind with no pod
template. `ContainerRef.path` already carries the prefix, so any rule built on `ctx.containers`
is kind-correct for free.

Rule IDs stay `pod/*` for PodSpec checks — they describe a PodSpec problem wherever it lives —
and `deployment/*` / `statefulset/*` / `daemonset/*` / `job/*` / `cronjob/*` / `service/*` /
`ingress/*` / `ingressclass/*` / `persistentvolume/*` / `persistentvolumeclaim/*` /
`storageclass/*` / `networkpolicy/*` / `serviceaccount/*` / `configmap/*` / `secret/*` /
`resourcequota/*` / `limitrange/*` / `role/*` / `clusterrole/*` / `rolebinding/*` /
`httproute/*` for checks on
the object itself. The two
document-level rules
are named for what they check rather than for a kind, since they run for every kind including
one with no Pod: `meta/*` in `metadata.ts` and `enum/*` in `enums.ts`. `Schema` is per version
and holds every root; `Schema.for(kind)` returns the `KindSchema` view that both lint layers
actually use.

Each kind keeps its **own** rule module rather than sharing one: `deployment.ts`,
`statefulset.ts`, `daemonset.ts` and `job.ts` overlap on the selector and template checks, but
the four upstream validators are separate, diverge in wording and in what they forbid, and are
versioned independently — so they are kept independent here too, and a change to one is not a
change to the others. The rollout checks are where that pays off: a Deployment rejects
`maxSurge` and `maxUnavailable` both at zero, a DaemonSet rejects that *and* the two both
non-zero (it either drains a node or surges onto it, never both), a StatefulSet has no
`maxSurge` at all, and a Job has no rollout to speak of.

`job.ts` is where the shared template checks invert. The other three require
`restartPolicy: Always`; a Job forbids it, and since the PodSpec default *is* `Always` and is
applied before validation runs, **an absent `restartPolicy` is an error on a Job** — the one
place a missing field is reported rather than read as the default. Its selector inverts too:
the apiserver generates one from the Job's UID, so writing one at all is rejected unless
`manualSelector: true` says the Pods are being adopted rather than created. Everything else
turns on the effective `completionMode`, resolved the way `service.ts` resolves `spec.type`
(defaulting to `NonIndexed`, `undefined` for a value the API does not know), because only an
Indexed Job has indexes for `backoffLimitPerIndex`, `maxFailedIndexes` and `successPolicy` to
address. The version gates are dense here — the per-index fields and `podReplacementPolicy`
arrived in 1.28, `managedBy` and `successPolicy` in 1.30 — so every one of those reads
`ctx.supports(['spec', field])` first. Deliberately skipped are the size caps that only bound
how long `.status` can grow (20 policy rules, 255 exit codes, 100000 completions); the module
comment says so, and `maxFailedIndexes` against `completions` is kept because that pair is a
contradiction rather than a limit.

`cronjob.ts` is the one kind whose pod template sits under another kind's spec rather than
directly under its own: `spec.jobTemplate.spec` is a full JobSpec, and the apiserver validates
it with the *same* `validateJobSpec` a Job's own spec goes through — so `job.ts` exports
`checkJobSpec(ctx, spec, base)`, the JobSpec checks above with every `['spec', …]` literal
replaced by `[...base, …]`, and `cronjob.ts` calls it against `spec.jobTemplate.spec` instead of
duplicating those checks under `cronjob/*` ids. A finding from that nested spec keeps its `job/*`
id and fires at the deeper path, exactly as a `pod/*` finding does under any kind's PodSpec.
Two checks stay behind in `job.ts`, since upstream keeps them in `ValidateJob` rather than
`validateJobSpec` and both read the *object's* own name or selector rather than anything inside
the JobSpec: the generated-selector check (a CronJob's jobTemplate may not carry a selector at
all, which `cronjob.ts` reports itself, unconditionally) and the indexed-Pod-hostname check (a
CronJob's Job name is generated by the controller, not written in the manifest, so there is
nothing to check up front). What is left to `cronjob.ts` itself — `schedule`, `timeZone`,
`concurrencyPolicy`, the two history limits, and the 52-character name cap the controller's
`-<timestamp>` suffix imposes — has no home in a Job at all. The schedule and `@every <duration>`
formats are parsed in `src/k8s/cron.ts`, mirroring `robfig/cron`'s `ParseStandard`; the
`timeZone` check layers a browser stand-in for `time.LoadLocation` — `Intl.DateTimeFormat`,
which throws on a zone the runtime's tz database does not know — on top of the same structural
rules upstream applies first. Nothing here is version-gated: CronJobSpec, `timeZone` included,
has been unchanged since the 1.25 floor.

`service.ts` is the odd one out and shows what a kind without a pod template costs: almost
everything it checks turns on `spec.type`, which decides whether a `nodePort`, a
`loadBalancerClass` or an `externalName` is allowed to exist at all. The effective type is
resolved once — defaulting to `ClusterIP`, and `undefined` when the value is not one the API
knows, since the enum rule has already reported that — and the checks that turn on it sit out
the `undefined` case while the rest (port numbers, name formats, IP syntax) still run.
`k8s/net.ts` holds the IP and CIDR parsers that needs, matching Go's netip rather than
inet_aton: `010.1.1.1` is an error, not octal.

`ingress.ts` is the second such kind, and it turns instead on how much layer 1 already covers:
`pathType` and `backend` are required on a path, `paths` on an `http` block, `name` on a service
backend, so the module is left with what the schema cannot express — an empty list where a
missing one would have been caught, an empty string where a missing key would have been, and the
mutually exclusive pairs (`service` vs `resource`, port `name` vs `number`) the API models as two
optional fields. It reuses `isIPAddress` to refuse an address where a rule wants a name, and
`isWildcardDNS1123Subdomain` in `k8s/names.ts` for the one leading `*.` label a host may carry.
Nothing in it is version-gated: networking/v1 Ingress has been served unchanged since 1.19.

`ingressclass.ts` is the third, and the reverse case: `IngressClassSpec` has no required fields
at all, so layer 1 covers almost nothing and even `spec.controller` — which the apiserver does
require — is the module's to report. Everything else turns on `parameters.scope`, resolved the
way `service.ts` resolves `spec.type`: defaulting (to `Cluster`, as the API does) and left
`undefined` when the value is not one the enum table knows, since a scope that means nothing
says nothing about the `namespace` beside it. The last check is not a validation rule at all —
`ingressclass.kubernetes.io/is-default-class` is compared to the string `"true"` by the
admission plugin that reads it, so `"True"` is a class that is quietly not the default. Like
Ingress, none of it is version-gated.

`persistentvolume.ts` is the fourth, and the one where the schema covers the least of all:
`PersistentVolumeSpec` has no `required` list at all, and its central rule — exactly one of 22
volume-source fields — is a mutual exclusion OpenAPI has no way to express. Like `IngressClass`
it is cluster-scoped, so `metadata.namespace` is `meta/namespace-not-allowed` rather than a name
to validate. The source fields themselves are not a hardcoded list: every one of the 22 is a
`$ref` whose definition name ends in "VolumeSource", the only two exceptions being `claimRef`
(an `ObjectReference`) and `nodeAffinity` (a `VolumeNodeAffinity`), so the module derives the
list from the schema exactly as `volumes.ts` derives a Pod's Volume sources — a new in-tree
plugin is handled the moment the schema is regenerated. Each source's own required fields
(`hostPath.path`, `csi.driver` and so on) are already in the generated schema's `required` lists
and so are layer 1's; the module adds only what OpenAPI cannot express: the volume-source
exclusivity, a `local` source with no `nodeAffinity`, a hostPath mount of `/` with a `Recycle`
reclaim policy, `..` in a path, a non-absolute `nfs.path`, a `csi.driver` format check that
lowercases before comparing (the apiserver's own quirk), and the same `storageClassName` /
`volumeAttributesClassName` checks a PersistentVolumeClaim has. `persistentVolumeReclaimPolicy`
and `volumeMode` are plain enums and live in `rules/enums.ts` instead. Deliberately skipped:
`claimRef`, which the validator only constrains on update, not on create; `mountOptions`, whose
own description says it is "not validated" server-side; and the field-by-field checks for the
deprecated in-tree drivers (RBD, CephFS, iSCSI, Glusterfs, ScaleIO, Quobyte, StorageOS, Flocker)
beyond what their own `required` fields already cover.

`persistentvolumeclaim.ts` is the fifth, and like `ingressclass.ts` the schema covers almost
nothing: `PersistentVolumeClaimSpec` has no `required` list at all, so `accessModes` and
`resources.requests.storage` — both required by the apiserver — are the module's to report,
alongside `ReadWriteOncePod` combined with another mode, a non-positive storage request, a
`storageClassName` or `volumeAttributesClassName` that is not a DNS subdomain, and the
`dataSource`/`dataSourceRef` consistency checks. `ACCESS_MODES` is exported from this module and
imported by `persistentvolume.ts` rather than duplicated, since upstream validates both kinds'
access modes against one shared set. It is also the second kind whose checks are shared with a
nested location the way `job.ts` shares `checkJobSpec` with `cronjob.ts`: a StatefulSet's
`volumeClaimTemplates` and a Pod's `ephemeral.volumeClaimTemplate` are both
`PersistentVolumeClaimSpec`s the apiserver validates with the very same function a
PersistentVolumeClaim's own spec goes through, so this module exports `checkClaimSpec(ctx, spec,
base)` for `rules/statefulset.ts` and `rules/volumes.ts` to call against those nested specs. A
finding from either keeps its `persistentvolumeclaim/*` id and fires at the deeper path, exactly
as a `job/*` finding does under a CronJob's `jobTemplate.spec`. `volumeAttributesClassName` is
the one version-gated field on both kinds, arriving in 1.29 alongside `VolumeResourceRequirements`
replacing `ResourceRequirements` as the type of a claim's `resources` — a rename the schema-driven
walk does not need to know about, since it only ever reads `resources.requests.storage` by key.

`httproute.ts` is the sixth, and the odd one out: it is a Gateway API kind, not a core
Kubernetes one, so its schema does not come from `kubernetes/kubernetes`'s `swagger.json` at
all — there is no `io.k8s.api.…HTTPRoute` definition to point `ROOTS` at, because Gateway API
ships as CRDs from `kubernetes-sigs/gateway-api`, installed independently of the cluster.
`scripts/generate-schema.mjs` fetches and flattens the HTTPRoute CRD's `openAPIV3Schema` once
(`buildGatewayDefinitions()`), from one pinned Gateway API release (`GATEWAY_API_VERSION`)
rather than per Kubernetes minor, and embeds the same ~22 definitions in every bundle — so
`ctx.supports()` gates never close for an HTTPRoute field, and the picker's Kubernetes version
changes nothing about how an HTTPRoute is checked. The CRD schema is already inlined (no
`$ref` of its own), so `flattenGatewayNode()` re-derives named definitions from a hand-kept
`HTTPROUTE_TYPES` path-to-Go-type map, checking that any two paths mapping to the same name
produce the same shape before reusing it — `ParentReference` is one such case, reached both
from `spec.parentRefs` and from `status.parents[].parentRef`. Two subtrees are replaced
wholesale by definitions the bundle already carries rather than flattened on their own:
`metadata` (a CRD's schema states only `{ type: object }` for it) becomes a `$ref` to meta/v1
`ObjectMeta`, and `status.parents[].conditions[]` — field for field the same as a Service's own
status conditions — becomes a `$ref` to meta/v1 `Condition`.

`storageclass.ts` is the seventh, and the structural odd one out: a StorageClass has **no
`spec`**. `provisioner`, `parameters`, `reclaimPolicy`, `mountOptions`, `allowVolumeExpansion`,
`volumeBindingMode` and `allowedTopologies` are all fields of the document root, so the module
reads `ctx.doc` where every other kind's module opens with the
`const declared = ctx.doc['spec']` idiom — and its two `enums.ts` entries are keyed
`StorageClass.reclaimPolicy` / `StorageClass.volumeBindingMode`, the only entries in that table
owned by a root definition rather than a `*Spec`. `reclaimPolicy` is also the one place two
kinds disagree on a vocabulary: a PersistentVolume may say `Recycle`, a StorageClass may not.
Layer 1 covers more here than it does for an IngressClass — `provisioner` is in the schema's
`required` list, as are a topology expression's `key` and `values` — so the module is left with
the qualified-name format of the provisioner (lowercased first, the same apiserver quirk
`persistentvolume.ts` documents for `csi.driver`, and `IsQualifiedName` rather than a DNS
subdomain, which is what lets `kubernetes.io/aws-ebs` through), the parameters map's empty key
and size caps, and the several ways one `allowedTopologies` entry can contradict itself or its
neighbour. The trap worth knowing: `validateVolumeBindingMode` errors on a nil mode, but
`SetDefaults_StorageClass` fills in `Immediate` before validation runs — so an **absent**
`volumeBindingMode` is not reported, the exact inverse of the Job `restartPolicy` case where
the default is itself invalid. Deliberately skipped: `mountOptions` (not validated server-side,
as on a PersistentVolume), `allowVolumeExpansion` (a bare bool), and the immutability of
`provisioner`/`parameters`/`reclaimPolicy`/`volumeBindingMode`, which only constrains an update.
Nothing is version-gated: storage/v1 StorageClass predates the 1.25 floor and has not changed
since.

`networkpolicy.ts` is the eighth, and unlike every one before it almost everything it addresses
is either a `LabelSelector` or a CIDR block rather than a field of its own: `spec.podSelector`
and each peer's `podSelector`/`namespaceSelector` all go through `selector.ts`'s
`checkRequirement`, the same helper `persistentvolumeclaim.ts`'s own selector uses, and each
`ipBlock` goes through two functions added to `k8s/net.ts` for this kind — `cidrContains`,
mirroring Go's `net.IPNet.Contains`, and `maskCIDR`, its canonical network form — since nothing
before it needed to ask whether one CIDR block sits inside another. `podSelector` is also the
one place this kind inverts a convention the three controller kinds share: an **empty**
selector is not a mistake here, it means "every Pod in this namespace", the opposite of the
empty-selector rejection `deployment.ts`/`statefulset.ts`/`daemonset.ts` each report, so this
module never runs that check at all. Layer 1 covers `podSelector` and `ipBlock.cidr` being
required; the module is left with what OpenAPI cannot express — a peer naming none of
`podSelector`, `namespaceSelector` or `ipBlock`, or combining `ipBlock` with either selector, an
`except` entry that is not a strict subset of its `cidr`, and a `port`/`endPort` pair that
disagree, plus two checks that are not apiserver rejections at all and so are reported as
warnings rather than errors: a `cidr` with bits set beyond its prefix length (inert today, and
from 1.36 a hard rejection under the `StrictIPCIDRValidation` feature gate, named in the
explanation the way the sidecar case names 1.28) and an `ingress`/`egress` rule list that
`policyTypes` does not cover, which the apiserver stores but never enforces. `policyTypes`
itself is a list of enum strings rather than a scalar field, so — like `PersistentVolumeClaim`'s
`accessModes` — it cannot go in the `enums.ts` table at all (`walkFields` hands `enumRule` the
whole array, which only ever compares a scalar value) and is checked in the module instead, with
`didYouMean` and a safe fix exactly as `accessModes` gets one. `NetworkPolicyPort.protocol` is
a plain scalar enum and does live in the table. One further wrinkle is not this module's to
paper over: upstream's own generated OpenAPI document lists `podSelector` as required on
`NetworkPolicySpec` through 1.33 and stops in 1.34, even though the apiserver has never actually
rejected an absent one — the bundle keeps that verbatim rather than patching around it, so an
absent `podSelector` is `schema/required-field` on the older releases and nothing on the newer
ones, pinned as upstream's own drift in `tests/versions.test.ts` rather than treated as a bug
here. Nothing in the module itself is version-gated: every field it checks, `endPort` included,
has been part of networking/v1 NetworkPolicy since before the 1.25 floor.

`configmap.ts` is the ninth, and the second kind with **no `spec`**: like `storageclass.ts` it
reads `ctx.doc`, since `data`, `binaryData` and `immutable` are document-root fields. It is also
the kind layer 1 covers the most of, precisely because there is so little to cover — the two
maps are `map[string]string`, so a value written as a bare number is `schema/type` with the
usual quoting fix, and nothing is required at all, an empty ConfigMap being perfectly valid. It
is the keys rather than the fields that carry the rules, and a key is not a field the schema
walk can see. What is left is what OpenAPI cannot express: the key format (`isConfigMapKey` in
`k8s/names.ts`, mirroring apimachinery's `IsConfigMapKey`), the two maps not sharing a key, and
the 1 MiB cap `MaxSecretSize` puts on both together. The `.`/`..`/`..`-prefixed spellings that
upstream's `hasChDirPrefix` half rejects are reported under a rule of their own rather than
folded into the format check, since they fail for a different reason — a key is a *filename*
when the map is mounted, so those three would name the mount directory, its parent, or a path
outside it. One check moved into layer 1 instead of being written here: a binaryData value is
`format: byte`, so `schema.ts` gained a generic `schema/base64` check the same way it gained
`schema/enum` and the rest for HTTPRoute, purely additively — `format: byte` appears nowhere
else in any bundle, and `k8s/base64.ts` answers both halves of the question at once, since the
size cap needs the decoded length of exactly the values that decode. Deliberately skipped: the
immutability of `data` and `binaryData` once `immutable: true` has been applied, which — like a
StorageClass's `provisioner` — only constrains an update. Nothing is version-gated: core/v1
ConfigMap has carried all three fields since well before the 1.25 floor.

`secret.ts` is the tenth, and the third kind with **no `spec`**: like `configmap.ts` it reads
`ctx.doc`, since `data`, `stringData`, `type` and `immutable` are document-root fields, and its
key-format checks are the same ones `configmap.ts` uses — `isConfigMapKey` and the relative-path
check are shared out of `k8s/names.ts` rather than duplicated, and the 1 MiB `MaxSecretSize` cap
is shared out of `k8s/base64.ts` as `MAX_SECRET_SIZE_BYTES`, since the apiserver checks a
Secret's keys and size with the very same functions it checks a ConfigMap's with. Where it
diverges is `stringData`: the apiserver merges it into `data` before anything else runs, with
`stringData`'s value winning on a shared key, so this module builds that merged view once and
every check — key format, the size cap, the type-specific checks below — reads it rather than
either map alone. A key claimed by both is not itself rejected the way a ConfigMap's overlapping
`data`/`binaryData` is; it is `secret/overlapping-key`, a warning, since the object is still
created and `stringData` simply wins silently. The rest of what `ValidateSecret` checks beyond
key format and size turns on `type`: `kubernetes.io/tls` requires `tls.crt` and `tls.key` to be
*present* (empty is fine), `kubernetes.io/basic-auth` requires `username` or `password` to be
*non-empty* (present-but-empty does not count), `kubernetes.io/ssh-auth` requires a non-empty
`ssh-privatekey`, `kubernetes.io/dockercfg` and `kubernetes.io/dockerconfigjson` each require
their one key non-empty and decoding to a JSON object (`k8s/base64.ts` gained `decodeBase64` for
this — the first place in the codebase that needs a base64 value's *content* rather than just
its decoded length), and `kubernetes.io/service-account-token` requires a non-empty
`kubernetes.io/service-account.name` annotation. `type` is deliberately absent from
`rules/enums.ts`: arbitrary third-party types are legal, so a value close to one of the
well-known spellings is reported as `secret/unknown-type`, a warning with a `didYouMean` fix,
rather than a hard enum rejecting anything unrecognised. Deliberately skipped: the immutability
of `data`/`stringData` once `immutable: true` is set, which — like a ConfigMap's — only
constrains an update, and the internal structure of a type `ValidateSecret` does not itself
check, such as `bootstrap.kubernetes.io/token`, which a controller validates rather than this
function. Nothing is version-gated: core/v1 Secret has carried `data`, `stringData`, `type` and
`immutable` since well before the 1.25 floor.

`resourcequota.ts` is the eleventh, and the kind whose rules turn almost entirely on the *keys*
of a map rather than on fields: `spec.hard` is a `map[string]Quantity`, so layer 1 covers only
that a value parses as a quantity, and everything else — which names may be bounded, which of
those must be whole numbers — is the module's. The name set is narrower than a container's, so
it is written out here rather than shared with `rules/resources.ts`: a quota counts objects
(`pods`, `secrets`, `count/deployments.apps`) as well as compute, and spells compute three ways,
`cpu` being shorthand for `requests.cpu`. Scopes are the other half, and they are checked in two
places at once, since a scope reached through `spec.scopes` and one reached through
`spec.scopeSelector.matchExpressions` are validated identically upstream: both may not pair
`Terminating` with `NotTerminating` or `BestEffort` with `NotBestEffort` (each pair selects
complementary sets of Pods, so together they select none), and neither may bound a resource the
Pods it selects do not consume. Like a NetworkPolicy's `policyTypes`, `spec.scopes` is a list of
enum strings and so cannot go in the `enums.ts` table at all; the selector's `scopeName` and
`operator` are scalars and do, which is why the module skips a requirement whose `scopeName` it
does not recognise — `enum/invalid-value` has already reported it. Deliberately skipped:
`status`, whose `hard` and `used` the quota controller writes rather than the manifest. Nothing
is version-gated: core/v1 ResourceQuota has carried all three spec fields since before the 1.25
floor.

`limitrange.ts` is the twelfth, and the closest neighbour `resourcequota.ts` has — both bound
resources by name, and both are checked almost entirely on the *keys* of a map rather than on
fields. What layer 1 covers here is more than it covers for a quota: `spec.limits` is required
and so is each item's `type`, and every one of the five constraint maps is a
`map[string]Quantity` whose values it checks parse. `LimitRangeItem.type` is a plain scalar
enum and lives in `rules/enums.ts` — the one entry in that table for a field
`ValidateLimitRange` does *not* itself check, since an unrecognised type is stored rather than
rejected and simply never matches anything the LimitRanger admission plugin looks for, which
makes it a misconfiguration rather than an apiserver error. What is left to the module is what
OpenAPI cannot express: the same `type` twice, the `default`/`defaultRequest` maps a `Pod`-typed
item may not carry at all (a Pod entry bounds the total across its containers, and defaults are
filled in per container), the storage bound a `PersistentVolumeClaim`-typed one must carry, the
resource names that may be bounded, and the six orderings one resource's constraints must
satisfy — in effect `min <= defaultRequest <= default <= max`, spelled out as the six pairs
upstream compares since any one can be violated alone, each reported on the field upstream
blames rather than on the greater of the two. Its resource-name set is *not* the quota's:
`validateResourceName` checks an unprefixed name against `standardResources`, which is
`standardQuotaResources` plus bare `storage` — a LimitRange bounds a claim's size directly where
a quota only ever sums it as `requests.storage` — so the list is written out here rather than
shared, exactly as `resourcequota.ts` writes its own out rather than sharing with
`rules/resources.ts`. The last check is the one that is not about ordering at all: a resource
that cannot be overcommitted (an extended resource, or hugepages) is handed out whole, so its
`default` and `defaultRequest` have to be *equal* rather than merely ordered. Deliberately
skipped: a negative quantity, which upstream does not check for here — the inverse of a
ResourceQuota, whose ceilings it does. Nothing is version-gated: core/v1 LimitRange has been
unchanged since well before the 1.25 floor.

`serviceaccount.ts` is the thirteenth, the fourth kind with **no `spec`** — `secrets`,
`imagePullSecrets` and `automountServiceAccountToken` are document-root fields, so like
`configmap.ts` and `secret.ts` it reads `ctx.doc` — and the kind with the least apiserver
validation of any here by a wide margin: `ValidateServiceAccount` checks the object's metadata
and *nothing else*, so `meta/*` already covers everything that can be rejected and the module
contains **not one error-severity finding**. It is the first module whose entire subject is the
gap between what a manifest says and what the cluster keeps, and two upstream mechanisms
account for all of it. The registry's `PrepareForCreate` calls `cleanSecretReferences`, which
rewrites every `secrets` entry to `ObjectReference{Name}` before validation runs — so a
`namespace`, `kind`, `uid`, `apiVersion`, `resourceVersion` or `fieldPath` written beside the
name is discarded silently and the object is stored differently from how it was applied, which
is `serviceaccount/ignored-secret-field` with a *safe* delete fix, since the apiserver performs
that delete itself. And the `kubernetes.io/enforce-mountable-secrets` annotation is read with
`strconv.ParseBool` whose error the admission plugin throws away, so a value it cannot parse
leaves enforcement quietly *off* rather than failing — the same shape of quirk as
`ingressclass.ts`'s default-class annotation, but with the twelve ParseBool spellings in place
of one exact string, so `"True"` is fine here where it is not there. That annotation is also
where the codebase's only version-conditional *report* lives (see the feature-gating note
above). Both lists reference a Secret by name in the same namespace and so share
`checkReferenceName`, which is where the missing and un-Secret-like names are reported.
Duplicates are checked in `imagePullSecrets` **only**: upstream declares `secrets` an
`x-kubernetes-list-type: map` keyed by name from 1.30 on, so layer 1 already reports a
duplicate there as `schema/duplicate-list-entry` and checking it here would double-report on
exactly the versions that describe it — that split is pinned in `tests/versions.test.ts` as
upstream's own drift, the way NetworkPolicy's `podSelector` drift is, rather than papered over.
The kind has no enum field at all, so it is the first to add nothing to `rules/enums.ts`.
Deliberately skipped: `automountServiceAccountToken`, a bare bool whose only constraint is its
type, and the emptiness of `secrets` itself, which is normal from 1.24 on — tokens stopped
being auto-created then, so the list is usually absent rather than wrong.

`role.ts` is the fourteenth, the fifth kind with **no `spec`** — `rules` is a document-root
field, so like `configmap.ts`, `secret.ts` and `serviceaccount.ts` it reads `ctx.doc` — and the
first kind whose *name* is not a DNS name of some sort: `ValidateRBACName` is
`path.IsValidPathSegmentName` and nothing else, which is why the descriptor carries
`nameFormat: 'path-segment'` (see above) and why `system:controller:token-cleaner` and `MyRole`
are both legal. What `ValidateRole` checks past the metadata is short — `validatePolicyRule`
per entry — and layer 1 already covers a quarter of it: `verbs` is the only name in
PolicyRule's `required` list, so an absent one is `schema/required-field` and only an *empty*
one is `role/missing-verbs`, the same "an empty list where a missing one would have been
caught" split `ingress.ts` documents. The other three rejections are the module's, `apiGroups`
and `resources` because the schema does not require them and `nonResourceURLs` because a
namespaced rule may not carry one at all — and that last check keeps upstream's early return
with it, since `validatePolicyRule` stops after the non-resource branch rather than going on to
ask a URL rule for an api group.

Everything past those four is the wider half, and it is unusually wide here because RBAC
validates a Role's *contents* almost not at all: a policy rule is five lists of free strings
with no enum, no format and no cross-reference to the resources a cluster actually serves, so a
misspelt verb, a resource written as its `kind`, or a name restriction on a verb that carries no
name is stored exactly as written and then silently matches nothing. Every one of those is a
warning — the object is created, the RoleBinding resolves, and the only symptom is a
"forbidden" that arrives much later from somewhere else. Three of them turn on how RBAC
compares an entry rather than on the entry itself: `resourceNames` is matched by plain string
equality, so a `*` there asks for an object literally named `*` rather than for any of them
(`role/wildcard-resource-name`), and it is compared against the object name in the *request
path*, which a `create` and a `deletecollection` do not carry — so pairing either with
`resourceNames` grants nothing (`role/unrestrictable-verb`, and a `*` in `verbs` is deliberately
left alone, since that reading is the expected one rather than a mistake). The rest is list
hygiene shared across all four lists by one function: a repeated entry, an entry a `*` beside it
already covers, and an empty string — which is a *value* in `apiGroups`, where it spells the
core group, and only there. `role/unknown-verb` follows `secret/unknown-type` exactly: an
aggregated apiserver may define verbs of its own, so an unrecognised one is reported only when
`didYouMean` finds a near-miss, never as a hard enum. The kind has no scalar enum field at all —
`verbs`, `apiGroups` and `resources` are lists of strings, which `walkFields` hands `enumRule`
whole, the same reason a NetworkPolicy's `policyTypes` cannot go in that table — so like
ServiceAccount it adds nothing to `rules/enums.ts`. Deliberately skipped: whether a named
resource, api group or verb actually exists, which is a question about the API surface one
cluster serves rather than about the document. Nothing is version-gated: rbac/v1 has been
served unchanged since 1.8.

`clusterrole.ts` is the fifteenth, the sixth kind with **no `spec`**, and the first whose
checks are almost entirely *another module's*: upstream validates a Role's rules and a
ClusterRole's with one `validatePolicyRule` taking an `isNamespaced` flag, and that flag is
consulted in exactly one place, so `role.ts` exports `checkPolicyRules(ctx, owner)` and this
module supplies a `PolicyRuleOwner` carrying that one branch, the noun its messages name, and
whether an empty rule list is worth reporting. Everything else — the missing-field errors, the
list hygiene, the verb and resource advice — runs unchanged and keeps its `role/*` ids, exactly
as a CronJob's nested JobSpec keeps `job/*` ones: the id names the validator a check comes
from, not the kind the document declares. The third `PolicyRuleOwner` field is what an
aggregated ClusterRole needs: its `rules` are written by a controller, so a manifest that omits
them is correct rather than empty and `role/no-rules` has to sit out.

What is left is the two things a ClusterRole has that a Role does not. The first is legal
`nonResourceURLs`, where a Role's flat rejection becomes a narrower one — a rule may name URLs
or resources, never both — and then three findings about a rule the apiserver stores happily:
`NonResourceURLMatches` compares an entry to the request path by equality, or by prefix when it
ends in `*`, and by nothing else, so a URL without the leading slash and a `*` anywhere but last
each match no request that will ever arrive. The third is the verbs beside them, and it is why
the verb list check moved *after* the non-resource branch rather than before it: a non-resource
request never reaches the mapping that derives the eight RBAC verbs from a path's shape, so it
keeps the verb `RequestInfoFactory` gave it at the top — its HTTP method, lowercased — and
`list`, `watch` and `create` beside a URL grant nothing however natural they look. Each owner
therefore states its own verb vocabulary through `checkList`'s per-entry hook, and a Role's URL
rule still measures its verbs the way every other rule here does.

The second is `aggregationRule`, which is not a permission but an instruction: the field's own
description says the rules become "controller managed and direct changes to Rules will be
stomped by the controller", so rules written beside it, a rule listing no selectors at all (it
aggregates nothing, and the controller then keeps the list empty), and a selector that is empty
(a `LabelSelector` imposing no requirement matches every ClusterRole in the cluster, which is
the opposite of what a blank one looks like it means) are all warnings about a manifest that
says one thing and stores another. Its selectors go through `selector.ts`'s `checkRequirement`
and `metadata.ts`'s `checkKeyedMap`, the same helpers a NetworkPolicy's peers use. The kind has
no scalar enum field either, so like Role and ServiceAccount it adds nothing to
`rules/enums.ts`. Deliberately skipped: whether the selectors match any ClusterRole the cluster
actually holds, for the same reason `role.ts` does not ask whether a named resource exists.
Nothing is version-gated: `aggregationRule` has been served unchanged since 1.9, and upstream's
marking of `rules` as an atomic list from 1.30 changes nothing, atomic not being the map type
that would make layer 1 look for duplicates.

`rolebinding.ts` is the sixteenth, the seventh kind with **no `spec`** — `roleRef` and
`subjects` are document-root fields — and the one whose validator turns least on the document
and most on what the apiserver has already done to it. `ValidateRoleBinding` is short: the
metadata, the three fields of `roleRef`, then `ValidateRoleBindingSubject` per entry. But two
defaulting functions run first, and between them they decide most of what this module may say.
`SetDefaults_RoleBinding` fills a zero-length `roleRef.apiGroup` in with the RBAC group, and
`SetDefaults_Subject` fills a zero-length subject `apiGroup` in from the subject's `kind` — `""`
for a ServiceAccount, the RBAC group for a User or a Group — so on **both** fields an absent
value and an explicit `""` are correct on every kind, and only a value written by hand can be
wrong. That is the StorageClass `volumeBindingMode` trap twice over, and the exact inverse of
the Job `restartPolicy` case where the default is itself invalid; getting it backwards here
would report an error on the most ordinary RoleBinding there is.

Layer 1 covers the required half — `roleRef` on the binding, `kind` and `name` on both a
`RoleRef` and a `Subject` — which leaves this module the same "an empty string where a missing
key would have been" split `ingress.ts` and `role.ts` document, since upstream asks for a
*length* where the schema asks for a key. The two `kind` fields are scalar enums whose invalid
values the apiserver rejects outright, so unlike the three RBAC kinds before it this one does
add to `rules/enums.ts` (`RoleRef.kind`, `Subject.kind`) rather than hand-checking them — and
the module then skips a subject whose kind it does not recognise, the way `resourcequota.ts`
skips a requirement with an unknown `scopeName`. The name formats are the last rejection and
they are deliberately three different things: the binding's own name and its `roleRef.name` are
RBAC names and so path segments, a ServiceAccount subject's name is validated as a
ServiceAccount's own name and so a DNS subdomain, and a User or Group name is not checked at
all, those coming from an authenticator rather than from an object the cluster holds.

What is left is what the apiserver stores and the authorizer then never reads. The widest is a
`namespace` beside a User or a Group: `appliesToUser` matches a User by name and a Group by
membership, consulting the field for neither, and nothing strips it — the `Subject` type's own
description says an authorizer "should report an error" for it, and none does. Beside that sit
a repeated subject (matching stops at the first one the request's user answers to) and a
binding with no subjects at all, which grants its role to nobody. Deliberately skipped: whether
the referenced role or a named ServiceAccount exists, for the same reason `role.ts` does not ask
whether a named resource does; the immutability of `roleRef`, which only constrains an update;
and a **ServiceAccount subject's absent namespace**, which is not a mistake but the idiom — for
a RoleBinding the authorizer defaults it to the binding's own namespace. Nothing is
version-gated: rbac/v1 has been served unchanged since 1.8.

Unlike every other kind, HTTPRoute's schema carries `enum`, `pattern`, `minLength`/`maxLength`
and `minItems`/`maxItems` directly — a CRD's OpenAPI schema is generated from Go kubebuilder
markers, unlike the hand-written Kubernetes API types the other seventeen kinds come from, where
`rules/enums.ts`'s doc comment already explains why the *k8s* schema never carries `enum`.
Rather than hand-write checks layer 1 can already derive from those keywords, `schema.ts`
gained generic support for all five (`schema/enum`, `schema/pattern`, `schema/string-length`,
`schema/out-of-range`, `schema/list-size`), purely additively — no k8s bundle definition sets
any of them, so the other fifteen kinds are unaffected. That leaves `httproute.ts` with only
what the CRD's schema cannot express at all: its `x-kubernetes-validations` (CEL) rules, which
`generate-schema.mjs` strips during flattening since layer 1 cannot evaluate CEL, and which are
reimplemented by hand instead — filter `type` agreeing with its populated field, `parentRefs`
sharing a parent needing distinct `sectionName`s, a `ReplacePrefixMatch` rewrite needing exactly
one `PathPrefix` match, a Service `backendRef` needing a `port`, and the rest of the checks in
the rule table above. A match path's character-set and `/../`-style restrictions are CEL-only
too — they would have to vary the field's own `pattern` with a sibling `type`, which OpenAPI
cannot express — so they are hand-checked the same way `rules/ingress.ts` checks an Ingress
path. Deliberately skipped: anything CEL only bounds for its own sake without describing a
contradiction, mirroring how `job.ts` skips the size caps that only bound `.status`.

**Adding a further kind**, in order:

1. A root in `ROOTS` (`scripts/generate-schema.mjs`), then `npm run gen:schema` to regenerate
   and commit *every* version bundle. Generation throws if the definition is missing from any
   supported release, so a kind younger than the `OLDEST_MINOR` floor cannot be added without
   moving that floor.
2. A descriptor in `KINDS` (`src/lint/kinds.ts`) — for anything carrying a PodTemplateSpec that
   is the shared `POD_TEMPLATE` constant, plus `nameFormat`/`claimTemplatesPath`/`clusterScoped`
   if the kind needs them. For a kind that describes no Pod, leave `podTemplate` out entirely;
   that is the whole switch.
3. A rule module `src/lint/rules/<kind>.ts` for the kind's own fields, with `<kind>/*`
   rule IDs, wired into that descriptor's `rules` — *not* into `RULES` or `POD_RULES` in
   `registry.ts`, which are the every-kind and every-pod-kind lists. Nothing is needed for the
   PodSpec of a kind that has one: the shared rules already run.
4. Enum entries in `rules/enums.ts` for the kind's own enum fields, keyed
   `<Definition>.<field>` — upstream's OpenAPI carries no enum values, so the table is hand-kept.
5. Tests and copy: helpers and a valid manifest in `tests/helpers.ts`, pinned across versions in
   `tests/versions.test.ts` (which also asserts `schema.kinds` exactly, so its list changes,
   as does `tests/schema.test.ts` — it pins that list and uses a kind the bundle does *not*
   carry to exercise `lint/unsupported-kind`), an example appended to `EXAMPLES`
   (`src/ui/examples.ts`), and the kind names in `index.html`, `README.md` and in the
   `lint/unsupported-kind` explanation in `src/lint/index.ts`.

The reusable machinery — the schema walk, `walkFields`,
`enums.ts`, `fix.ts`, `parse.ts`, `k8s/*` — is kind-agnostic; `walkFields` keys on the resolved
`$ref` owner (`Container.imagePullPolicy`), so it stays correct wherever a type is reused.

### Schema bundles

`scripts/generate-schema.mjs` unions the transitive `$ref` closure of every root in `ROOTS`
(245 defs at 1.36 from the k8s swagger, plus ~22 more flattened from the HTTPRoute CRD — see
above — for 267 total, ~55 KB brotli with descriptions intact) and writes `{ k8sVersion, source,
generatedAt, gatewayApiVersion, roots, definitions }`. `gatewayApiVersion` is the one field on
that record HTTPRoute owns and nothing else does, recording the pinned Gateway API release its
definitions came from — a second provenance, since `k8sVersion`/`source` describe only the k8s
swagger half. One file per version rather than one per kind: the Deployment
closure is a near-total superset of Pod's, the StatefulSet one adds little beyond
`PersistentVolumeClaim`, the DaemonSet one adds only its own spec and update strategy, and the
Job one only its spec and the two policies hanging off it, so per-kind files would be
near-duplicates. CronJob costs almost nothing on top of Job: its spec only wraps a
JobTemplateSpec around the JobSpec the Job root already reaches, so it adds just `CronJob`,
`CronJobSpec`, `CronJobStatus` and `JobTemplateSpec`. Service, Ingress and IngressClass are roots
that share nothing below `ObjectMeta`, and the first two still add only about a dozen definitions
each while IngressClass adds two. PersistentVolumeClaim is the cheapest root of all: everything
below its spec is already pulled in by StatefulSet's `volumeClaimTemplates`, so it adds only the
`PersistentVolumeClaim` and `PersistentVolumeClaimStatus` wrapper definitions themselves.
PersistentVolume is the one root that is *not* nearly free: it shares its metadata and
access-mode types with the claim, but its spec carries the *PersistentVolumeSource* variant of
every in-tree volume plugin — types a Pod's inline `VolumeSource` closure never reaches — which
widens the bundle by about 16 definitions on every version. StorageClass is back to cheap, and
is the only root outside core/v1, apps/v1, batch/v1 and networking/v1: below its own definition
it reaches `TopologySelectorTerm` and `TopologySelectorLabelRequirement` and nothing else.
NetworkPolicy is cheap too, and the reason is the same as CronJob's: it shares `LabelSelector`,
`LabelSelectorRequirement`, `IntOrString` and `ObjectMeta` with roots already in the closure, so
it adds only its own seven definitions — `NetworkPolicy`, `NetworkPolicySpec`,
`NetworkPolicyIngressRule`, `NetworkPolicyEgressRule`, `NetworkPolicyPeer`, `NetworkPolicyPort`
and `IPBlock` — an eighth, `NetworkPolicyStatus`, on the 1.25-1.27 bundles only, since upstream
dropped the field from the type in 1.28. ConfigMap and Secret are the cheapest roots of them
all: ConfigMap's `data` and `binaryData` are plain string maps and Secret's `data` and
`stringData` are too, so below `ObjectMeta` each reaches nothing and the closure grows by its
own definition alone. ResourceQuota is nearly as cheap: its `hard` and `used` maps are
`Quantity` maps, a type the Pod closure already carries, so it adds only its own definition, its
spec, its status and the two scope-selector definitions. LimitRange is cheaper still, and for
the same reason: its five constraint maps are `Quantity` maps too, so it adds only its own
definition, its spec and `LimitRangeItem`. ServiceAccount is the cheapest root of the lot: it
has no spec definition to add either, and both reference types it needs are already in the
closure — `ObjectReference` through a PersistentVolume's `claimRef`, `LocalObjectReference`
through a PodSpec's own `imagePullSecrets` — so it widens the bundle by exactly one definition,
its own. Role is the first root outside core/v1, apps/v1, batch/v1, networking/v1 and
storage/v1, and it shares nothing below `ObjectMeta` with any of them — but there is nothing to
share: a `PolicyRule` is five lists of plain strings, so the closure grows by `Role` and
`PolicyRule` alone. ClusterRole is then the second-cheapest root of all, for CronJob's reason:
it holds the very same `PolicyRule` list Role already reached, and its one field beyond that
hangs a `LabelSelector` the Deployment closure has carried all along — so it adds `ClusterRole`
and `AggregationRule` and nothing else. RoleBinding is the last of the three and the only one
that shares nothing at all with the other two: a `RoleRef` and a `Subject` are flat records of
plain strings that no other root reaches, so it adds exactly `RoleBinding`, `RoleRef` and
`Subject`. API descriptions are kept on
purpose — they are what the hover tooltip and most `explanation` fields render.

Definitions that are objects in the spec but scalars on the wire (`Quantity`, `IntOrString`,
`Time`) are listed in `SCALAR_DEFINITIONS` in `schema.ts` and validated specially; validating
them property-by-property would produce nonsense.

## Conventions

- TypeScript is strict, including `noUncheckedIndexedAccess`, `noUnusedLocals` and
  `verbatimModuleSyntax`. Relative imports carry a `.js` extension. `scripts/` is outside
  `tsconfig.json` and is not typechecked.
- Rules never re-report what layer 1 already caught. Everything out of YAML is `unknown`;
  narrow with `asString`/`asNumber`/`asObject`/`asArray` from `rules/context.ts` and skip
  wrong-shaped values silently.
- Rule IDs are `pod/<thing>` for PodSpec checks and `deployment/<thing>` / `statefulset/<thing>`
  / `daemonset/<thing>` / `job/<thing>` / `cronjob/<thing>` / `service/<thing>` /
  `ingress/<thing>` / `ingressclass/<thing>` / `persistentvolume/<thing>` /
  `persistentvolumeclaim/<thing>` / `storageclass/<thing>` / `networkpolicy/<thing>` /
  `serviceaccount/<thing>` /
  `configmap/<thing>` / `secret/<thing>` / `resourcequota/<thing>` / `limitrange/<thing>` /
  `role/<thing>` / `clusterrole/<thing>` / `rolebinding/<thing>` / `httproute/<thing>` for
  checks on the object itself; the
  rules that run for every kind are `meta/<thing>` and `enum/<thing>`; schema-layer IDs are
  `schema/<thing>`; parser IDs are `yaml/<thing>`.
- Findings explain *why*, usually by quoting the field's own API description and pulling its
  "More info:" URL via `docsUrlFrom()`.
- Comments in this codebase explain non-obvious decisions rather than restating code. Match
  that when editing.
- `EXAMPLES` in `src/ui/examples.ts` is load-bearing: `tests/locations.test.ts` iterates it
  (the `valid` example must lint clean, others must not, and safe fixes must not make things
  worse) and indexes entries positionally, so append rather than insert. `tests/versions.test.ts`
  lints `valid`, `VALID_DEPLOYMENT` and `VALID_STATEFULSET` on all 12 versions as a regeneration
  tripwire.
