import { isDNS1123Subdomain, isPathSegmentName, suggestName } from '../../k8s/names.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const BINDING_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding';
const SUBJECTS_DOCS =
  'https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects';

/** The one API group a roleRef may name, and the one a User or Group subject may. */
const RBAC_GROUP = 'rbac.authorization.k8s.io';

const SERVICE_ACCOUNT = 'ServiceAccount';

/**
 * The three kinds `appliesToUser` knows how to match a request's user against.
 * A kind outside them is rejected, which is `enum/invalid-value`'s to report:
 * `Subject.kind` is in the enum table, so this list is only ever consulted to
 * decide whether there is anything further worth saying about the entry.
 */
const SUBJECT_KINDS = [SERVICE_ACCOUNT, 'User', 'Group'];

/**
 * The checks worth making on a RoleBinding. `ValidateRoleBinding` is the
 * shortest validator of the three RBAC kinds here — the object's metadata, the
 * three fields of `roleRef`, then `ValidateRoleBindingSubject` per entry — and
 * it is unusual in how much of it turns on *defaulting* rather than on the
 * document: `SetDefaults_RoleBinding` fills an absent `roleRef.apiGroup` in
 * with the RBAC group, and `SetDefaults_Subject` fills an absent subject
 * `apiGroup` in from the subject's kind. Both run before validation, so an
 * omitted api group is always right and only one written by hand can be wrong
 * — the same trap `storageclass.ts` documents for `volumeBindingMode`, and the
 * inverse of the Job `restartPolicy` case where the default is itself invalid.
 *
 * Layer 1 covers the required half: `roleRef` is in RoleBinding's `required`
 * list, `kind` and `name` are in RoleRef's and in Subject's. What is left is
 * what OpenAPI cannot express — upstream asks for a *length* where the schema
 * asks for a key, so an empty string is this module's to report where a
 * missing one is not, the same split `ingress.ts` and `role.ts` document — plus
 * the two enum fields, which are `rules/enums.ts`'s (`RoleRef.kind` and
 * `Subject.kind`), and the name formats: a `roleRef.name` is an RBAC name and
 * so a path segment, exactly as the binding's own name is, while a
 * ServiceAccount subject's name is validated as a ServiceAccount's own name —
 * a DNS subdomain. A User or Group name is not checked at all, those coming
 * from an authenticator rather than from an object.
 *
 * Past the rejections are the things a binding says that the authorizer never
 * reads. A `namespace` beside a User or a Group subject is the widest of them:
 * `appliesToUser` compares a User subject to the request user's name and looks
 * for a Group subject among their groups, consulting the field for neither, so
 * it is stored verbatim and silently means nothing — the Subject type's own
 * description says an authorizer "should report an error" for it, and none
 * does. A ServiceAccount subject's absent namespace is deliberately *not*
 * reported: the authorizer defaults it to the binding's own namespace, which
 * is the idiomatic way to write one.
 *
 * Like the two RBAC kinds before it a RoleBinding has no `spec` — `roleRef`
 * and `subjects` hang directly off the document — so this module addresses
 * `ctx.doc`, and its name is a path segment rather than a DNS name of any
 * sort, which the descriptor's `nameFormat` says and `metadata.ts` reads.
 *
 * Deliberately not checked: whether the referenced Role or ClusterRole exists,
 * or whether a ServiceAccount subject names a real one — both are questions
 * about what a cluster holds rather than about the document, the same reason
 * `role.ts` does not ask whether a named resource exists. The immutability of
 * `roleRef` is skipped too, since it only constrains an update. Nothing here
 * is version-gated: rbac/v1 has been served unchanged since 1.8.
 */
export const roleBindingRule: Rule = {
  id: 'rolebinding/fields',
  run(ctx: RuleContext) {
    checkRoleRef(ctx);
    checkSubjects(ctx);
  },
};

/* roleRef, the half that says which rules */

function checkRoleRef(ctx: RuleContext): void {
  // An absent roleRef is schema/required-field, and one of the wrong shape is
  // schema/type; either way there is nothing here to read.
  const roleRef = asObject(ctx.doc['roleRef']);
  if (!roleRef) return;

  checkRoleRefApiGroup(ctx, roleRef);
  checkRoleRefName(ctx, roleRef);
  // roleRef.kind is Subject.kind's neighbour in the enum table, so an
  // unrecognised one has already been reported as enum/invalid-value.
}

