import { isQualifiedName, suggestName } from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const CLASS_DOCS = 'https://kubernetes.io/docs/concepts/storage/storage-classes/';
const DEFAULT_CLASS_DOCS =
  'https://kubernetes.io/docs/tasks/administer-cluster/change-default-storage-class/';
const TOPOLOGY_DOCS =
  'https://kubernetes.io/docs/concepts/storage/storage-classes/#allowed-topologies';

/**
 * maxProvisionerParameterLen and maxProvisionerParameterSize, from
 * pkg/apis/storage/validation. The size is the sum of every key and value.
 */
const PARAMETERS_MAX_KEYS = 512;
const PARAMETERS_MAX_BYTES = 256 * 1024;

/**
 * The annotations that mark one StorageClass as the cluster's default. The
 * beta spelling predates the stable one and the admission plugin still honours
 * it, so a value written under either is worth checking.
 */
const DEFAULT_CLASS_ANNOTATIONS = [
  'storageclass.kubernetes.io/is-default-class',
  'storageclass.beta.kubernetes.io/is-default-class',
];

/**
 * The checks the apiserver runs on a StorageClass, from ValidateStorageClass in
 * pkg/apis/storage/validation. Like an IngressClass it is cluster-scoped and
 * describes no Pod, so none of the shared PodSpec rules apply.
 *
 * It is the one kind here with no `spec`: provisioner, parameters and the rest
 * hang directly off the document, so this module addresses `ctx.doc` where
 * every other kind's module addresses `ctx.doc['spec']`.
 *
 * The schema layer already covers `provisioner` being required, every field's
 * type, and the `key`/`values` a topology expression must carry; `reclaimPolicy`
 * and `volumeBindingMode` are plain enums and live in `rules/enums.ts`. What is
 * left here is what OpenAPI cannot express: the qualified-name format of the
 * provisioner, the shape of the parameters map, and the several ways one
 * allowedTopologies entry can contradict itself or its neighbour.
 *
 * Deliberately skipped: `mountOptions`, which like a PersistentVolume's is not
 * validated server-side; `allowVolumeExpansion`, a bare bool with nothing to
 * check; and the immutability of provisioner, parameters, reclaimPolicy and
 * volumeBindingMode, which only constrains an update — as `claimRef` does on a
 * PersistentVolume.
 *
 * Nothing is version-gated: storage/v1 StorageClass has been served unchanged
 * since well before the 1.25 floor, allowedTopologies and volumeBindingMode
 * included.
 */
export const storageClassRule: Rule = {
  id: 'storageclass/fields',
  run(ctx: RuleContext) {
    checkDefaultAnnotation(ctx);
    checkProvisioner(ctx);
    checkParameters(ctx);
    checkAllowedTopologies(ctx);
  },
};

/* Provisioner */

/**
 * The provisioner is what the class means: a claim naming this class is
 * fulfilled by whichever volume plugin answers to this string — "kubernetes.io/
 * aws-ebs" for an in-tree plugin, "ebs.csi.aws.com" for a CSI driver.
 *
 * A missing provisioner is layer 1's, through the schema's required list; only
 * an empty string reaches here, since the apiserver rejects both the same way.
 */
