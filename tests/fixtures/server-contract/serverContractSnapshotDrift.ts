/**
 * Drift check that keeps the snapshots in this directory honest.
 *
 * When the sibling PrintFarmer server checkout is on disk, we open the same
 * C# files the snapshots were copied from, extract the DTO property names via
 * a small regex, and compare against the exported snapshot list. Any drift is
 * a failure — the snapshot is stale and every test that assumes it is a valid
 * proxy for the server contract has silently been asserting against a
 * fossilised copy of yesterday's server.
 *
 * The check is skipped in CI (where the sibling checkout is not present) and
 * emits a plain warning to stderr so nobody can pretend the snapshot has been
 * verified when it has not.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_SERVER_REPO = 'D:\\s\\pfarm1';

export function resolveServerRepo(): string | null {
  const configured =
    process.env.PRINTFARMER_SERVER_REPO?.trim() || DEFAULT_SERVER_REPO;
  if (configured && existsSync(path.join(configured, '.git'))) {
    return configured;
  }
  return null;
}

export interface DtoDriftReport {
  file: string;
  onDiskFields: string[];
  snapshotFields: readonly string[];
  missingFromSnapshot: string[];
  extraInSnapshot: string[];
}

/**
 * Extract camelCase C# property names for a single class or record type.
 *
 * The regex targets `public [modifier?] <type> Name { get; [init/set]; }` or
 * `public [modifier?] <type> Name { get; set; } = ...;` and yields `name`
 * (first character lowercased) to match the server's camelCase JSON policy.
 */
export function extractCSharpDtoFields(
  csharpSource: string,
  typeName: string,
): string[] {
  const typePattern = new RegExp(
    `(?:class|record|struct)\\s+${typeName}\\b`,
    'm',
  );
  const typeStart = csharpSource.match(typePattern);
  if (!typeStart || typeStart.index === undefined) {
    throw new Error(
      `extractCSharpDtoFields: could not find type "${typeName}" in source`,
    );
  }
  const startOffset = typeStart.index + typeStart[0].length;
  const openBrace = csharpSource.indexOf('{', startOffset);
  if (openBrace === -1) {
    throw new Error(
      `extractCSharpDtoFields: could not find opening brace for "${typeName}"`,
    );
  }
  let depth = 1;
  let cursor = openBrace + 1;
  while (cursor < csharpSource.length && depth > 0) {
    const c = csharpSource[cursor];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    cursor += 1;
  }
  if (depth !== 0) {
    throw new Error(
      `extractCSharpDtoFields: unbalanced braces for "${typeName}"`,
    );
  }
  const body = csharpSource.slice(openBrace + 1, cursor - 1);

  const propertyRegex =
    /public\s+(?:sealed\s+)?(?:override\s+)?(?:virtual\s+)?[A-Za-z_][\w<>?[\],\s.]*?\s+([A-Z][A-Za-z0-9]*)\s*\{\s*get;/g;

  const result: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = propertyRegex.exec(body)) !== null) {
    const pascal = match[1];
    if (pascal === undefined || pascal.length === 0) continue;
    const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
    if (!seen.has(camel)) {
      seen.add(camel);
      result.push(camel);
    }
  }
  return result;
}