function checkRoleRefApiGroup(ctx: RuleContext, roleRef: Record<string, unknown>): void {
  const apiGroup = asString(roleRef['apiGroup']);
  // Absent and empty are the same length to Go, and SetDefaults_RoleBinding
  // fills either in with the RBAC group before validation sees the object —
  // so only a non-empty wrong value is ever rejected.
  if (apiGroup === undefined || apiGroup === '' || apiGroup === RBAC_GROUP) return;

  const path: Path = ['roleRef', 'apiGroup'];
  ctx.report({
    ruleId: 'rolebinding/invalid-role-ref-api-group',
    severity: 'error',
    path,
    message: `A roleRef can only point into "${RBAC_GROUP}", not "${apiGroup}".`,
    explanation: `The apiserver rejects this with "supported values: \\"${RBAC_GROUP}\\"". Only a Role or a ClusterRole can be bound — the binding infrastructure was built for RBAC's own two kinds and has never been opened to another group — so this field has exactly one legal value, and leaving it out gets that value filled in for you.`,
    docsUrl: BINDING_DOCS,
    fix: {
      // Unambiguous: one value is accepted, so there is nothing to choose.
      title: `Change to "${RBAC_GROUP}"`,
      safe: true,
      ops: [{ op: 'set', path, value: RBAC_GROUP }],
    },
  });
}

function checkRoleRefName(ctx: RuleContext, roleRef: Record<string, unknown>): void {
  const name = asString(roleRef['name']);
  // An absent name is in RoleRef's `required` list and so already reported.
  if (name === undefined) return;
  const path: Path = ['roleRef', 'name'];

  if (name === '') {
    ctx.report({
      ruleId: 'rolebinding/missing-role-ref-name',
      severity: 'error',
      path,
      message: 'This roleRef names no role.',
      explanation:
        'The apiserver asks for a length here rather than for a key, so a name written as an empty string is rejected exactly as a missing one is. A binding is nothing but the pairing of a role with the identities it applies to; without the role there is nothing to pair.',
      docsUrl: BINDING_DOCS,
    });
    return;
  }

  const check = isPathSegmentName(name);
  if (check.ok) return;

  ctx.report({
    ruleId: 'rolebinding/invalid-role-ref-name',
    severity: 'error',
    path,
    message: `No role can be named "${name}": it ${check.reason}.`,
    explanation:
      'A roleRef is validated with ValidateRBACName, the same function the binding\'s own name goes through: anything spellable as one segment of a request URL will do, uppercase letters and ":" included, and only ".", "..", "/" and "%" are refused. So a name this loose format rejects could not have been given to any Role or ClusterRole either, and the reference could never resolve.',
    docsUrl: BINDING_DOCS,
  });
}

/* subjects, the half that says who */

function checkSubjects(ctx: RuleContext): void {
  const declared = ctx.doc['subjects'];
  // A subjects that is neither a list nor absent is layer 1's to report. A key
  // written with no value decodes to null, which the apiserver reads as the
  // empty list exactly as it reads an absent one, so it lands below.
  if (declared != null && asArray(declared) === undefined) return;
  const subjects = asArray(declared);

  if (subjects === undefined || subjects.length === 0) {
    ctx.report({
      ruleId: 'rolebinding/no-subjects',
      severity: 'warning',
      path: 'subjects' in ctx.doc ? ['subjects'] : [],
      message: 'This RoleBinding grants nothing: it has no subjects.',
      explanation:
        'A binding exists to connect a role\'s rules to the identities they apply to, and this list is those identities — so with none of them the role below is never consulted for anyone. The apiserver stores the binding without complaint and it stays inert for the life of the object.',
      docsUrl: SUBJECTS_DOCS,
    });
    return;
  }

  /** Subjects already seen, by the identity the authorizer matches on. */
  const seen = new Map<string, number>();

  subjects.forEach((entry, index) => {
    const subject = asObject(entry);
    if (!subject) return;
    checkSubject(ctx, subject, ['subjects', index], index, seen);
  });
}

