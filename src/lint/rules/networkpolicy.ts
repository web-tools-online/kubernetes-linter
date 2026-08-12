import { cidrContains, isCIDR, maskCIDR, type CIDRCheck } from '../../k8s/net.js';
import { isPortName } from '../../k8s/names.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkKeyedMap } from './metadata.js';
import { checkRequirement } from './selector.js';

const NETPOL_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/network-policies/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

const POLICY_TYPES = ['Ingress', 'Egress'] as const;
type PolicyType = (typeof POLICY_TYPES)[number];

/** IsValidPortNum, from k8s.io/apimachinery/pkg/util/validation — shared by both TCP and UDP. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The checks the apiserver runs on a NetworkPolicy, from ValidateNetworkPolicy
 * in pkg/apis/networking/validation. Like a Service or an Ingress it describes
 * no Pod, so none of the shared PodSpec rules apply — but unlike them, almost
 * everything it carries is either a LabelSelector or a CIDR block, so this
 * module leans on `selector.ts`'s `checkRequirement` and `k8s/net.ts`'s CIDR
 * arithmetic rather than reimplementing either.
 *
 * `podSelector` is the one place this inverts the Deployment/StatefulSet/
 * DaemonSet convention: an *empty* selector is not an oversight here, it is
 * "every Pod in this namespace", so unlike those three modules this one never
 * reports an empty selector as a mistake.
 *
 * The schema layer covers `podSelector` being required and `ipBlock.cidr`
 * being required; everything else here is a cross-field constraint OpenAPI
 * cannot express — a peer naming none of its three forms or more than one, a
 * port's endPort disagreeing with port, an except entry that is not strictly
 * inside its cidr, and (as a warning rather than an apiserver rejection) a
 * cidr with bits set beyond its prefix or a rule list that policyTypes does
 * not cover.
 *
 * Nothing here is version-gated: every field checked, endPort included, has
 * been part of networking/v1 NetworkPolicy since before the 1.25 floor.
 * `NetworkPolicySpec.required` itself drifts across the supported range —
 * upstream's own OpenAPI document listed `podSelector` as required through
 * 1.33 and stopped in 1.34 even though the field was always optional in
 * practice — but that is upstream's schema to carry, not a rule of this
 * module's to paper over; see the version-pinned test for the resulting
 * `schema/required-field` on the older releases.
 */
export const networkPolicyRule: Rule = {
  id: 'networkpolicy/spec',
  run(ctx: RuleContext) {
    // An absent spec is a NetworkPolicy naming no podSelector, the same
    // rejection as one with an empty spec. A spec of the wrong shape is layer
    // 1's to report.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkPodSelector(ctx, spec);
    const policyTypes = checkPolicyTypes(ctx, spec);
    checkCoverage(ctx, spec, 'ingress', 'Ingress', policyTypes);
    checkCoverage(ctx, spec, 'egress', 'Egress', policyTypes);
    checkRuleList(ctx, spec, 'ingress', 'from');
    checkRuleList(ctx, spec, 'egress', 'to');
  },
};

/* Selectors, shared by podSelector and every peer's podSelector/namespaceSelector */

function checkPodSelector(ctx: RuleContext, spec: Record<string, unknown>): void {
  const selector = asObject(spec['podSelector']);
  if (!selector) return;
  checkLabelSelector(ctx, selector, ['spec', 'podSelector']);
}

function checkLabelSelector(ctx: RuleContext, selector: Record<string, unknown>, path: Path): void {
  checkKeyedMap(ctx, selector['matchLabels'], [...path, 'matchLabels'], 'label', true);

  asArray(selector['matchExpressions'])?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), [...path, 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'networkpolicy',
      docsUrl: SELECTOR_DOCS,
    });
  });
}

/* Policy types */

/**
 * Returns the declared types when every entry was recognised, so the coverage
 * check below has something definite to compare against; `undefined` when
 * policyTypes was left out (nothing to compare — it is derived from the rules
 * themselves) or when an entry was already reported as invalid or the list
 * as a whole was already reported as too long, since guessing at a second
 * finding on top of either would only be noise.
 */