export function compareDto(args: {
  repoRoot: string;
  relPath: string;
  typeName: string;
  snapshotFields: readonly string[];
}): DtoDriftReport {
  const absolute = path.join(args.repoRoot, args.relPath);
  const csharpSource = readFileSync(absolute, 'utf8');
  const onDiskFields = extractCSharpDtoFields(csharpSource, args.typeName);

  const snapshotSet = new Set(args.snapshotFields);
  const onDiskSet = new Set(onDiskFields);

  const missingFromSnapshot = onDiskFields.filter((f) => !snapshotSet.has(f));
  const extraInSnapshot = args.snapshotFields.filter((f) => !onDiskSet.has(f));

  return {
    file: args.relPath,
    onDiskFields,
    snapshotFields: args.snapshotFields,
    missingFromSnapshot,
    extraInSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Enum + switch extractors — used by the JobBlockedReasonCode drift check.
// ---------------------------------------------------------------------------

/**
 * Extract C# enum member names for a specific enum type. Members are returned
 * in declaration order and with their PascalCase spelling (System.Text.Json's
 * default `JsonStringEnumConverter` uses the C# spelling verbatim, so no
 * lowercase transform).
 */
export function extractCSharpEnumMembers(
  csharpSource: string,
  typeName: string,
): string[] {
  const typePattern = new RegExp(`enum\\s+${typeName}\\b`, 'm');
  const typeStart = csharpSource.match(typePattern);
  if (!typeStart || typeStart.index === undefined) {
    throw new Error(
      `extractCSharpEnumMembers: could not find enum "${typeName}"`,
    );
  }
  const openBrace = csharpSource.indexOf('{', typeStart.index);
  if (openBrace === -1) {
    throw new Error(
      `extractCSharpEnumMembers: no opening brace for enum "${typeName}"`,
    );
  }
  let depth = 1;
  let cursor = openBrace + 1;
  while (cursor < csharpSource.length && depth > 0) {
    const c = csharpSource[cursor];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    cursor += 1;
  }
  const body = csharpSource.slice(openBrace + 1, cursor - 1);

  // Strip block comments and line comments so pattern matching doesn't
  // gobble commented-out members.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const memberRe = /(?:^|,)\s*([A-Z][A-Za-z0-9_]*)\s*(?:=\s*-?\d+)?/g;
  const result: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = memberRe.exec(stripped)) !== null) {
    const name = match[1];
    if (name === undefined) continue;
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/**
 * Extract the string-literal case labels that appear in a specific static
 * method's switch expression body. Used for
 * `DispatchSafetyGates.MapBlockedReason` — every wire token that maps to a
 * durable `JobBlockedReasonCode`.
 */
export function extractCSharpSwitchStringCases(
  csharpSource: string,
  methodName: string,
): string[] {
  const methodRe = new RegExp(
    `${methodName}\\s*\\([^)]*\\)\\s*=>[\\s\\S]*?errorCode\\s+switch\\s*{([\\s\\S]*?)}\\s*;`,
    'm',
  );
  const match = csharpSource.match(methodRe);
  if (!match || match[1] === undefined) {
    throw new Error(
      `extractCSharpSwitchStringCases: could not find switch body for "${methodName}"`,
    );
  }
  const body = match[1];
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const cases: string[] = [];
  const seen = new Set<string>();
  const caseRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(stripped)) !== null) {
    const token = m[1];
    if (token === undefined) continue;
    if (!seen.has(token)) {
      seen.add(token);
      cases.push(token);
    }
  }
  return cases;
}

export interface EnumDriftReport {
  file: string;
  onDiskMembers: string[];
  snapshotMembers: readonly string[];
  missingFromSnapshot: string[];
  extraInSnapshot: string[];
}

export function compareEnum(args: {
  repoRoot: string;
  relPath: string;
  typeName: string;
  snapshotMembers: readonly string[];
}): EnumDriftReport {
  const abs = path.join(args.repoRoot, args.relPath);
  const source = readFileSync(abs, 'utf8');
  const onDisk = extractCSharpEnumMembers(source, args.typeName);

  const snapshotSet = new Set(args.snapshotMembers);
  const onDiskSet = new Set(onDisk);

  return {
    file: args.relPath,
    onDiskMembers: onDisk,
    snapshotMembers: args.snapshotMembers,
    missingFromSnapshot: onDisk.filter((m) => !snapshotSet.has(m)),
    extraInSnapshot: args.snapshotMembers.filter((m) => !onDiskSet.has(m)),
  };
}

export interface SwitchDriftReport {
  file: string;
  onDiskCases: string[];
  snapshotCases: readonly string[];
  missingFromSnapshot: string[];
  extraInSnapshot: string[];
}

export function compareSwitchCases(args: {
  repoRoot: string;
  relPath: string;
  methodName: string;
  snapshotCases: readonly string[];
}): SwitchDriftReport {
  const abs = path.join(args.repoRoot, args.relPath);
  const source = readFileSync(abs, 'utf8');
  const onDisk = extractCSharpSwitchStringCases(source, args.methodName);

  const snapshotSet = new Set(args.snapshotCases);
  const onDiskSet = new Set(onDisk);

  return {
    file: args.relPath,
    onDiskCases: onDisk,
    snapshotCases: args.snapshotCases,
    missingFromSnapshot: onDisk.filter((c) => !snapshotSet.has(c)),
    extraInSnapshot: args.snapshotCases.filter((c) => !onDiskSet.has(c)),
  };
}