function checkSubject(
  ctx: RuleContext,
  subject: Record<string, unknown>,
  base: Path,
  index: number,
  seen: Map<string, number>,
): void {
  const kind = asString(subject['kind']);
  const name = asString(subject['name']);

  // `name` is in Subject's `required` list, so an absent one is layer 1's;
  // upstream asks for a length, which leaves the empty string to this.
  if (name === '') {
    ctx.report({
      ruleId: 'rolebinding/missing-subject-name',
      severity: 'error',
      path: [...base, 'name'],
      message: 'This subject names nobody.',
      explanation:
        'The apiserver asks for a length here rather than for a key, so a name written as an empty string is rejected exactly as a missing one is. A subject is a user, a group or a service account identified by name and nothing else — there is no wildcard and no default, so an empty name identifies no one.',
      docsUrl: SUBJECTS_DOCS,
    });
  }

  // A kind outside the three is enum/invalid-value's, and nothing below can
  // be said about a subject the authorizer will not know how to match anyway.
  if (kind === undefined || !SUBJECT_KINDS.includes(kind)) return;

  checkSubjectApiGroup(ctx, subject, base, kind);

  if (kind === SERVICE_ACCOUNT) {
    // An absent namespace is not reported: for a RoleBinding the authorizer
    // defaults it to the binding's own namespace, which is how a binding to a
    // ServiceAccount beside it is normally written.
    if (name !== undefined && name !== '') checkServiceAccountName(ctx, name, [...base, 'name']);
  } else {
    checkIgnoredNamespace(ctx, subject, base, kind);
  }

  if (name === undefined || name === '') return;
  checkDuplicate(ctx, subject, base, index, kind, name, seen);
}

/**
 * A subject's api group against the kind beside it. Both branches upstream
 * compare a value it has already defaulted from that kind, so an absent field
 * is right for every kind and this only ever measures one written by hand.
 */
function checkSubjectApiGroup(
  ctx: RuleContext,
  subject: Record<string, unknown>,
  base: Path,
  kind: string,
): void {
  const apiGroup = asString(subject['apiGroup']);
  // SetDefaults_Subject rewrites a zero-length api group from the kind — "" for
  // a ServiceAccount, the RBAC group for a User or a Group — so an explicit
  // empty string is as correct as leaving the field out.
  if (apiGroup === undefined || apiGroup === '') return;
  if (kind !== SERVICE_ACCOUNT && apiGroup === RBAC_GROUP) return;

  const path: Path = [...base, 'apiGroup'];
  ctx.report({
    ruleId: 'rolebinding/invalid-subject-api-group',
    severity: 'error',
    path,
    message:
      kind === SERVICE_ACCOUNT
        ? `A ServiceAccount subject cannot carry an apiGroup, and "${apiGroup}" is one.`
        : `A ${kind} subject's apiGroup must be "${RBAC_GROUP}", not "${apiGroup}".`,
    explanation:
      kind === SERVICE_ACCOUNT
        ? 'The apiserver rejects this with "supported values: \\"\\"". A ServiceAccount is an object of the core API group, whose name is the empty string, and the check here is on the field\'s length rather than on its value — so the only thing it may say is nothing at all. Leaving it out says that: the apiserver fills it in from the kind before it looks.'
        : `The apiserver rejects this with "supported values: \\"${RBAC_GROUP}\\"". A User or a Group is not an object in any API group — the names come from whatever authenticated the request — so RBAC gives them its own group as a constant rather than as a reference to anything, and no other value means anything here. Leaving it out gets that constant filled in for you.`,
    docsUrl: SUBJECTS_DOCS,
    fix:
      kind === SERVICE_ACCOUNT
        ? {
            // Deleting it is the whole correction: the only accepted value is
            // the empty one the default supplies.
            title: 'Remove apiGroup',
            safe: true,
            ops: [{ op: 'delete', path }],
          }
        : {
            title: `Change to "${RBAC_GROUP}"`,
            safe: true,
            ops: [{ op: 'set', path, value: RBAC_GROUP }],
          },
  });
}

/**
 * A ServiceAccount subject's name, which upstream checks with
 * `ValidateServiceAccountName` — the ServiceAccount's own name format. The
 * other two kinds are deliberately unchecked: a User or Group name is whatever
 * the authenticator produced, which no format here can anticipate.
 */
