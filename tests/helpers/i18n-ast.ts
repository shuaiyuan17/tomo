import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Syntax-level (TypeScript AST) checks for the i18n guardrails. The threat
 * model is our own code taking a shortcut or forgetting a step, not an
 * adversary: every ordinary way of writing a call is covered, exotic ones
 * (computed property access, re-exports, eval) are not.
 */

export interface Source { /** Absolute path. */ path: string; /** Repo-relative, for messages. */ file: string; text: string }

const repoRoot = resolve(import.meta.dirname, "../..");

/** Every .ts/.tsx file under `roots` (repo-relative), minus .d.ts and `catalogs/` directories. */
export function readSources(roots: readonly string[]): Source[] {
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "catalogs") continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push({ path, file: relative(repoRoot, path), text: readFileSync(path, "utf8") });
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return out;
}

function parse(source: Source): ts.SourceFile {
  return ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function forEachDescendant(node: ts.Node, visit: (node: ts.Node) => void): void {
  node.forEachChild((child) => { visit(child); forEachDescendant(child, visit); });
}

/** The file a relative import specifier names (`./x.js` → `/abs/x.ts`); null for packages. */
function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return resolve(dirname(from), specifier).replace(/\.js$/, ".ts");
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

// ---------------------------------------------------------------------------
// raw() and OwnerText casts

export interface EscapeHatchUses {
  /** file → number of calls that resolve to the i18n module's `raw`. */
  raw: Record<string, number>;
  /** Files that cast a value to `OwnerText` (`as OwnerText`, `<OwnerText>x`). */
  casts: string[];
}

/**
 * Calls of `raw` exported by `modulePath`, however it was imported: named
 * (`import { raw }`), renamed (`import { raw as r }`) or as a namespace
 * (`import * as i18n` then `i18n.raw(...)`). The defining module itself is skipped.
 */
export function findEscapeHatches(sources: readonly Source[], modulePath: string): EscapeHatchUses {
  const uses: EscapeHatchUses = { raw: {}, casts: [] };
  for (const source of sources) {
    if (source.path === modulePath) continue;
    const sf = parse(source);
    const direct = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (resolveImport(source.path, statement.moduleSpecifier.text) !== modulePath) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === "raw") direct.add(el.name.text);
    }
    let count = 0;
    let casts = false;
    forEachDescendant(sf, (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && direct.has(callee.text)) count++;
        else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && callee.name.text === "raw") count++;
      }
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && ts.isTypeReferenceNode(node.type)) {
        const name = node.type.typeName;
        if ((ts.isIdentifier(name) ? name.text : name.right.text) === "OwnerText") casts = true;
      }
    });
    if (count) uses.raw[source.file] = count;
    if (casts) uses.casts.push(source.file);
  }
  return uses;
}

// ---------------------------------------------------------------------------
// Translation keys used

export interface KeyUses {
  /** namespace → keys used with a literal (base keys: `t("msgs", { count })` is `msgs`). */
  used: Map<string, Set<string>>;
  /** Declared dynamic keys: `// i18n-dynamic: ns:prefix*` (a trailing `*` matches any rest). */
  dynamic: Array<{ ns: string; pattern: string; file: string }>;
  /** Translator calls whose key is not a literal (built at runtime). */
  unresolved: Array<{ file: string; at: string }>;
}

/** The namespace(s) a translator-producing expression binds, if it is one. */
function namespacesOf(expr: ts.Expression | undefined): string[] | undefined {
  if (!expr || !ts.isCallExpression(expr)) return undefined;
  const callee = expr.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const nsArg = name === "ownerT" || name === "useTranslation" ? expr.arguments[0] : name === "getFixedT" ? expr.arguments[1] : undefined;
  if (!nsArg) return undefined;
  const one = literalText(nsArg);
  if (one !== undefined) return [one];
  if (ts.isArrayLiteralExpression(nsArg)) {
    const all = nsArg.elements.map(literalText);
    if (all.every((x): x is string => x !== undefined)) return all;
  }
  return undefined;
}

/** `OwnerT<"ns">` / `TFunction<"ns">` type annotations bind a translator too. */
function namespacesOfType(type: ts.TypeNode | undefined): string[] | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || !type.typeArguments?.length) return undefined;
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
  if (name !== "OwnerT" && name !== "TFunction") return undefined;
  const arg = type.typeArguments[0]!;
  return ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? [arg.literal.text] : undefined;
}

