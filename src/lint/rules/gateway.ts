import { isDNS1123Subdomain, isWildcardDNS1123Subdomain } from '../../k8s/names.js';
import { isIPAddress } from '../../k8s/net.js';
import type { Path } from '../types.js';
import { asArray, asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkKeyedMap } from './metadata.js';

const GATEWAY_DOCS = 'https://gateway-api.sigs.k8s.io/api-types/gateway/';
const TLS_DOCS = 'https://gateway-api.sigs.k8s.io/guides/tls/';

/** Protocols a listener may not carry a `tls` block for: none of them is TLS-terminated. */
const PLAINTEXT_PROTOCOLS = ['HTTP', 'TCP', 'UDP'];

/** Protocols that carry no name a hostname could be matched against. */
const HOSTNAMELESS_PROTOCOLS = ['TCP', 'UDP'];

const MODE_TERMINATE = 'Terminate';

/**
 * The checks the apiserver runs on a Gateway through its
 * `x-kubernetes-validations` (CEL) rules — the Gateway API equivalent of the
 * hand-written validators the core kinds are checked against. A Gateway
 * describes no Pod, so none of the shared PodSpec rules apply.
 *
 * What layer 1 already derives from the CRD's own OpenAPI schema is
 * deliberately absent here: `gatewayClassName` and a listener's `name`, `port`
 * and `protocol` are required by the schema, each of those carries its own
 * `pattern`, length or bounds, `tls.mode` carries its `enum`, and
 * `spec.listeners` is an `x-kubernetes-list-type: map` keyed by `name`, so two
 * listeners sharing a name are already `schema/duplicate-list-entry` — which
 * is the whole of the CRD's "Listener name must be unique" rule. Only what CEL
 * alone can express is checked below: a field whose legality turns on the
 * value of a sibling, and the two uniqueness rules that span a list.
 *
 * Like HTTPRoute, a Gateway's schema is generated from one pinned Gateway API
 * release rather than from the selected Kubernetes version (see
 * `scripts/generate-schema.mjs`), so nothing here is version-gated.
 */
export const gatewayRule: Rule = {
  id: 'gateway/spec',
  run(ctx: RuleContext) {
    // An absent spec is schema/required-field's to report — GatewaySpec is
    // required on the root — so this only guards against the wrong shape.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkAddresses(ctx, spec);
    checkInfrastructure(ctx, spec);
    checkListeners(ctx, spec);
  },
};

/* Addresses */

/**
 * An address the Gateway asks to be given. `type` defaults to `IPAddress`, and
 * what `value` may spell follows from it — the CRD says so through a `oneOf`
 * and a CEL rule rather than through the field's own schema, since a `pattern`
 * here would have to vary with the sibling `type`, which OpenAPI cannot
 * express. Two addresses of the same type may not ask for the same value: the
 * request would be granted once and the repeat would mean nothing.
 */
