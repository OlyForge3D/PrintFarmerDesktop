#!/usr/bin/env node
// Copilot `postToolUse` hook (.github/hooks/impeccable.json): after an agent
// edits a design-surface file, run the vendored impeccable detector on it and
// feed any findings straight back into the agent's context, so slop gets fixed
// in the same turn instead of surfacing in CI.
//
// Contract with the host: read one JSON payload on stdin
// ({ cwd, toolName, toolArgs }), optionally print { "additionalContext": ... }
// on stdout, and ALWAYS exit 0. A hook that fails or hangs must never block the
// agent's edit; CI (`scripts/design-detector.mjs`) is the enforcing layer.
//
// Opt out with `.impeccable/config.json` -> { "hook": { "enabled": false } }
// (or config.local.json for just yourself), or IMPECCABLE_HOOK_DISABLED=1.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DETECTOR_DIR,
  partitionFindings,
  formatFinding,
  runDetector,
} from './design-detector.mjs';
import { designSurfacePaths, normalizeRepoPath } from './design-surface.mjs';

const DEFAULT_LIMITS = Object.freeze({ maxFindings: 5, maxChars: 8000 });

// edit/create carry a JSON object with `path`; apply_patch carries the raw
// patch text, whose file headers name every touched path.
export function extractEditedPaths(toolName, toolArgs) {
  if (toolName === 'apply_patch') {
    const text =
      typeof toolArgs === 'string'
        ? toolArgs
        : typeof toolArgs?.input === 'string'
          ? toolArgs.input
          : typeof toolArgs?.patch === 'string'
            ? toolArgs.patch
            : '';
    const paths = [];
    for (const match of text.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))
      paths.push(match[1].trim());
    for (const match of text.matchAll(/^\*\*\* Move to: (.+)$/gm))
      paths.push(match[1].trim());
    return paths;
  }
  let args = toolArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return [];
    }
  }
  return typeof args?.path === 'string' ? [args.path] : [];
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readHookSettings(root, env = process.env) {
  const settings = { enabled: true, limits: { ...DEFAULT_LIMITS } };
  for (const file of ['config.json', 'config.local.json']) {
    const hook = readJson(join(root, '.impeccable', file))?.hook;
    if (!hook || typeof hook !== 'object') continue;
    if (typeof hook.enabled === 'boolean') settings.enabled = hook.enabled;
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = hook.limits?.[key];
      if (Number.isInteger(value) && value > 0) settings.limits[key] = value;
    }
  }
  if (
    env.IMPECCABLE_HOOK_DISABLED === '1' ||
    env.IMPECCABLE_HOOK_DISABLED === 'true'
  ) {
    settings.enabled = false;
  }
  return settings;
}

export function toRepoRelative(root, filePath, cwd = root) {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = normalizeRepoPath(relative(root, absolute));
  return rel.startsWith('../') || isAbsolute(rel) ? null : rel;
}

export function formatContext(findings, root, limits) {
  const shown = findings.slice(0, limits.maxFindings);
  const lines = [
    `impeccable design detector flagged ${findings.length} issue(s) in the file(s) you just edited.`,
    'These fail the Design detector CI check. Fix them now, or suppress deliberately with an',
    'inline `impeccable-disable` comment or .impeccable/config.json and say why in the PR:',
    ...shown.map((finding) => `- ${formatFinding(finding, root)}`),
  ];
  if (findings.length > shown.length)
    lines.push(`- ...and ${findings.length - shown.length} more`);
  let text = lines.join('\n');
  if (text.length > limits.maxChars)
    text = `${text.slice(0, limits.maxChars - 1)}…`;
  return text;
}

function findRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function handlePayload(
  payload,
  { env = process.env, detect = runDetector } = {},
) {
  const cwd =
    typeof payload?.cwd === 'string' && payload.cwd
      ? payload.cwd
      : process.cwd();
  const root = findRoot(cwd);
  if (!root || !existsSync(join(root, DETECTOR_DIR, 'detect.mjs'))) return null;

  const settings = readHookSettings(root, env);
  if (!settings.enabled) return null;

  const edited = extractEditedPaths(payload?.toolName, payload?.toolArgs)
    .map((p) => toRepoRelative(root, p, cwd))
    .filter(Boolean);
  const targets = designSurfacePaths(edited).filter((file) => {
    const full = join(root, file);
    return existsSync(full) && statSync(full).isFile();
  });
  if (targets.length === 0) return null;

  const { blocking } = partitionFindings(detect(root, targets));
  if (blocking.length === 0) return null;
  return { additionalContext: formatContext(blocking, root, settings.limits) };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const output = handlePayload(JSON.parse(await readStdin()));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    process.stderr.write(`design-detector-hook: ${error.message}\n`);
  }
  process.exitCode = 0;
}