function checkPolicyTypes(ctx: RuleContext, spec: Record<string, unknown>): PolicyType[] | undefined {
  const raw = asArray(spec['policyTypes']);
  if (raw === undefined) return undefined;
  const path: Path = ['spec', 'policyTypes'];

  if (raw.length > POLICY_TYPES.length) {
    ctx.report({
      ruleId: 'networkpolicy/too-many-policy-types',
      severity: 'error',
      path,
      message: `policyTypes may list at most ${POLICY_TYPES.length} entries, but ${raw.length} were given.`,
      explanation:
        'There are only two policy types, "Ingress" and "Egress", so a longer list can only repeat one of them, and the apiserver rejects it outright.',
      docsUrl: NETPOL_DOCS,
    });
    return undefined;
  }

  const recognised: PolicyType[] = [];
  let allValid = true;

  raw.forEach((entry, index) => {
    const value = asString(entry);
    if (value === undefined) {
      allValid = false;
      return;
    }

    if (value !== 'Ingress' && value !== 'Egress') {
      allValid = false;
      const suggestion = didYouMean(value, POLICY_TYPES);
      ctx.report({
        ruleId: 'networkpolicy/invalid-policy-type',
        severity: 'error',
        path: [...path, index],
        message: suggestion
          ? `"${value}" is not a valid policy type. Did you mean "${suggestion}"?`
          : `"${value}" is not a valid policy type.`,
        explanation: 'policyTypes may only name "Ingress" or "Egress".',
        docsUrl: NETPOL_DOCS,
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

    recognised.push(value);
  });

  return allValid ? recognised : undefined;
}

/**
 * The apiserver never checks this — it accepts a rule list for a type that
 * policyTypes does not name — but the rules are then never enforced, which
 * is near-certainly not what was intended, so it is a warning rather than an
 * error.
 */
function checkCoverage(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  field: 'ingress' | 'egress',
  type: PolicyType,
  policyTypes: PolicyType[] | undefined,
): void {
  if (policyTypes === undefined) return;

  const rules = asArray(spec[field]);
  if (!rules || rules.length === 0 || policyTypes.includes(type)) return;

  ctx.report({
    ruleId: 'networkpolicy/policy-type-mismatch',
    severity: 'warning',
    path: ['spec', field],
    message: `spec.${field} is declared but policyTypes does not list "${type}", so these rules are never applied.`,
    explanation:
      'The apiserver only enforces the ingress or egress rules whose type appears in policyTypes; a rule list for a type that is not there is stored but has no effect.',
    docsUrl: NETPOL_DOCS,
    fix: {
      title: `Add "${type}" to policyTypes`,
      safe: false,
      ops: [
        {
          op: 'insert',
          path: ['spec', 'policyTypes'],
          index: Number.MAX_SAFE_INTEGER,
          value: type,
        },
      ],
    },
  });
}

/* Ingress and egress rules: ports and peers */

function checkRuleList(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  field: 'ingress' | 'egress',
  peerField: 'from' | 'to',
): void {
  asArray(spec[field])?.forEach((entry, ruleIndex) => {
    const rule = asObject(entry);
    if (!rule) return;
    const rulePath: Path = ['spec', field, ruleIndex];

    asArray(rule['ports'])?.forEach((port, portIndex) => {
      checkPort(ctx, asObject(port), [...rulePath, 'ports', portIndex]);
    });

    asArray(rule[peerField])?.forEach((peer, peerIndex) => {
      checkPeer(ctx, asObject(peer), [...rulePath, peerField, peerIndex]);
    });
  });
}

/* Peers */

function checkPeer(ctx: RuleContext, peer: Record<string, unknown> | undefined, path: Path): void {
  if (!peer) return;

  const podSelector = asObject(peer['podSelector']);
  const namespaceSelector = asObject(peer['namespaceSelector']);
  const ipBlock = asObject(peer['ipBlock']);
  const count = [podSelector, namespaceSelector, ipBlock].filter((value) => value !== undefined).length;

  if (count === 0) {
    ctx.report({
      ruleId: 'networkpolicy/empty-peer',
      severity: 'error',
      path,
      message: 'A peer must specify one of podSelector, namespaceSelector or ipBlock.',
      explanation:
        'The peer exists to describe which sources or destinations the rule applies to, and an entry naming none of the three matches nothing; the apiserver rejects it with "must specify a peer".',
      docsUrl: NETPOL_DOCS,
    });
    return;
  }

  if (ipBlock && count > 1) {
    ctx.report({
      ruleId: 'networkpolicy/ipblock-with-selector',
      severity: 'error',
      path,
      message: 'ipBlock may not be combined with podSelector or namespaceSelector.',
      explanation:
        'ipBlock selects by raw address rather than by Pod or namespace label, which is a different kind of peer entirely, so the apiserver rejects the pair rather than guess which is meant.',
      docsUrl: NETPOL_DOCS,
    });
  }

  if (podSelector) checkLabelSelector(ctx, podSelector, [...path, 'podSelector']);
  if (namespaceSelector) checkLabelSelector(ctx, namespaceSelector, [...path, 'namespaceSelector']);
  if (ipBlock) checkIPBlock(ctx, ipBlock, [...path, 'ipBlock']);
}

/* ipBlock */

function checkIPBlock(ctx: RuleContext, ipBlock: Record<string, unknown>, path: Path): void {
  const cidrText = asString(ipBlock['cidr']);
  const cidrPath: Path = [...path, 'cidr'];

  // A missing cidr is layer 1's — it is in the schema's required list.
  if (cidrText === undefined) return;

  if (cidrText === '') {
    ctx.report({
      ruleId: 'networkpolicy/missing-cidr',
      severity: 'error',
      path: cidrPath,
      message: 'ipBlock.cidr must not be empty.',
      explanation:
        'The block describes nothing without an address, so the apiserver rejects an empty cidr with "Required value".',
      docsUrl: NETPOL_DOCS,
    });
    return;
  }

  const cidr = isCIDR(cidrText);
  if (!cidr.ok) {
    ctx.report({
      ruleId: 'networkpolicy/invalid-cidr',
      severity: 'error',
      path: cidrPath,
      message: `"${cidrText}" is not a valid CIDR block: it ${cidr.reason}.`,
      explanation: 'cidr is an address and a prefix length, such as "10.0.0.0/8" or "2001:db8::/32".',
      docsUrl: NETPOL_DOCS,
    });
    return;
  }

  checkHostBits(ctx, cidr, cidrText, cidrPath);

  asArray(ipBlock['except'])?.forEach((entry, index) => {
    checkExcept(ctx, cidr, cidrText, asString(entry), [...path, 'except', index]);
  });
}

/**
 * Not an apiserver rejection on its own — the CNI reads only the masked
 * network, so the bits after the prefix length are inert — but from 1.36 the
 * StrictIPCIDRValidation feature gate turns exactly this into a hard error,
 * and a cidr that already looks masked is what that gate expects, so this is
 * reported (as a warning) on every version rather than only the newest one.
 */
function checkHostBits(ctx: RuleContext, cidr: CIDRCheck, cidrText: string, path: Path): void {
  const masked = maskCIDR(cidr);
  if (masked === '' || masked === cidrText) return;

  ctx.report({
    ruleId: 'networkpolicy/cidr-host-bits',
    severity: 'warning',
    path,
    message: `"${cidrText}" has bits set beyond its /${cidr.bits} prefix; the network address is "${masked}".`,
    explanation:
      'The bits after the prefix length are not part of the network and play no part in matching traffic, so writing them invites the reader to think they matter. On a 1.36 cluster with the StrictIPCIDRValidation feature gate enabled, the apiserver rejects a cidr like this outright rather than silently masking it.',
    docsUrl: NETPOL_DOCS,
    fix: { title: `Change to "${masked}"`, safe: true, ops: [{ op: 'set', path, value: masked }] },
  });
}

function checkExcept(
  ctx: RuleContext,
  cidr: CIDRCheck,
  cidrText: string,
  exceptText: string | undefined,
  path: Path,
): void {
  if (exceptText === undefined || exceptText === '') return;

  const except = isCIDR(exceptText);
  if (!except.ok) {
    ctx.report({
      ruleId: 'networkpolicy/invalid-cidr',
      severity: 'error',
      path,
      message: `"${exceptText}" is not a valid CIDR block: it ${except.reason}.`,
      explanation: 'Each entry in except is itself a CIDR block, carved back out of cidr.',
      docsUrl: NETPOL_DOCS,
    });
    return;
  }

  const strictSubset =
    cidr.bits !== undefined && except.bits !== undefined && cidr.bits < except.bits && cidrContains(cidr, except);

  if (!strictSubset) {
    ctx.report({
      ruleId: 'networkpolicy/except-not-subset',
      severity: 'error',
      path,
      message: `"${exceptText}" must be a strict subset of "${cidrText}".`,
      explanation:
        'Each entry in except carves an address range back out of cidr, so it has to fall inside it and be more specific — a block that is the same size or wider excludes nothing.',
      docsUrl: NETPOL_DOCS,
    });
  }
}

/* Ports */

function checkPort(ctx: RuleContext, port: Record<string, unknown> | undefined, path: Path): void {
  if (!port) return;

  const raw = port['port'];
  const endPort = asNumber(port['endPort']);
  const endPortPath: Path = [...path, 'endPort'];

  if (raw === undefined) {
    if (endPort !== undefined) {
      ctx.report({
        ruleId: 'networkpolicy/endport-without-port',
        severity: 'error',
        path: endPortPath,
        message: 'endPort may not be set when port is not set.',
        explanation:
          'endPort extends a numeric port into a range, so there has to be a starting port for it to extend.',
        docsUrl: NETPOL_DOCS,
      });
    }
    return;
  }

  if (typeof raw === 'number') {
    checkPortRange(ctx, [...path, 'port'], 'port', raw);

    if (endPort !== undefined) {
      checkPortRange(ctx, endPortPath, 'endPort', endPort);
      if (Number.isInteger(raw) && Number.isInteger(endPort) && endPort < raw) {
        ctx.report({
          ruleId: 'networkpolicy/endport-before-port',
          severity: 'error',
          path: endPortPath,
          message: `endPort ${endPort} must be greater than or equal to port ${raw}.`,
          explanation: 'endPort is the top of the range that port opens, so it cannot sit below the start.',
          docsUrl: NETPOL_DOCS,
        });
      }
    }
    return;
  }

  // A value of the wrong shape entirely — neither a number nor a string — is
  // layer 1's, through the IntOrString scalar check.
  const name = asString(raw);
  if (name === undefined) return;

  if (endPort !== undefined) {
    ctx.report({
      ruleId: 'networkpolicy/endport-with-named-port',
      severity: 'error',
      path: endPortPath,
      message: 'endPort may not be set when port is a name.',
      explanation: 'A range only means something against a number; a named port already resolves to exactly one.',
      docsUrl: NETPOL_DOCS,
    });
  }

  const check = isPortName(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'networkpolicy/invalid-port-name',
      severity: 'error',
      path: [...path, 'port'],
      message: `"${name}" is not a valid port name: it ${check.reason}.`,
      explanation:
        'A named port refers to a container port by name, so it follows the IANA service name rules those names use: at most 15 characters, lowercase letters, digits and "-", containing at least one letter, with no leading, trailing or repeated hyphens.',
      docsUrl: NETPOL_DOCS,
    });
  }
}

function checkPortRange(ctx: RuleContext, path: Path, field: string, value: number): void {
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    ctx.report({
      ruleId: 'networkpolicy/invalid-port',
      severity: 'error',
      path,
      message: `${field} ${value} is out of range; it must be between ${MIN_PORT} and ${MAX_PORT}.`,
      explanation: 'TCP, UDP and SCTP port numbers are 16-bit, and 0 is not assignable.',
      docsUrl: NETPOL_DOCS,
    });
  }
}