function checkAddresses(ctx: RuleContext, spec: Record<string, unknown>): void {
  const addresses = asArray(spec['addresses']);
  if (!addresses) return;

  const seen = new Map<string, number>();
  addresses.forEach((entry, index) => {
    const address = asObject(entry);
    if (!address) return;

    const value = asString(address['value']);
    if (value === undefined) return;
    const type = asString(address['type']) ?? 'IPAddress';
    const path: Path = ['spec', 'addresses', index, 'value'];

    checkAddressValue(ctx, type, value, path);

    // A NamedAddress, or an implementation-specific type, is left alone: what
    // its value means is the implementation's business, and the apiserver
    // asks for uniqueness only within the two types it understands itself.
    if (type !== 'IPAddress' && type !== 'Hostname') return;

    const key = `${type} ${value}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }

    ctx.report({
      ruleId: 'gateway/duplicate-address',
      severity: 'error',
      path,
      message: `addresses[${index}] repeats the ${type} "${value}" already asked for by addresses[${first}].`,
      explanation:
        'Each address is a request for the Gateway to be reachable at one place, so asking for the same one twice adds nothing to the first. The apiserver requires the values of each type to be unique.',
      docsUrl: GATEWAY_DOCS,
    });
  });
}

function checkAddressValue(ctx: RuleContext, type: string, value: string, path: Path): void {
  if (type === 'IPAddress') {
    const check = isIPAddress(value);
    if (check.ok) return;
    ctx.report({
      ruleId: 'gateway/invalid-address-value',
      severity: 'error',
      path,
      message: `"${value}" is not a valid IP address: it ${check.reason}.`,
      explanation:
        'The address type defaults to "IPAddress", whose value the apiserver checks is a literal IPv4 or IPv6 address. Set type: Hostname beside it to ask for a name instead.',
      docsUrl: GATEWAY_DOCS,
    });
    return;
  }

  // An empty value is how a Hostname address asks the implementation to pick
  // the name itself, which the CEL rule allows explicitly.
  if (type !== 'Hostname' || value === '') return;

  const check = value.startsWith('*.')
    ? isWildcardDNS1123Subdomain(value)
    : isDNS1123Subdomain(value);
  if (check.ok) return;

  ctx.report({
    ruleId: 'gateway/invalid-address-value',
    severity: 'error',
    path,
    message: `"${value}" is not a valid hostname: it ${check.reason}.`,
    explanation:
      'A "Hostname" address is a DNS name, optionally prefixed with one "*." wildcard label: lowercase letters, digits, "-" and ".", each label starting and ending with an alphanumeric character.',
    docsUrl: GATEWAY_DOCS,
  });
}

/* Infrastructure */

/**
 * The labels and annotations the implementation copies onto the resources it
 * creates for this Gateway. Their keys are checked as qualified names, which
 * the CRD expresses in CEL rather than in the schema — a map's keys are not a
 * field OpenAPI can put a `pattern` on. The values do carry their own
 * `pattern` and `maxLength`, so layer 1 already reports those.
 */
function checkInfrastructure(ctx: RuleContext, spec: Record<string, unknown>): void {
  const infrastructure = asObject(spec['infrastructure']);
  if (!infrastructure) return;

  checkKeyedMap(ctx, infrastructure['labels'], ['spec', 'infrastructure', 'labels'], 'label', false);
  checkKeyedMap(
    ctx,
    infrastructure['annotations'],
    ['spec', 'infrastructure', 'annotations'],
    'annotation',
    false,
  );
}

/* Listeners */

function checkListeners(ctx: RuleContext, spec: Record<string, unknown>): void {
  const listeners = asArray(spec['listeners']);
  if (!listeners) return;

  const seen = new Map<string, number>();
  listeners.forEach((entry, index) => {
    const listener = asObject(entry);
    if (!listener) return;
    const path: Path = ['spec', 'listeners', index];

    checkListenerTLS(ctx, listener, path);
    checkListenerHostname(ctx, listener, path);

    const port = asNumber(listener['port']);
    const protocol = asString(listener['protocol']);
    if (port === undefined || protocol === undefined) return;

    // A listener with no hostname is its own case rather than one matching
    // every name, so it never collides with a listener that names one — hence
    // the marker, which no hostname can carry.
    const hostname = asString(listener['hostname']);
    const key = `${port} ${protocol} ${hostname === undefined ? '' : `=${hostname}`}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }

    ctx.report({
      ruleId: 'gateway/duplicate-listener',
      severity: 'error',
      path,
      anchor: 'key',
      message: `listeners[${index}] and listeners[${first}] both listen for ${protocol} on port ${port}${
        hostname === undefined ? '' : ` with hostname "${hostname}"`
      }.`,
      explanation:
        'A request reaches a listener by the port it arrived on, the protocol it speaks and the name it asked for, so two listeners agreeing on all three are indistinguishable and nothing would ever be routed by the second. The apiserver requires the combination to be unique.',
      docsUrl: GATEWAY_DOCS,
    });
  });
}

/**
 * TLS configuration only means something for a protocol that negotiates TLS,
 * and only "Terminate" mode reads a certificate — so HTTPS, which is defined
 * as TLS terminated at the Gateway, may not ask to pass it through.
 */
