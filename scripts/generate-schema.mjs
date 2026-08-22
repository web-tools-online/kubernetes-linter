#!/usr/bin/env node
/**
 * Extracts the schemas the linter understands from the Kubernetes OpenAPI
 * spec, one file per supported minor version.
 *
 * The upstream swagger.json is ~4 MB and covers 500-770 definitions depending
 * on the release. Everything reachable from the roots below is only ~120-160
 * of them (~35 KB brotli with descriptions intact), which is small enough to
 * ship to the browser. The descriptions are what let the UI explain a field in
 * the API's own words, so they are kept.
 *
 * One bundle carries every root because the closures overlap almost entirely:
 * a Deployment reaches PodSpec through PodTemplateSpec, and a StatefulSet adds
 * little beyond its own spec plus PersistentVolumeClaim, so the union is only
 * a dozen or so definitions wider than Pod's alone. A Job is the same story —
 * it reaches PodSpec the same way and adds only its own spec, its failure and
 * success policies and their rules. A CronJob costs almost nothing on top of
 * that: its spec wraps a JobTemplateSpec around the same JobSpec a Job already
 * reaches, so the closure only grows by CronJob, CronJobSpec, CronJobStatus and
 * JobTemplateSpec. Service is the one root that shares nothing below metadata,
 * and it still costs under ten definitions; IngressClass costs two, both of
 * them its own. PersistentVolumeClaim costs nothing at all: everything below
 * its spec is already pulled in by StatefulSet's volumeClaimTemplates, so the
 * closure only grows by the PersistentVolumeClaim and PersistentVolumeClaimStatus
 * wrapper definitions. PersistentVolume is the one root that is not nearly
 * free: it shares its metadata and access-mode types with the claim, but its
 * spec carries the *PersistentVolumeSource* variant of every in-tree volume
 * plugin (CSIPersistentVolumeSource, ISCSIPersistentVolumeSource, and so on) —
 * types the PodSpec closure never reaches, since a Pod only ever sees the
 * inline VolumeSource form. That widens the bundle by about 16 definitions.
 * StorageClass is back to cheap: it is the only root outside core/v1, apps/v1,
 * batch/v1 and networking/v1, but below its own definition it reaches just
 * TopologySelectorTerm and TopologySelectorLabelRequirement — three in total.
 * ConfigMap is the cheapest root there is: its data and binaryData are plain
 * string maps, so below ObjectMeta it reaches nothing at all and the closure
 * grows by exactly one definition, its own. Secret is exactly as cheap and for
 * the same reason: data and stringData are plain string maps too, and type and
 * immutable are scalars, so it also adds only its own definition. ResourceQuota
 * is nearly as cheap: its hard and used maps are Quantity maps, a type the Pod
 * closure already carries, so below ObjectMeta it adds only its own spec,
 * status and the two scope-selector definitions. LimitRange is cheaper still,
 * and for the same reason: its five constraint maps are Quantity maps too, so
 * it adds only its own definition, its spec and LimitRangeItem. ServiceAccount
 * is the cheapest of all: it has no spec definition either, and both reference
 * types it needs are already in the closure - ObjectReference through a
 * PersistentVolume's claimRef, LocalObjectReference through a PodSpec's own
 * imagePullSecrets - so it adds its own definition and nothing else. Role is
 * the first root outside core/v1, apps/v1, batch/v1, networking/v1 and
 * storage/v1, and it shares nothing below ObjectMeta with any of them, but
 * there is barely anything to share: a PolicyRule is five lists of plain
 * strings, so the closure grows by Role and PolicyRule alone.
 * Separate per-kind files would be near-duplicates, and a single bundle also
 * means lint() can switch kinds mid-document without loading anything.
 *
 * Usage:
 *   node scripts/generate-schema.mjs                # every supported version
 *   node scripts/generate-schema.mjs 1.37           # one version
 *   node scripts/generate-schema.mjs 1.30 1.31      # a list
 *
 * Gateway and HTTPRoute are not in that swagger.json at all - Gateway API
 * ships as CRDs from kubernetes-sigs/gateway-api, released independently of
 * Kubernetes itself. Their schemas are fetched from one pinned Gateway API
 * release (see GATEWAY_API_VERSION below) and embedded in every k8s bundle
 * unchanged, since installing the CRDs does not track the cluster's minor
 * version. The two share one pool of definitions, so a type both reach -
 * a Gateway's listener kinds and an HTTPRoute's parentRefs both name the same
 * group/kind pair - is extracted once.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

/**
 * Kind name -> definition. The kind names are the contract with
 * `src/lint/kinds.ts`, which pairs each with the path to its pod spec.
 */