function checkProvisioner(ctx: RuleContext): void {
  const provisioner = asString(ctx.doc['provisioner']);
  if (provisioner === undefined) return;

  const path: Path = ['provisioner'];

  if (provisioner === '') {
    ctx.report({
      ruleId: 'storageclass/missing-provisioner',
      severity: 'error',
      path,
      message: 'A StorageClass must name the provisioner that fulfils it.',
      explanation:
        'The class exists to point a PersistentVolumeClaim at a volume plugin, and provisioner is that pointer — "ebs.csi.aws.com", say, or "kubernetes.io/no-provisioner" for a class that only groups statically created volumes. Without it nothing provisions the claims that name this class, and the apiserver rejects the object with "Required value".',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  // The apiserver lowercases the provisioner before checking its format, so
  // upper-case letters are tolerated even though the qualified-name rules it
  // checks against would otherwise reject nothing of the sort. The same quirk
  // applies to a PersistentVolume's csi.driver.
  const check = isQualifiedName(provisioner.toLowerCase());
  if (check.ok) return;

  const suggestion = suggestName(provisioner);
  ctx.report({
    ruleId: 'storageclass/invalid-provisioner',
    severity: 'error',
    path,
    message: `"${provisioner}" is not a valid provisioner: it ${check.reason}.`,
    explanation:
      'A provisioner is a qualified name: an optional DNS subdomain prefix, a "/", and a name of at most 63 alphanumerics, "-", "_" or "." starting and ending with an alphanumeric character. In-tree plugins carry the prefix ("kubernetes.io/aws-ebs"); a CSI driver is usually the bare reverse-DNS name of the driver ("ebs.csi.aws.com").',
    docsUrl: CLASS_DOCS,
    fix:
      suggestion && isQualifiedName(suggestion).ok
        ? {
            title: `Change to "${suggestion}"`,
            safe: false,
            ops: [{ op: 'set', path, value: suggestion }],
          }
        : undefined,
  });
}

/* Parameters */

/**
 * The parameters are passed to the provisioner verbatim, so nothing here reads
 * them — but the apiserver still bounds how many there may be and how much they
 * may weigh, and rejects a key that is empty. An empty map is allowed: a class
 * whose provisioner needs no configuration writes none.
 */
function checkParameters(ctx: RuleContext): void {
  const parameters = asObject(ctx.doc['parameters']);
  if (!parameters) return;

  const path: Path = ['parameters'];
  const keys = Object.keys(parameters);

  if (keys.length > PARAMETERS_MAX_KEYS) {
    ctx.report({
      ruleId: 'storageclass/too-many-parameters',
      severity: 'error',
      path,
      message: `parameters may hold at most ${PARAMETERS_MAX_KEYS} entries, but holds ${keys.length}.`,
      explanation:
        'The map is copied onto every volume the class provisions, so the apiserver caps its size rather than let one class inflate every PersistentVolume made from it.',
      docsUrl: CLASS_DOCS,
    });
    return;
  }

  if (parameters[''] !== undefined) {
    ctx.report({
      ruleId: 'storageclass/empty-parameter-key',
      severity: 'error',
      path,
      message: 'A parameters key is empty.',
      explanation:
        'The provisioner looks its configuration up by key, so a nameless entry can never be read. The apiserver rejects it with "field can not be empty".',
      docsUrl: CLASS_DOCS,
    });
  }

  let bytes = 0;
  for (const [key, value] of Object.entries(parameters)) {
    bytes += key.length + (asString(value)?.length ?? 0);
  }
  if (bytes > PARAMETERS_MAX_BYTES) {
    ctx.report({
      ruleId: 'storageclass/parameters-too-large',
      severity: 'error',
      path,
      message: `parameters may total at most ${PARAMETERS_MAX_BYTES} characters across all keys and values, but total ${bytes}.`,
      explanation:
        'The map is copied onto every volume the class provisions, so the apiserver caps its total size as well as its entry count.',
      docsUrl: CLASS_DOCS,
    });
  }
}

/* Allowed topologies */

/**
 * allowedTopologies restricts where the class may provision. Each entry is a
 * term, each term is a set of label requirements, and a node satisfies the
 * class if it satisfies any one term — so a term that requires the same label
 * twice, or lists no acceptable values, can never be satisfied, and two
 * identical terms say nothing the first did not.
 *
 * A missing `key` or `values` is layer 1's, through TopologySelectorLabelRequirement's
 * required list.
 */
function checkAllowedTopologies(ctx: RuleContext): void {
  const topologies = asArray(ctx.doc['allowedTopologies']);
  if (!topologies) return;

  const seen: string[] = [];

  topologies.forEach((entry, index) => {
    const term = asObject(entry);
    if (!term) return;

    const base: Path = ['allowedTopologies', index];
    const expressions = asArray(term['matchLabelExpressions']);
    // An absent matchLabelExpressions is allowed upstream, with a comment
    // saying so — the field is optional in case terms ever grow a second way
    // of matching.
    if (!expressions) return;

    const keys = new Map<string, number>();
    const canonical: string[] = [];

    expressions.forEach((raw, exprIndex) => {
      const expression = asObject(raw);
      if (!expression) return;

      const exprPath: Path = [...base, 'matchLabelExpressions', exprIndex];
      const key = asString(expression['key']);
      if (key !== undefined) {
        checkTopologyKey(ctx, key, [...exprPath, 'key']);

        const first = keys.get(key);
        if (first !== undefined) {
          ctx.report({
            ruleId: 'storageclass/duplicate-topology-key',
            severity: 'error',
            path: [...exprPath, 'key'],
            message: `"${key}" is already required by matchLabelExpressions[${first}] in this term.`,
            explanation:
              'The requirements in one term are combined with AND, so two on the same label would have to hold at once — and since each lists the values it accepts, the second only ever narrows or contradicts the first. Write one requirement listing every acceptable value instead.',
            docsUrl: TOPOLOGY_DOCS,
          });
        } else {
          keys.set(key, exprIndex);
        }
      }

      const values = checkTopologyValues(ctx, expression, exprPath);
      if (key !== undefined && values !== undefined) {
        canonical.push(`${key}=${[...new Set(values)].sort().join(',')}`);
      }
    });

    // Two terms match the same nodes when their requirements agree, whatever
    // order they were written in.
    const fingerprint = [...canonical].sort().join('\n');
    if (canonical.length === 0) return;
    if (seen.includes(fingerprint)) {
      ctx.report({
        ruleId: 'storageclass/duplicate-topology-term',
        severity: 'error',
        path: [...base, 'matchLabelExpressions'],
        message: `allowedTopologies[${index}] requires exactly what an earlier term already requires.`,
        explanation:
          'Terms are combined with OR, so a repeated term selects no node the first did not already select. The apiserver rejects the duplicate rather than ignore it.',
        docsUrl: TOPOLOGY_DOCS,
      });
      return;
    }
    seen.push(fingerprint);
  });
}

/** Topology keys are node label keys, so they are qualified names. */
function checkTopologyKey(ctx: RuleContext, key: string, path: Path): void {
  const check = isQualifiedName(key);
  if (check.ok) return;

  ctx.report({
    ruleId: 'storageclass/invalid-topology-key',
    severity: 'error',
    path,
    message: `"${key}" is not a valid topology key: it ${check.reason}.`,
    explanation:
      'A topology key names a label the scheduler reads off a node — "topology.kubernetes.io/zone", say — so it is validated as a label key: an optional DNS subdomain prefix, a "/", and a name of at most 63 alphanumerics, "-", "_" or ".".',
    docsUrl: TOPOLOGY_DOCS,
  });
}

/** Returns the values, or undefined when there is nothing usable to compare. */
function checkTopologyValues(
  ctx: RuleContext,
  expression: Record<string, unknown>,
  exprPath: Path,
): string[] | undefined {
  const values = asArray(expression['values']);
  if (!values) return undefined;

  const path: Path = [...exprPath, 'values'];

  if (values.length === 0) {
    ctx.report({
      ruleId: 'storageclass/empty-topology-values',
      severity: 'error',
      path,
      message: 'A topology requirement must list at least one acceptable value.',
      explanation:
        'A requirement is satisfied when the node\'s label matches one of the values, so an empty list matches nothing and the term it belongs to can never be satisfied. The apiserver rejects it with "Required value".',
      docsUrl: TOPOLOGY_DOCS,
    });
    return undefined;
  }

  const strings: string[] = [];
  const first = new Map<string, number>();
  values.forEach((raw, index) => {
    const value = asString(raw);
    if (value === undefined) return;
    strings.push(value);

    const earlier = first.get(value);
    if (earlier === undefined) {
      first.set(value, index);
      return;
    }
    ctx.report({
      ruleId: 'storageclass/duplicate-topology-value',
      severity: 'error',
      path: [...path, index],
      message: `"${value}" is already listed at values[${earlier}].`,
      explanation:
        'The values are a set — the requirement holds if the node\'s label equals any of them — so repeating one changes nothing. The apiserver rejects the duplicate rather than collapse it.',
      docsUrl: TOPOLOGY_DOCS,
      fix: {
        title: `Remove the duplicate "${value}"`,
        safe: true,
        ops: [{ op: 'delete', path: [...path, index] }],
      },
    });
  });

  return strings;
}

/* Default class annotation */

/**
 * The annotation that makes this class the one a claim gets when it names none.
 * Nothing validates it — it is an annotation — but the admission plugin that
 * reads it compares the value to "true" as a string, so anything else is a
 * class that quietly is not the default.
 */
function checkDefaultAnnotation(ctx: RuleContext): void {
  const annotations = asObject(asObject(ctx.doc['metadata'])?.['annotations']);
  if (!annotations) return;

  for (const annotation of DEFAULT_CLASS_ANNOTATIONS) {
    const value = asString(annotations[annotation]);
    if (value === undefined || value === 'true' || value === 'false') continue;

    // "True" or " true " differ from the annotation the plugin looks for only
    // in case and spacing, so correcting them is unambiguous; "yes" is a guess
    // at what was meant and gets no fix at all.
    const normalised = value.trim().toLowerCase();
    const intended = normalised === 'true' || normalised === 'false' ? normalised : undefined;

    ctx.report({
      ruleId: 'storageclass/invalid-default-annotation',
      severity: 'warning',
      path: ['metadata', 'annotations', annotation],
      message: `"${value}" does not mark this class as the default; only the exact string "true" does.`,
      explanation:
        'The admission plugin that fills in a missing spec.storageClassName compares this annotation to "true" character by character, so "True", "yes" and "1" all read as "not the default" — and a claim that names no class is left unbound instead.',
      docsUrl: DEFAULT_CLASS_DOCS,
      fix: intended
        ? {
            title: `Change to "${intended}"`,
            safe: true,
            ops: [{ op: 'set', path: ['metadata', 'annotations', annotation], value: intended }],
          }
        : undefined,
    });
  }
}