function checkServiceAccountName(ctx: RuleContext, name: string, path: Path): void {
  const check = isDNS1123Subdomain(name);
  if (check.ok) return;

  const suggestion = suggestName(name);
  ctx.report({
    ruleId: 'rolebinding/invalid-subject-name',
    severity: 'error',
    path,
    message: `No ServiceAccount can be named "${name}": it ${check.reason}.`,
    explanation:
      'A ServiceAccount subject names an object, so the apiserver validates it as that object\'s own name is validated — a DNS subdomain — and rejects the binding when it is not one. Note that this is stricter than the binding\'s own name, and stricter than a User or Group subject\'s, neither of which is checked at all: those identify whoever the authenticator says made the request rather than anything the cluster stores.',
    docsUrl: SUBJECTS_DOCS,
    fix: suggestion
      ? {
          // Which ServiceAccount was meant is a guess: the name has to match an
          // object elsewhere, which this document cannot show.
          title: `Change to "${suggestion}"`,
          safe: false,
          ops: [{ op: 'set', path, value: suggestion }],
        }
      : undefined,
  });
}

/**
 * A `namespace` written beside a User or a Group. Neither branch of
 * `appliesToUser` reads the field for those kinds, and nothing strips it, so
 * the binding is stored saying something the authorizer will never consult.
 */
function checkIgnoredNamespace(
  ctx: RuleContext,
  subject: Record<string, unknown>,
  base: Path,
  kind: string,
): void {
  if (subject['namespace'] === undefined) return;

  const path: Path = [...base, 'namespace'];
  ctx.report({
    ruleId: 'rolebinding/ignored-subject-namespace',
    severity: 'warning',
    path,
    message: `namespace is ignored: a ${kind} subject does not live in one.`,
    explanation:
      'RBAC matches a User subject by comparing its name with the request user\'s name, and a Group subject by looking for its name among that user\'s groups. Neither comparison touches this field, and the apiserver neither rejects it nor drops it — the Subject type\'s own description says an authorizer "should report an error" for it, and none does — so it is stored verbatim and means nothing. Only a ServiceAccount subject, which names an object that really does live in a namespace, reads it.',
    docsUrl: SUBJECTS_DOCS,
    fix: {
      // Inert as written, but which half is the mistake is a genuine question:
      // a namespace beside a name often means a ServiceAccount was intended,
      // and then the kind is what wants correcting rather than this.
      title: 'Remove the ignored namespace',
      safe: false,
      ops: [{ op: 'delete', path }],
    },
  });
}

/**
 * The same subject listed twice. The authorizer stops at the first entry the
 * request's user matches, so a repeat grants nothing further — which is why
 * the apiserver stores it without a word.
 */
function checkDuplicate(
  ctx: RuleContext,
  subject: Record<string, unknown>,
  base: Path,
  index: number,
  kind: string,
  name: string,
  seen: Map<string, number>,
): void {
  // The identity is exactly what `appliesToUser` compares, and no more. The api
  // group is left out because for a kind the authorizer recognises it is
  // determined by that kind, so it can only repeat what `kind` already says.
  // The namespace is left out for a User or a Group for the stronger reason
  // that no branch reads it there — which is what makes two entries differing
  // only in an ignored namespace the same subject. On a ServiceAccount it is
  // compared as written rather than resolved against the binding's own, since
  // an absent one defaults to a namespace this document may not name.
  const namespace = kind === SERVICE_ACCOUNT ? (asString(subject['namespace']) ?? '') : '';
  const identity = `${kind}/${namespace}/${name}`;
  const first = seen.get(identity);
  if (first === undefined) {
    seen.set(identity, index);
    return;
  }

  ctx.report({
    ruleId: 'rolebinding/duplicate-subject',
    severity: 'warning',
    path: base,
    message: `This ${kind} is already listed by entry ${first + 1}.`,
    explanation:
      'The authorizer walks the subjects until one matches the request\'s user and stops there, so listing the same subject twice grants no further access and shadows nothing. The apiserver stores the list verbatim, duplicates included.',
    docsUrl: SUBJECTS_DOCS,
    fix: {
      title: 'Remove the duplicate subject',
      safe: true,
      ops: [{ op: 'delete', path: base }],
    },
  });
}