const ROOTS = {
  Pod: 'io.k8s.api.core.v1.Pod',
  Deployment: 'io.k8s.api.apps.v1.Deployment',
  StatefulSet: 'io.k8s.api.apps.v1.StatefulSet',
  DaemonSet: 'io.k8s.api.apps.v1.DaemonSet',
  Job: 'io.k8s.api.batch.v1.Job',
  CronJob: 'io.k8s.api.batch.v1.CronJob',
  Service: 'io.k8s.api.core.v1.Service',
  Ingress: 'io.k8s.api.networking.v1.Ingress',
  IngressClass: 'io.k8s.api.networking.v1.IngressClass',
  PersistentVolume: 'io.k8s.api.core.v1.PersistentVolume',
  PersistentVolumeClaim: 'io.k8s.api.core.v1.PersistentVolumeClaim',
  StorageClass: 'io.k8s.api.storage.v1.StorageClass',
  NetworkPolicy: 'io.k8s.api.networking.v1.NetworkPolicy',
  ConfigMap: 'io.k8s.api.core.v1.ConfigMap',
  Secret: 'io.k8s.api.core.v1.Secret',
  ResourceQuota: 'io.k8s.api.core.v1.ResourceQuota',
  LimitRange: 'io.k8s.api.core.v1.LimitRange',
  ServiceAccount: 'io.k8s.api.core.v1.ServiceAccount',
  Role: 'io.k8s.api.rbac.v1.Role',
  ClusterRole: 'io.k8s.api.rbac.v1.ClusterRole',
  RoleBinding: 'io.k8s.api.rbac.v1.RoleBinding',
  ClusterRoleBinding: 'io.k8s.api.rbac.v1.ClusterRoleBinding',
};

/**
 * 1.25 is the floor: it is the first release after PodSecurityPolicy was
 * removed, and covers what clusters in the wild still run. Older releases
 * would mean shipping long-dead APIs.
 */
const OLDEST_MINOR = 25;
const NEWEST_MINOR = 36;

/**
 * The one Gateway API release the Gateway API kinds are generated from,
 * standard channel. Bump this by hand to pick up a newer Gateway or
 * HTTPRoute; unlike the k8s versions above it does not vary per bundle.
 */
const GATEWAY_API_VERSION = 'v1.4.0';
const gatewayCrdUrl = (plural) =>
  `https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/${GATEWAY_API_VERSION}/config/crd/standard/gateway.networking.k8s.io_${plural}.yaml`;
const GATEWAY_DEFINITION_PREFIX = 'io.k8s.sigs.gateway-api.apis.v1.';

/**
 * Path inside the HTTPRoute CRD's openAPIV3Schema -> Gateway API Go type
 * name. A CRD inlines every type - it carries no `$ref` of its own - so the
 * names cannot be recovered from the document itself; this map is what keeps
 * the bundle's definition names, and therefore the `Owner.field` keys
 * `walkFields` produces and the short type name the hover tooltip shows,
 * equal to the API's own type names rather than anonymous inline objects. A
 * path missing from this map makes `flattenGatewayNode` throw, so a Gateway
 * API release that restructures the schema fails generation loudly instead
 * of silently losing a name. Every Gateway API kind carries one of these,
 * paired with the CRD it flattens in GATEWAY_CRDS below.
 *
 * The same Go type sits at more than one path here - HTTPRouteFilter and its
 * children appear once under `rules[].filters` and again under
 * `rules[].backendRefs[].filters`, and ParentReference appears once as a
 * request (`spec.parentRefs`) and once as a status echo
 * (`status.parents[].parentRef`) - which is exactly why one shared definition
 * is worth extracting rather than four; `flattenGatewayNode` checks the two
 * occurrences produce the same shape (ignoring description text) and throws
 * if a future release makes them diverge silently.
 */
