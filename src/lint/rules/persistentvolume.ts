import { isDNS1123Subdomain, suggestName } from '../../k8s/names.js';
import { parseQuantity } from '../../k8s/quantity.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkRequirement } from './selector.js';
import { ACCESS_MODES } from './persistentvolumeclaim.js';

const PV_DOCS = 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/';
const AFFINITY_DOCS = 'https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/';

const PERSISTENT_VOLUME_SPEC_DEFINITION = 'io.k8s.api.core.v1.PersistentVolumeSpec';

/**
 * The checks the apiserver runs on a PersistentVolume, from
 * ValidatePersistentVolumeSpec in pkg/apis/core/validation. Like a Service, an
 * Ingress, an IngressClass and a PersistentVolumeClaim it describes no Pod, so
 * none of the shared PodSpec rules apply to it, and unlike every other kind it
 * is cluster-scoped, like an IngressClass.
 *
 * The schema layer covers less here than for any other kind:
 * PersistentVolumeSpec has no `required` list at all, so `accessModes` and
 * `capacity` — both required by the apiserver — are this module's, alongside
 * the "exactly one volume source" rule OpenAPI has no way to express (there
 * are 22 mutually exclusive source fields). The source fields themselves come
 * from the schema, not a hardcoded list — every one of them is a `$ref` whose
 * definition name ends in "VolumeSource", the only two exceptions being
 * `claimRef` (an ObjectReference) and `nodeAffinity` (a VolumeNodeAffinity) —
 * so a new in-tree plugin is handled the moment the schema is regenerated,
 * exactly as `rules/volumes.ts` derives a Pod's Volume source fields.
 *
 * Each individual source's *own* required fields (`hostPath.path`,
 * `nfs.server`, `csi.driver` and so on) are already in the generated schema's
 * `required` lists and so are layer 1's to report; this module only adds the
 * checks OpenAPI cannot express: cross-field consistency (a hostPath mount of
 * "/" combined with a Recycle reclaim policy, a local volume with no node
 * affinity), format checks the schema has no way to run (`..` in a path,
 * an NFS path that is not absolute, a CSI driver name), and the
 * `volumeAttributesClassName` fields also checked for a PersistentVolumeClaim.
 * `persistentVolumeReclaimPolicy` and `volumeMode` are plain enums and live in
 * `rules/enums.ts` instead, alongside the rest of the enum table.
 *
 * Deliberately skipped: `claimRef`, which the validator only constrains on
 * update (immutability), not on create; `mountOptions`, whose own description
 * says it is "not validated" server-side; and the field-by-field format
 * checks for the deprecated in-tree drivers (RBD, Cephfs, iSCSI, Glusterfs,
 * ScaleIO, Quobyte, StorageOS, Flocker) beyond what their own `required`
 * fields in the schema already cover.
 */
export const persistentVolumeRule: Rule = {
  id: 'persistentvolume/spec',
  run(ctx: RuleContext) {
    // An absent spec is a volume with none of its required fields, which is
    // the same rejection as an empty one. A spec of the wrong shape is layer
    // 1's to report.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    const base: Path = ['spec'];
    checkAccessModes(ctx, spec, base);
    checkCapacity(ctx, spec, base);
    checkVolumeSource(ctx, spec, base);
    checkNodeAffinity(ctx, spec, base);
    checkHostPath(ctx, spec, base);
    checkLocal(ctx, spec, base);
    checkNfs(ctx, spec, base);
    checkCsiDriver(ctx, spec, base);
    checkStorageClassName(ctx, spec, base);
    checkVolumeAttributesClassName(ctx, spec, base);
  },
};

/* Access modes */