/** Translators declared directly by `scope` (its statements, or a function's parameters): name → namespaces. */
function bindingsOf(scope: ts.Node, cache: Map<ts.Node, Map<string, string[]>>): Map<string, string[]> {
  const cached = cache.get(scope);
  if (cached) return cached;
  const out = new Map<string, string[]>();
  const fromDeclaration = (decl: ts.VariableDeclaration | ts.ParameterDeclaration) => {
    const ns = namespacesOf(decl.initializer) ?? namespacesOfType(decl.type);
    if (!ns) return;
    if (ts.isIdentifier(decl.name)) out.set(decl.name.text, ns);
    else if (ts.isObjectBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
        if (prop === "t" && ts.isIdentifier(el.name)) out.set(el.name.text, ns);
      }
    }
  };
  if (ts.isFunctionLike(scope)) for (const p of scope.parameters) fromDeclaration(p);
  const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) for (const decl of statement.declarationList.declarations) fromDeclaration(decl);
  }
  cache.set(scope, out);
  return out;
}

/** The namespaces `name` is bound to at `node`, nearest enclosing scope first. */
function lookup(node: ts.Node, name: string, cache: Map<ts.Node, Map<string, string[]>>): string[] | undefined {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    const hit = bindingsOf(scope, cache).get(name);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Keys used with a literal: calls of a translator from `ownerT("ns")`,
 * `useTranslation("ns")` (`const { t } = ...`), `getFixedT(lng, "ns")`, or a
 * variable/parameter typed `OwnerT<"ns">` / `TFunction<"ns">`; a direct
 * `ownerT("ns")("key")`; `i18n.t("ns:key")`; and `<Trans i18nKey="..." ns="...">`.
 * A key written `ns:key` names its own namespace. A call of `t` with no
 * binding in scope uses `defaultNS`. Keys built at runtime are not
 * readable: declare them with an `// i18n-dynamic: ns:prefix*` comment.
 */
export function findUsedKeys(sources: readonly Source[], namespaces: ReadonlySet<string>, defaultNS?: string): KeyUses {
  const uses: KeyUses = { used: new Map(), dynamic: [], unresolved: [] };
  const add = (ns: string, key: string) => {
    const set = uses.used.get(ns) ?? new Set<string>();
    set.add(key);
    uses.used.set(ns, set);
  };
  const record = (bound: string[] | undefined, key: string) => {
    const colon = key.indexOf(":");
    if (colon > 0 && namespaces.has(key.slice(0, colon))) return add(key.slice(0, colon), key.slice(colon + 1));
    const ns = bound?.[0] ?? defaultNS;
    if (ns) add(ns, key);
  };
  for (const source of sources) {
    for (const m of source.text.matchAll(/\/\/\s*i18n-dynamic:\s*([\w-]+):(\S+)/g)) uses.dynamic.push({ ns: m[1]!, pattern: m[2]!, file: source.file });
    const sf = parse(source);
    const cache = new Map<ts.Node, Map<string, string[]>>();
    const where = (node: ts.Node) => `${source.file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    forEachDescendant(sf, (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let bound: string[] | undefined;
        let isTranslator = false;
        if (ts.isIdentifier(callee)) {
          bound = lookup(node, callee.text, cache);
          isTranslator = !!bound || callee.text === "t";
        } else if (ts.isCallExpression(callee) && namespacesOf(callee)) {
          bound = namespacesOf(callee);
          isTranslator = true;
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "t" && node.arguments.length > 0) {
          isTranslator = true;
        }
        if (!isTranslator || node.arguments.length === 0) return;
        const key = literalText(node.arguments[0]);
        if (key === undefined) uses.unresolved.push({ file: source.file, at: where(node) });
        else record(bound, key);
      }
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "i18nKey" && node.initializer && ts.isStringLiteral(node.initializer)) {
        const attrs = node.parent;
        const nsAttr = attrs.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "ns");
        const ns = nsAttr?.initializer && ts.isStringLiteral(nsAttr.initializer) ? [nsAttr.initializer.text] : undefined;
        record(ns, node.initializer.text);
      }
    });
  }
  return uses;
}

/** True when `key` in `ns` is covered by a declared dynamic pattern. */
export function isDynamic(uses: KeyUses, ns: string, key: string): boolean {
  return uses.dynamic.some((d) => d.ns === ns && (d.pattern.endsWith("*") ? key.startsWith(d.pattern.slice(0, -1)) : key === d.pattern));
}
