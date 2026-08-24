import type { Path } from '../types.js';
import { asArray, asObject, asNumber, asString, type Rule, type RuleContext } from './context.js';

const GATEWAY_DOCS = 'https://gateway-api.sigs.k8s.io/api-types/grpcroute/';

const MAX_TOTAL_MATCHES = 128;

/** GRPCRouteFilter.type -> the field that type's config lives in. Unlike HTTPRoute, there is no RequestRedirect or URLRewrite. */
const FILTER_FIELDS: Record<string, string> = {
  RequestHeaderModifier: 'requestHeaderModifier',
  ResponseHeaderModifier: 'responseHeaderModifier',
  RequestMirror: 'requestMirror',
  ExtensionRef: 'extensionRef',
};

/** Filter types the apiserver allows at most once per list. */
const AT_MOST_ONCE = ['RequestHeaderModifier', 'ResponseHeaderModifier'] as const;

const SERVICE_PATTERN = /^\.?[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)*$/;
const METHOD_PATTERN = /^[A-Za-z_][A-Za-z_0-9]*$/;

/**
 * The checks the apiserver runs on a GRPCRoute through its
 * `x-kubernetes-validations` (CEL) rules — the same mechanism `rules/httproute.ts`
 * reimplements for HTTPRoute. GRPCRoute shares several of HTTPRoute's own
 * sub-types verbatim (ParentReference, the header-modifier and request-mirror
 * filters, a Service backendRef's port requirement), so those checks mirror
 * httproute.ts's; what differs is the match itself — a GRPCRouteMatch matches
 * on service/method rather than a path — and the narrower filter set, which
 * has no RequestRedirect or URLRewrite to reject alongside backendRefs or to
 * rewrite a path with.
 *
 * As with HTTPRoute, what layer 1 already derives from the CRD's own OpenAPI
 * schema — every name, hostname and header name's own `pattern`, `enum`,
 * `minLength` or `maxLength` — is deliberately absent here; only what CEL
 * alone can express is checked below. GRPCRoute's schema is generated from
 * the same pinned Gateway API release as HTTPRoute's, so nothing here is
 * version-gated either.
 */
export const grpcRouteRule: Rule = {
  id: 'grpcroute/spec',
  run(ctx: RuleContext) {
    // An absent spec is schema/required-field's to report — GRPCRouteSpec is
    // required on the root — so this only guards against the wrong shape.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkParentRefs(ctx, spec);

    const rules = asArray(spec['rules']);
    if (!rules) return;

    checkTotalMatches(ctx, rules);
    rules.forEach((entry, index) => {
      const rule = asObject(entry);
      if (rule) checkRule(ctx, rule, ['spec', 'rules', index]);
    });
  },
};

/* parentRefs */

/**
 * Two or more references to the same parent object need a `sectionName` each
 * to say which of its listeners they mean, and those names must not repeat —
 * the same ParentReference rule httproute.ts checks, since a GRPCRoute's
 * parentRefs are the same Go type.
 */
function checkParentRefs(ctx: RuleContext, spec: Record<string, unknown>): void {
  const parentRefs = asArray(spec['parentRefs']);
  if (!parentRefs) return;

  const groups = new Map<string, { index: number; sectionName?: string }[]>();
  parentRefs.forEach((entry, index) => {
    const ref = asObject(entry);
    const name = ref ? asString(ref['name']) : undefined;
    if (!ref || name === undefined) return;

    const group = asString(ref['group']) ?? 'gateway.networking.k8s.io';
    const kind = asString(ref['kind']) ?? 'Gateway';
    const namespace = asString(ref['namespace']) ?? '';
    const key = `${group} ${kind} ${name} ${namespace}`;
    const list = groups.get(key) ?? [];
    list.push({ index, sectionName: asString(ref['sectionName']) });
    groups.set(key, list);
  });

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;

    const seenSections = new Map<string, number>();
    for (const entry of entries) {
      const path: Path = ['spec', 'parentRefs', entry.index];
      if (entry.sectionName === undefined || entry.sectionName === '') {
        ctx.report({
          ruleId: 'grpcroute/parent-ref-needs-section-name',
          severity: 'error',
          path,
          anchor: 'key',
          message: `parentRefs[${entry.index}] must set sectionName: more than one reference points at the same parent.`,
          explanation:
            'A Gateway can expose more than one listener, so once two parentRefs name the same parent object there is nothing left to tell them apart except which listener each one attaches to. The apiserver requires sectionName as soon as a parent is referenced more than once.',
          docsUrl: GATEWAY_DOCS,
        });
        continue;
      }

      const first = seenSections.get(entry.sectionName);
      if (first === undefined) {
        seenSections.set(entry.sectionName, entry.index);
      } else {
        ctx.report({
          ruleId: 'grpcroute/duplicate-parent-ref-section',
          severity: 'error',
          path: [...path, 'sectionName'],
          message: `parentRefs[${entry.index}] and parentRefs[${first}] both name sectionName "${entry.sectionName}" on the same parent.`,
          explanation:
            'sectionName picks out one listener on the parent, so two references to the same parent naming the same section are redundant, and the apiserver rejects the repeat.',
          docsUrl: GATEWAY_DOCS,
        });
      }
    }
  }
}