function checkAccessModes(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const accessModes = asArray(spec['accessModes']);
  const path = [...base, 'accessModes'];

  if (accessModes === undefined || accessModes.length === 0) {
    ctx.report({
      ruleId: 'persistentvolume/missing-access-modes',
      severity: 'error',
      path: accessModes === undefined ? base : path,
      ...(accessModes === undefined ? { anchor: 'key' as const } : {}),
      message: 'A PersistentVolume must list at least one access mode.',
      explanation:
        'accessModes says how the volume may be mounted — by one node for read-write, by many for read-only, or by many for read-write. Without one there is nothing for the apiserver to bind a claim against, and it is rejected with "Required value".',
      docsUrl: `${PV_DOCS}#access-modes`,
    });
    return;
  }

  let hasReadWriteOncePod = false;
  let hasOtherMode = false;

  accessModes.forEach((entry, index) => {
    const mode = asString(entry);
    if (mode === undefined) return;

    if (!ACCESS_MODES.includes(mode)) {
      const suggestion = didYouMean(mode, ACCESS_MODES);
      ctx.report({
        ruleId: 'persistentvolume/invalid-access-mode',
        severity: 'error',
        path: [...path, index],
        message: suggestion
          ? `"${mode}" is not a valid access mode. Did you mean "${suggestion}"?`
          : `"${mode}" is not a valid access mode.`,
        explanation: `Allowed values are ${ACCESS_MODES.map((value) => `"${value}"`).join(', ')}.`,
        docsUrl: `${PV_DOCS}#access-modes`,
        fix: suggestion
          ? {
              title: `Change to "${suggestion}"`,
              safe: true,
              ops: [{ op: 'set', path: [...path, index], value: suggestion }],
            }
          : undefined,
      });
      return;
    }

    if (mode === 'ReadWriteOncePod') hasReadWriteOncePod = true;
    else hasOtherMode = true;
  });

  if (hasReadWriteOncePod && hasOtherMode) {
    ctx.report({
      ruleId: 'persistentvolume/read-write-once-pod-exclusive',
      severity: 'error',
      path,
      message: '"ReadWriteOncePod" may not be combined with another access mode.',
      explanation:
        '"ReadWriteOncePod" already guarantees the volume to a single Pod, which is stricter than every other mode, so listing one beside it contradicts that guarantee and the apiserver rejects the pair.',
      docsUrl: `${PV_DOCS}#access-modes`,
    });
  }
}

/* Capacity */

function checkCapacity(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const declared = spec['capacity'];
  const capacity = declared === undefined ? undefined : asObject(declared);
  if (!capacity) {
    if (declared === undefined) {
      ctx.report({
        ruleId: 'persistentvolume/missing-capacity',
        severity: 'error',
        path: base,
        anchor: 'key',
        message: 'A PersistentVolume must declare its capacity.',
        explanation:
          'capacity.storage is how much space the volume provides; without it the apiserver has nothing to match a claim against and rejects the volume with "Required value".',
        docsUrl: `${PV_DOCS}#capacity`,
      });
    }
    return;
  }

  const path = [...base, 'capacity'];
  const keys = Object.keys(capacity);

  if (keys.length === 0) {
    ctx.report({
      ruleId: 'persistentvolume/missing-capacity',
      severity: 'error',
      path,
      message: 'A PersistentVolume must declare its capacity.',
      explanation:
        'capacity.storage is how much space the volume provides; without it the apiserver has nothing to match a claim against and rejects the volume with "Required value".',
      docsUrl: `${PV_DOCS}#capacity`,
    });
    return;
  }

  const extra = keys.filter((key) => key !== 'storage');
  if (!keys.includes('storage') || extra.length > 0) {
    ctx.report({
      ruleId: 'persistentvolume/unsupported-capacity-resource',
      severity: 'error',
      path,
      message: keys.includes('storage')
        ? `capacity may only specify "storage", not ${extra.map((key) => `"${key}"`).join(', ')}.`
        : `capacity must include "storage".`,
      explanation: '"storage" is the only resource capacity a PersistentVolume can carry.',
      docsUrl: `${PV_DOCS}#capacity`,
    });
  }

  const raw = capacity['storage'];
  if (raw === undefined) return;

  const quantity = parseQuantity(raw);
  // A syntax error here is layer 1's, through the Quantity scalar check.
  if (!quantity.ok || quantity.value === undefined) return;

  if (quantity.value <= 0) {
    ctx.report({
      ruleId: 'persistentvolume/non-positive-capacity',
      severity: 'error',
      path: [...path, 'storage'],
      message: `capacity.storage must be greater than zero, but is ${format(raw)}.`,
      explanation: 'A volume with no capacity, or a negative one, describes nothing usable.',
      docsUrl: `${PV_DOCS}#capacity`,
    });
  }
}