const HTTPROUTE_TYPES = {
  '': 'HTTPRoute',
  spec: 'HTTPRouteSpec',
  'spec.parentRefs.[]': 'ParentReference',
  'spec.rules.[]': 'HTTPRouteRule',
  'spec.rules.[].matches.[]': 'HTTPRouteMatch',
  'spec.rules.[].matches.[].path': 'HTTPPathMatch',
  'spec.rules.[].matches.[].headers.[]': 'HTTPHeaderMatch',
  'spec.rules.[].matches.[].queryParams.[]': 'HTTPQueryParamMatch',
  'spec.rules.[].timeouts': 'HTTPRouteTimeouts',
  'spec.rules.[].backendRefs.[]': 'HTTPBackendRef',
  'spec.rules.[].filters.[]': 'HTTPRouteFilter',
  'spec.rules.[].filters.[].requestHeaderModifier': 'HTTPHeaderFilter',
  'spec.rules.[].filters.[].requestHeaderModifier.add.[]': 'HTTPHeader',
  'spec.rules.[].filters.[].requestHeaderModifier.set.[]': 'HTTPHeader',
  'spec.rules.[].filters.[].responseHeaderModifier': 'HTTPHeaderFilter',
  'spec.rules.[].filters.[].responseHeaderModifier.add.[]': 'HTTPHeader',
  'spec.rules.[].filters.[].responseHeaderModifier.set.[]': 'HTTPHeader',
  'spec.rules.[].filters.[].requestMirror': 'HTTPRequestMirrorFilter',
  'spec.rules.[].filters.[].requestMirror.backendRef': 'BackendObjectReference',
  'spec.rules.[].filters.[].requestMirror.fraction': 'Fraction',
  'spec.rules.[].filters.[].requestRedirect': 'HTTPRequestRedirectFilter',
  'spec.rules.[].filters.[].requestRedirect.path': 'HTTPPathModifier',
  'spec.rules.[].filters.[].urlRewrite': 'HTTPURLRewriteFilter',
  'spec.rules.[].filters.[].urlRewrite.path': 'HTTPPathModifier',
  'spec.rules.[].filters.[].extensionRef': 'LocalObjectReference',
  'spec.rules.[].backendRefs.[].filters.[]': 'HTTPRouteFilter',
  'spec.rules.[].backendRefs.[].filters.[].requestHeaderModifier': 'HTTPHeaderFilter',
  'spec.rules.[].backendRefs.[].filters.[].requestHeaderModifier.add.[]': 'HTTPHeader',
  'spec.rules.[].backendRefs.[].filters.[].requestHeaderModifier.set.[]': 'HTTPHeader',
  'spec.rules.[].backendRefs.[].filters.[].responseHeaderModifier': 'HTTPHeaderFilter',
  'spec.rules.[].backendRefs.[].filters.[].responseHeaderModifier.add.[]': 'HTTPHeader',
  'spec.rules.[].backendRefs.[].filters.[].responseHeaderModifier.set.[]': 'HTTPHeader',
  'spec.rules.[].backendRefs.[].filters.[].requestMirror': 'HTTPRequestMirrorFilter',
  'spec.rules.[].backendRefs.[].filters.[].requestMirror.backendRef': 'BackendObjectReference',
  'spec.rules.[].backendRefs.[].filters.[].requestMirror.fraction': 'Fraction',
  'spec.rules.[].backendRefs.[].filters.[].requestRedirect': 'HTTPRequestRedirectFilter',
  'spec.rules.[].backendRefs.[].filters.[].requestRedirect.path': 'HTTPPathModifier',
  'spec.rules.[].backendRefs.[].filters.[].urlRewrite': 'HTTPURLRewriteFilter',
  'spec.rules.[].backendRefs.[].filters.[].urlRewrite.path': 'HTTPPathModifier',
  'spec.rules.[].backendRefs.[].filters.[].extensionRef': 'LocalObjectReference',
  status: 'HTTPRouteStatus',
  'status.parents.[]': 'RouteParentStatus',
  'status.parents.[].parentRef': 'ParentReference',
};

/**
 * Subtrees replaced wholesale by a definition the k8s bundle already carries,
 * rather than flattened into a Gateway API type of their own: a CRD's
 * `metadata` is only `{ type: object }` in the schema, since the apiserver
 * validates ObjectMeta independently of any CRD's own schema, and a
 * RouteParentStatus's `conditions` are - field for field - meta/v1's
 * Condition, the same type a ServiceStatus already carries.
 */
const HTTPROUTE_SPECIAL_REFS = {
  metadata: 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta',
  'status.parents.[].conditions.[]': 'io.k8s.apimachinery.pkg.apis.meta.v1.Condition',
};