function checkListenerTLS(ctx: RuleContext, listener: Record<string, unknown>, path: Path): void {
  const declared = listener['tls'];
  if (declared === undefined) return;
  const tls = asObject(declared);
  if (!tls) return;

  const protocol = asString(listener['protocol']);
  const tlsPath: Path = [...path, 'tls'];

  if (protocol !== undefined && PLAINTEXT_PROTOCOLS.includes(protocol)) {
    ctx.report({
      ruleId: 'gateway/tls-not-allowed',
      severity: 'error',
      path: tlsPath,
      anchor: 'key',
      message: `A listener speaking "${protocol}" must not carry a tls block.`,
      explanation: `${PLAINTEXT_PROTOCOLS.join(', ')} listeners are not TLS-terminated, so there is no handshake for a certificate or a mode to apply to. A listener meant to serve TLS says so through its protocol — HTTPS, or TLS for a stream it does not read.`,
      docsUrl: TLS_DOCS,
      fix: { title: 'Remove tls', safe: false, ops: [{ op: 'delete', path: tlsPath }] },
    });
    return;
  }

  // The mode defaults to Terminate, and a CRD's defaults are applied before
  // its CEL rules run — so an absent mode is checked as Terminate rather than
  // sitting the check out, and writing "Passthrough" by hand is the only way
  // an HTTPS listener can disagree with its own protocol. An unrecognised
  // spelling is schema/enum's report.
  const mode = asString(tls['mode']) ?? MODE_TERMINATE;

  if (protocol === 'HTTPS' && mode === 'Passthrough') {
    ctx.report({
      ruleId: 'gateway/tls-mode',
      severity: 'error',
      path: [...tlsPath, 'mode'],
      message: 'An HTTPS listener must terminate TLS; its tls.mode may only be "Terminate".',
      explanation:
        'Passthrough hands the encrypted stream to the backend untouched, which leaves the Gateway unable to read the HTTP request it would have to route on. A listener that passes TLS through speaks protocol TLS, not HTTPS.',
      docsUrl: TLS_DOCS,
      fix: {
        title: `Set tls.mode: ${MODE_TERMINATE}`,
        safe: false,
        ops: [{ op: 'set', path: [...tlsPath, 'mode'], value: MODE_TERMINATE }],
      },
    });
    return;
  }

  if (mode !== MODE_TERMINATE) return;

  const certificateRefs = asArray(tls['certificateRefs'])?.length ?? 0;
  const options = Object.keys(asObject(tls['options']) ?? {}).length;
  if (certificateRefs > 0 || options > 0) return;

  ctx.report({
    ruleId: 'gateway/tls-needs-certificate',
    severity: 'error',
    path: tlsPath,
    anchor: 'key',
    message: 'A "Terminate" listener must set tls.certificateRefs or tls.options.',
    explanation:
      'Terminating TLS means completing the handshake at the Gateway, which cannot be done without a certificate: certificateRefs names the Secret holding one, and options is how an implementation is told to source it some other way. Since the mode defaults to Terminate, leaving it out is the same as writing it.',
    docsUrl: TLS_DOCS,
  });
}

/** TCP and UDP carry no name for a listener's hostname to be matched against. */
function checkListenerHostname(
  ctx: RuleContext,
  listener: Record<string, unknown>,
  path: Path,
): void {
  const hostname = asString(listener['hostname']);
  if (hostname === undefined || hostname === '') return;

  const protocol = asString(listener['protocol']);
  if (protocol === undefined || !HOSTNAMELESS_PROTOCOLS.includes(protocol)) return;

  ctx.report({
    ruleId: 'gateway/hostname-not-allowed',
    severity: 'error',
    path: [...path, 'hostname'],
    message: `A listener speaking "${protocol}" must not set a hostname.`,
    explanation:
      'A hostname is matched against the SNI of a TLS handshake or the Host header of an HTTP request, and a raw TCP or UDP listener sees neither — there is nothing to compare it to. The apiserver rejects the pair rather than ignore the field.',
    docsUrl: GATEWAY_DOCS,
    fix: {
      title: 'Remove hostname',
      safe: false,
      ops: [{ op: 'delete', path: [...path, 'hostname'] }],
    },
  });
}