/* Rules and matches */

/**
 * 16 rules and 64 matches per rule are each allowed on their own, but the
 * total across every rule in the route must still stay under 128, the same
 * cap httproute.ts checks.
 */
function checkTotalMatches(ctx: RuleContext, rules: unknown[]): void {
  let total = 0;
  for (const entry of rules) {
    const rule = asObject(entry);
    total += (rule ? asArray(rule['matches'])?.length : undefined) ?? 0;
  }
  if (total >= MAX_TOTAL_MATCHES) {
    ctx.report({
      ruleId: 'grpcroute/too-many-matches',
      severity: 'error',
      path: ['spec', 'rules'],
      message: `This GRPCRoute declares ${total} matches across all rules; the apiserver allows fewer than ${MAX_TOTAL_MATCHES}.`,
      explanation:
        'Up to 16 rules and 64 matches per rule are each allowed, but the total across every rule in the route is capped separately, since each match becomes route-table state the data plane has to hold.',
      docsUrl: GATEWAY_DOCS,
    });
  }
}

function checkRule(ctx: RuleContext, rule: Record<string, unknown>, path: Path): void {
  asArray(rule['matches'])?.forEach((entry, index) => {
    const match = asObject(entry);
    if (match) checkMatch(ctx, match, [...path, 'matches', index]);
  });

  checkFilterList(ctx, asArray(rule['filters']), [...path, 'filters']);

  asArray(rule['backendRefs'])?.forEach((entry, index) => {
    const backendRef = asObject(entry);
    if (!backendRef) return;
    const backendPath: Path = [...path, 'backendRefs', index];
    checkBackendPortRequired(ctx, backendRef, backendPath);
    checkFilterList(ctx, asArray(backendRef['filters']), [...backendPath, 'filters']);
  });
}

/**
 * A GRPCRouteMatch matches on service and/or method rather than a path: at
 * least one of the two must be set, and — only for the default `Exact` type,
 * a `RegularExpression` carrying none of these restrictions — each has to
 * look like the gRPC name it is matched against. Neither the "at least one"
 * rule nor the character sets are expressible as a sibling-conditioned
 * `pattern` in OpenAPI, so both are CEL-only and checked here.
 */
function checkMatch(ctx: RuleContext, match: Record<string, unknown>, path: Path): void {
  const method = asObject(match['method']);
  if (!method) return;
  const methodPath: Path = [...path, 'method'];

  const service = asString(method['service']);
  const methodName = asString(method['method']);
  if (service === undefined && methodName === undefined) {
    ctx.report({
      ruleId: 'grpcroute/match-needs-service-or-method',
      severity: 'error',
      path: methodPath,
      anchor: 'key',
      message: 'method must set at least one of "service" or "method".',
      explanation: 'A match with neither set matches every service and method, which is what an absent "method" block already means, so the apiserver rejects the empty form.',
      docsUrl: GATEWAY_DOCS,
    });
  }

  const type = asString(method['type']) ?? 'Exact';
  if (type !== 'Exact') return;

  if (service !== undefined && !SERVICE_PATTERN.test(service)) {
    ctx.report({
      ruleId: 'grpcroute/match-service-format',
      severity: 'error',
      path: [...methodPath, 'service'],
      message: `"${service}" is not a valid gRPC service name.`,
      explanation: 'An Exact match compares the service name as written, so it has to look like one: letters, digits and underscores, dot-separated, with an optional leading dot.',
      docsUrl: GATEWAY_DOCS,
    });
  }

  if (methodName !== undefined && !METHOD_PATTERN.test(methodName)) {
    ctx.report({
      ruleId: 'grpcroute/match-method-format',
      severity: 'error',
      path: [...methodPath, 'method'],
      message: `"${methodName}" is not a valid gRPC method name.`,
      explanation: 'An Exact match compares the method name as written, so it has to look like one: letters, digits and underscores, and it may not start with a digit.',
      docsUrl: GATEWAY_DOCS,
    });
  }
}

/* Backends */

/** A reference to a Service — group "" and kind "Service", both the defaults — must say which port. */
function checkBackendPortRequired(ctx: RuleContext, ref: Record<string, unknown>, path: Path): void {
  const group = asString(ref['group']) ?? '';
  const kind = asString(ref['kind']) ?? 'Service';
  if (group !== '' || kind !== 'Service') return;
  if (ref['port'] !== undefined) return;

  ctx.report({
    ruleId: 'grpcroute/backend-port-required',
    severity: 'error',
    path,
    anchor: 'key',
    message: 'A reference to a Service backend must set "port".',
    explanation:
      'A Service can expose more than one port, so a backend reference to one — the default when "group" and "kind" are left unset — has to say which. The apiserver rejects a Service reference with none.',
    docsUrl: GATEWAY_DOCS,
  });
}