/** Path inside the Gateway CRD's openAPIV3Schema -> Gateway API Go type name. */
const GATEWAY_TYPES = {
  '': 'Gateway',
  spec: 'GatewaySpec',
  'spec.addresses.[]': 'GatewaySpecAddress',
  'spec.infrastructure': 'GatewayInfrastructure',
  'spec.infrastructure.parametersRef': 'LocalParametersReference',
  'spec.listeners.[]': 'Listener',
  'spec.listeners.[].allowedRoutes': 'AllowedRoutes',
  'spec.listeners.[].allowedRoutes.kinds.[]': 'RouteGroupKind',
  'spec.listeners.[].allowedRoutes.namespaces': 'RouteNamespaces',
  'spec.listeners.[].tls': 'ListenerTLSConfig',
  'spec.listeners.[].tls.certificateRefs.[]': 'SecretObjectReference',
  status: 'GatewayStatus',
  'status.addresses.[]': 'GatewayStatusAddress',
  'status.listeners.[]': 'ListenerStatus',
  'status.listeners.[].supportedKinds.[]': 'RouteGroupKind',
};

/**
 * A Gateway's `status` carries meta/v1 Conditions at two depths, and the
 * namespace selector under a listener's allowedRoutes is - field for field -
 * meta/v1's LabelSelector, the same type a Deployment's own selector is.
 */
const GATEWAY_SPECIAL_REFS = {
  metadata: 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta',
  'spec.listeners.[].allowedRoutes.namespaces.selector':
    'io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector',
  'status.conditions.[]': 'io.k8s.apimachinery.pkg.apis.meta.v1.Condition',
  'status.listeners.[].conditions.[]': 'io.k8s.apimachinery.pkg.apis.meta.v1.Condition',
};

/**
 * The Gateway API kinds, each with the CRD it is flattened from. They share
 * one pool of definitions, so a type both kinds reach is extracted once and
 * the shape check in `flattenGatewayNode` guards the reuse across kinds as
 * well as within one.
 */
const GATEWAY_CRDS = {
  HTTPRoute: { plural: 'httproutes', types: HTTPROUTE_TYPES, specialRefs: HTTPROUTE_SPECIAL_REFS },
  Gateway: { plural: 'gateways', types: GATEWAY_TYPES, specialRefs: GATEWAY_SPECIAL_REFS },
};

/**
 * Flatten one node of a CRD's inlined openAPIV3Schema into the same
 * SchemaNode shape the k8s swagger definitions use: named object subtrees
 * become `$ref`s into `defs`, everything else - arrays, scalars with their
 * `enum`/`pattern`/length/bound keywords - is copied inline. `path` is the
 * dotted, `[]`-suffixed address used to look up the two maps `crd` carries.
 *
 * `x-kubernetes-validations` (CEL) is deliberately dropped: layer 1 cannot
 * evaluate CEL, so those checks are reimplemented by hand in
 * `src/lint/rules/httproute.ts` and `src/lint/rules/gateway.ts` instead.
 * `default` is dropped too - nothing in the linter reads it, and keeping it
 * would imply a promise this project does not make.
 */