function format(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/* Volume source */

function sourceFields(ctx: RuleContext): string[] {
  const properties = ctx.schema.definition(PERSISTENT_VOLUME_SPEC_DEFINITION)?.properties ?? {};
  return Object.entries(properties)
    .filter(([, node]) => node.$ref?.endsWith('VolumeSource'))
    .map(([field]) => field);
}

function checkVolumeSource(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const fields = sourceFields(ctx);
  const present = fields.filter((field) => spec[field] !== undefined);

  if (present.length === 0) {
    ctx.report({
      ruleId: 'persistentvolume/missing-volume-source',
      severity: 'error',
      path: base,
      message: 'spec does not specify a volume source.',
      explanation:
        'A PersistentVolume must say where its data actually lives — hostPath, nfs, csi and so on. Exactly one source is required.',
      docsUrl: PV_DOCS,
    });
  } else if (present.length > 1) {
    ctx.report({
      ruleId: 'persistentvolume/multiple-volume-sources',
      severity: 'error',
      path: base,
      message: `spec specifies ${present.length} volume sources (${present.join(', ')}); exactly one is allowed.`,
      explanation: 'Split these into separate PersistentVolumes, each with its own single source.',
      docsUrl: PV_DOCS,
    });
  }
}

/* Node affinity */

function checkNodeAffinity(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const nodeAffinity = asObject(spec['nodeAffinity']);
  const local = asObject(spec['local']);

  if (!nodeAffinity) {
    if (local) {
      ctx.report({
        ruleId: 'persistentvolume/missing-node-affinity',
        severity: 'error',
        path: [...base, 'nodeAffinity'],
        anchor: 'key',
        message: 'A local volume requires nodeAffinity.',
        explanation:
          'A local volume is only reachable from the node it lives on, so the apiserver requires nodeAffinity.required to say which node that is.',
        docsUrl: AFFINITY_DOCS,
      });
    }
    return;
  }

  const requiredPath = [...base, 'nodeAffinity', 'required'];
  const required = asObject(nodeAffinity['required']);
  if (!required) {
    ctx.report({
      ruleId: 'persistentvolume/missing-node-affinity-required',
      severity: 'error',
      path: requiredPath,
      anchor: 'key',
      message: 'nodeAffinity.required is required.',
      explanation: 'nodeAffinity has only one field, "required", and it must specify the node constraints.',
      docsUrl: AFFINITY_DOCS,
    });
    return;
  }

  const terms = asArray(required['nodeSelectorTerms']);
  if (!terms || terms.length === 0) {
    ctx.report({
      ruleId: 'persistentvolume/empty-node-selector-terms',
      severity: 'error',
      path: requiredPath,
      message: 'nodeSelectorTerms must not be empty.',
      explanation:
        'An empty list matches no node, so the volume could never be attached. Remove the required affinity instead.',
      docsUrl: AFFINITY_DOCS,
    });
    return;
  }

  terms.forEach((term, index) => {
    const termPath = [...requiredPath, 'nodeSelectorTerms', index];
    for (const field of ['matchExpressions', 'matchFields'] as const) {
      asArray(asObject(term)?.[field])?.forEach((entry, entryIndex) => {
        checkRequirement(ctx, asObject(entry), [...termPath, field, entryIndex], {
          allowNumeric: true,
          idPrefix: 'persistentvolume',
          docsUrl: AFFINITY_DOCS,
        });
      });
    }
  });
}

/* hostPath */

function checkHostPath(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const hostPath = asObject(spec['hostPath']);
  if (!hostPath) return;

  const path = asString(hostPath['path']);
  // A missing path is layer 1's, through the schema's required list.
  if (path === undefined) return;

  checkNoBacksteps(ctx, path, [...base, 'hostPath', 'path']);

  const reclaimPolicy = asString(spec['persistentVolumeReclaimPolicy']);
  if (path !== '' && path.replace(/\/+$/, '') === '' && reclaimPolicy === 'Recycle') {
    ctx.report({
      ruleId: 'persistentvolume/recycle-host-path-root',
      severity: 'error',
      path: [...base, 'persistentVolumeReclaimPolicy'],
      message: `persistentVolumeReclaimPolicy may not be "Recycle" for a hostPath mount of "${path}".`,
      explanation:
        'Recycling wipes the volume\'s contents before it is reused; doing that to the root of the host filesystem would destroy the node.',
      docsUrl: PV_DOCS,
    });
  }
}

/* local */

function checkLocal(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const local = asObject(spec['local']);
  if (!local) return;

  const path = asString(local['path']);
  // A missing path is layer 1's, through the schema's required list.
  if (path === undefined) return;

  checkNoBacksteps(ctx, path, [...base, 'local', 'path']);
}

function checkNoBacksteps(ctx: RuleContext, value: string, path: Path): void {
  if (!value.split('/').includes('..')) return;

  ctx.report({
    ruleId: 'persistentvolume/path-with-backsteps',
    severity: 'error',
    path,
    message: `"${value}" must not contain "..".`,
    explanation: 'A path that steps back out of the volume is rejected by the apiserver.',
    docsUrl: PV_DOCS,
  });
}

/* nfs */

function checkNfs(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const nfs = asObject(spec['nfs']);
  if (!nfs) return;

  const path = asString(nfs['path']);
  // A missing path is layer 1's, through the schema's required list.
  if (path === undefined || path.startsWith('/')) return;

  ctx.report({
    ruleId: 'persistentvolume/relative-nfs-path',
    severity: 'error',
    path: [...base, 'nfs', 'path'],
    message: `nfs.path "${path}" must be an absolute path.`,
    explanation: 'The path is exported by the NFS server as an absolute path on its own filesystem.',
    docsUrl: PV_DOCS,
  });
}

/* csi */

function checkCsiDriver(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const csi = asObject(spec['csi']);
  if (!csi) return;

  const driver = asString(csi['driver']);
  // A missing driver is layer 1's, through the schema's required list.
  if (driver === undefined) return;

  const path = [...base, 'csi', 'driver'];

  if (driver.length > 63) {
    ctx.report({
      ruleId: 'persistentvolume/invalid-csi-driver',
      severity: 'error',
      path,
      message: `csi.driver must be at most 63 characters, but is ${driver.length}.`,
      explanation: 'The driver name is used to look up the CSI plugin, so it is capped like other short identifiers.',
      docsUrl: PV_DOCS,
    });
    return;
  }

  // The apiserver lowercases the driver name before checking its format, so
  // upper-case letters are tolerated even though every other name field here
  // rejects them.
  const check = isDNS1123Subdomain(driver.toLowerCase());
  if (!check.ok) {
    ctx.report({
      ruleId: 'persistentvolume/invalid-csi-driver',
      severity: 'error',
      path,
      message: `"${driver}" is not a valid csi.driver: it ${check.reason}.`,
      explanation:
        'The driver name is a DNS subdomain: letters, digits, "-" and ".", starting and ending with an alphanumeric character. It is compared case-insensitively.',
      docsUrl: PV_DOCS,
    });
  }
}

/* Storage class and volume attributes class */

function checkStorageClassName(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const name = asString(spec['storageClassName']);
  if (name === undefined || name === '') return;

  const check = isDNS1123Subdomain(name);
  if (check.ok) return;

  const suggestion = suggestName(name);
  ctx.report({
    ruleId: 'persistentvolume/invalid-storage-class-name',
    severity: 'error',
    path: [...base, 'storageClassName'],
    message: `"${name}" is not a valid storageClassName: it ${check.reason}.`,
    explanation:
      'storageClassName names a StorageClass object, so it is a DNS subdomain: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character.',
    docsUrl: 'https://kubernetes.io/docs/concepts/storage/storage-classes/',
    fix:
      suggestion && isDNS1123Subdomain(suggestion).ok
        ? {
            title: `Change to "${suggestion}"`,
            safe: false,
            ops: [{ op: 'set', path: [...base, 'storageClassName'], value: suggestion }],
          }
        : undefined,
  });
}

/**
 * volumeAttributesClassName arrived in 1.29, on the same field as
 * storageClassName's DNS subdomain format, plus two checks of its own: an
 * empty string is rejected outright (unlike storageClassName, where it means
 * "no class"), and it may only be set alongside a csi source.
 */
function checkVolumeAttributesClassName(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  base: Path,
): void {
  const path = [...base, 'volumeAttributesClassName'];
  if (!ctx.supports(path)) return;

  const declared = spec['volumeAttributesClassName'];
  if (declared === undefined) return;

  const name = asString(declared);
  if (name === undefined) return;

  if (name === '') {
    ctx.report({
      ruleId: 'persistentvolume/empty-volume-attributes-class-name',
      severity: 'error',
      path,
      message: 'volumeAttributesClassName may not be an empty string.',
      explanation: 'Leave the field out entirely to mean "no VolumeAttributesClass" — an empty string is rejected.',
      docsUrl: 'https://kubernetes.io/docs/concepts/storage/volume-attributes-classes/',
    });
  } else {
    const check = isDNS1123Subdomain(name);
    if (!check.ok) {
      ctx.report({
        ruleId: 'persistentvolume/invalid-volume-attributes-class-name',
        severity: 'error',
        path,
        message: `"${name}" is not a valid volumeAttributesClassName: it ${check.reason}.`,
        explanation:
          'volumeAttributesClassName names a VolumeAttributesClass object, so it follows the same DNS subdomain format as storageClassName.',
        docsUrl: 'https://kubernetes.io/docs/concepts/storage/volume-attributes-classes/',
      });
    }
  }

  if (spec['csi'] === undefined) {
    ctx.report({
      ruleId: 'persistentvolume/volume-attributes-class-without-csi',
      severity: 'error',
      path: [...base, 'csi'],
      anchor: 'key',
      message: 'volumeAttributesClassName requires a csi source.',
      explanation: 'Only the CSI volume source supports a VolumeAttributesClass.',
      docsUrl: 'https://kubernetes.io/docs/concepts/storage/volume-attributes-classes/',
    });
  }
}