/* Filters */

/**
 * The checks that apply to one filters list as a whole: RequestHeaderModifier
 * and ResponseHeaderModifier may each appear at most once. Then each filter
 * in the list is checked on its own. Unlike httproute.ts there is no
 * RequestRedirect/URLRewrite pair to reject together, since GRPCRoute has
 * neither filter type.
 */
function checkFilterList(ctx: RuleContext, filters: unknown[] | undefined, path: Path): void {
  if (!filters) return;

  const items = filters
    .map((entry) => asObject(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const countOf = (type: string) => items.filter((entry) => entry['type'] === type).length;

  for (const type of AT_MOST_ONCE) {
    const count = countOf(type);
    if (count > 1) {
      ctx.report({
        ruleId: 'grpcroute/duplicate-filter',
        severity: 'error',
        path,
        anchor: 'key',
        message: `A ${type} filter appears ${count} times in the same list; it may appear at most once.`,
        explanation: 'Applying the same kind of filter more than once leaves no defined order to apply them in, so the apiserver rejects the repeat.',
        docsUrl: GATEWAY_DOCS,
      });
    }
  }

  filters.forEach((entry, index) => {
    const filter = asObject(entry);
    if (filter) checkFilter(ctx, filter, [...path, index]);
  });
}

function checkFilter(ctx: RuleContext, filter: Record<string, unknown>, path: Path): void {
  checkFilterTypeMatch(ctx, filter, path);

  const mirror = asObject(filter['requestMirror']);
  if (mirror) checkRequestMirror(ctx, mirror, [...path, 'requestMirror']);
}

/**
 * A filter's `type` says which of its four config fields the apiserver
 * reads; the schema can only express that each field is optional, not that
 * exactly one of them may be set and it must be the one `type` names.
 */
function checkFilterTypeMatch(ctx: RuleContext, filter: Record<string, unknown>, path: Path): void {
  const type = asString(filter['type']);
  // Missing is schema/required-field's to report, unrecognised is schema/enum's.
  if (type === undefined || !(type in FILTER_FIELDS)) return;

  for (const [filterType, field] of Object.entries(FILTER_FIELDS)) {
    const present = filter[field] !== undefined;
    if (filterType === type && !present) {
      ctx.report({
        ruleId: 'grpcroute/filter-type-mismatch',
        severity: 'error',
        path,
        anchor: 'key',
        message: `type: ${type} requires "${field}" to be set.`,
        explanation: `A filter's type says which of its fields the apiserver reads, so "${field}" must be present when type is "${filterType}".`,
        docsUrl: GATEWAY_DOCS,
      });
    } else if (filterType !== type && present) {
      ctx.report({
        ruleId: 'grpcroute/filter-type-mismatch',
        severity: 'error',
        path: [...path, field],
        anchor: 'key',
        message: `"${field}" is set, but type is "${type}", not "${filterType}".`,
        explanation: `A filter's type says which of its fields the apiserver reads; "${field}" only applies when type is "${filterType}", so it is rejected here rather than silently ignored.`,
        docsUrl: GATEWAY_DOCS,
      });
    }
  }
}

/** The same RequestMirror checks httproute.ts applies, since GRPCRoute's requestMirror filter is the very same HTTPRequestMirrorFilter type. */
function checkRequestMirror(ctx: RuleContext, mirror: Record<string, unknown>, path: Path): void {
  if (mirror['percent'] !== undefined && mirror['fraction'] !== undefined) {
    ctx.report({
      ruleId: 'grpcroute/mirror-percent-and-fraction',
      severity: 'error',
      path,
      anchor: 'key',
      message: 'requestMirror sets both "percent" and "fraction".',
      explanation:
        'The two both say what portion of requests to mirror, so naming both leaves no way to tell which one the apiserver should read. It rejects the pair instead of picking for you.',
      docsUrl: GATEWAY_DOCS,
    });
  }

  const fraction = asObject(mirror['fraction']);
  if (fraction) {
    const numerator = asNumber(fraction['numerator']);
    const denominator = asNumber(fraction['denominator']);
    if (numerator !== undefined && denominator !== undefined && numerator > denominator) {
      ctx.report({
        ruleId: 'grpcroute/fraction-numerator-exceeds-denominator',
        severity: 'error',
        path: [...path, 'fraction', 'numerator'],
        message: `fraction.numerator (${numerator}) must not be greater than fraction.denominator (${denominator}).`,
        explanation: 'The pair expresses what fraction of requests to mirror, so a numerator above the denominator describes more than the whole request stream.',
        docsUrl: GATEWAY_DOCS,
      });
    }
  }

  const backendRef = asObject(mirror['backendRef']);
  if (backendRef) checkBackendPortRequired(ctx, backendRef, [...path, 'backendRef']);
}