function flattenGatewayNode(node, path, defs, crd) {
  if (!node || typeof node !== 'object') return node;

  const special = crd.specialRefs[path];
  if (special) return { $ref: `#/definitions/${special}` };

  if (node.type === 'array') {
    const out = { type: 'array' };
    if (node.description) out.description = node.description;
    if (node.items) out.items = flattenGatewayNode(node.items, `${path}.[]`, defs, crd);
    if (node.minItems !== undefined) out.minItems = node.minItems;
    if (node.maxItems !== undefined) out.maxItems = node.maxItems;
    if (node['x-kubernetes-list-type']) out['x-kubernetes-list-type'] = node['x-kubernetes-list-type'];
    if (node['x-kubernetes-list-map-keys']) {
      out['x-kubernetes-list-map-keys'] = node['x-kubernetes-list-map-keys'];
    }
    return out;
  }

  if (node.type === 'object' && (node.properties || node.additionalProperties)) {
    const body = { type: 'object' };
    if (node.description) body.description = node.description;
    if (node.required && node.required.length > 0) body.required = node.required;
    if (node.properties) {
      body.properties = {};
      for (const [key, child] of Object.entries(node.properties)) {
        body.properties[key] = flattenGatewayNode(child, path ? `${path}.${key}` : key, defs, crd);
      }
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      body.additionalProperties = flattenGatewayNode(
        node.additionalProperties,
        `${path}.*`,
        defs,
        crd,
      );
    }

    // A map - additionalProperties and no properties of its own - is a field's
    // type rather than a named Go struct (a Gateway's infrastructure labels,
    // a listener's TLS options), so it stays inline the way the k8s swagger
    // keeps its own string maps, and needs no entry in the type map.
    if (!node.properties) return body;

    const typeName = crd.types[path];
    if (typeName === undefined) {
      throw new Error(`generate-schema: no type-map entry for ${crd.kind} path "${path}"`);
    }

    const defName = `${GATEWAY_DEFINITION_PREFIX}${typeName}`;
    const withoutDescriptions = (value) =>
      JSON.stringify(value, (key, v) => (key === 'description' ? undefined : v));
    const existing = defs[defName];
    if (existing) {
      if (withoutDescriptions(existing) !== withoutDescriptions(body)) {
        throw new Error(
          `generate-schema: ${crd.kind} path "${path}" maps to "${typeName}", but an earlier ` +
            'path mapping to the same name has a different shape',
        );
      }
    } else {
      defs[defName] = body;
    }
    return { $ref: `#/definitions/${defName}` };
  }

  const out = {};
  for (const key of ['type', 'format', 'description', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  return out;
}

/**
 * Fetch and flatten every Gateway API CRD once, into one shared pool of
 * definitions. They do not vary per k8s minor, so every bundle embeds the
 * same result.
 */
async function buildGatewayDefinitions() {
  const definitions = {};
  const roots = {};

  for (const [kind, entry] of Object.entries(GATEWAY_CRDS)) {
    const url = gatewayCrdUrl(entry.plural);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed for the ${kind} CRD: ${res.status} ${res.statusText}`);
    const crd = parseYAML(await res.text());
    const v1 = crd.spec.versions.find((version) => version.name === 'v1');
    if (!v1) throw new Error(`the ${kind} CRD does not serve v1`);

    flattenGatewayNode(v1.schema.openAPIV3Schema, '', definitions, { ...entry, kind });

    const rootRef = `${GATEWAY_DEFINITION_PREFIX}${kind}`;
    // Not in the CRD at all - a CRD's schema does not carry a GVK extension,
    // since the CustomResourceDefinition object beside it already says what
    // group, version and kind it serves. KindSchema.apiVersion falls back to a
    // bare "v1" when this is absent, so it has to be synthesised here.
    definitions[rootRef]['x-kubernetes-group-version-kind'] = [
      { group: 'gateway.networking.k8s.io', version: 'v1', kind },
    ];
    roots[kind] = rootRef;
  }

  return { roots, definitions };
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'schema');

const versions =
  process.argv.length > 2
    ? process.argv.slice(2)
    : Array.from({ length: NEWEST_MINOR - OLDEST_MINOR + 1 }, (_, i) => `1.${OLDEST_MINOR + i}`);

mkdirSync(outDir, { recursive: true });

const gateway = await buildGatewayDefinitions();

for (const version of versions) {
  const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/release-${version}/api/openapi-spec/swagger.json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${version}: ${res.status} ${res.statusText}`);
  const { definitions } = await res.json();
  for (const root of Object.values(ROOTS)) {
    if (!definitions?.[root]) throw new Error(`${root} missing from the ${version} spec`);
  }

  /** Transitive $ref closure, unioned across every root. */
  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    const def = definitions[name];
    if (!def) throw new Error(`dangling $ref in ${version}: ${name}`);
    reached.add(name);
    const stack = [def];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node.filter((v) => v && typeof v === 'object'));
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') walk(value.split('/').pop());
          else if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  };
  for (const root of Object.values(ROOTS)) walk(root);

  const sorted = [...reached].sort();
  const combinedDefinitions = { ...definitions, ...gateway.definitions };
  const combinedNames = [...sorted, ...Object.keys(gateway.definitions)].sort();
  const bundle = {
    k8sVersion: version,
    source: url,
    generatedAt: new Date().toISOString().slice(0, 10),
    gatewayApiVersion: GATEWAY_API_VERSION,
    roots: { ...ROOTS, ...gateway.roots },
    definitions: Object.fromEntries(combinedNames.map((name) => [name, combinedDefinitions[name]])),
  };

  const outFile = join(outDir, `k8s-${version}.json`);
  writeFileSync(outFile, JSON.stringify(bundle, null, 1) + '\n');
  console.log(`k8s-${version}.json: ${sorted.length} definitions`);
}
