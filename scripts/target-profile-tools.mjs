import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const BUNDLE_ID = 'snapmaker-u1-orca-presets';
export const BUNDLE_SCHEMA_VERSION = 1;
export const UPSTREAM_REPOSITORY = 'https://github.com/Snapmaker/Orca_Presets';
export const TARGET_PRINTER = Object.freeze({
  vendor: 'Snapmaker',
  model: 'U1',
  preset: 'Snapmaker U1 (0.4 nozzle)',
  variant: '0.4',
});

export const APPROVED_UPSTREAM_PATHS = Object.freeze(
  [
    'Snapmaker/filament/fdm_filament_abs.json',
    'Snapmaker/filament/fdm_filament_asa.json',
    'Snapmaker/filament/fdm_filament_common.json',
    'Snapmaker/filament/fdm_filament_pa.json',
    'Snapmaker/filament/fdm_filament_pet.json',
    'Snapmaker/filament/fdm_filament_petg.json',
    'Snapmaker/filament/fdm_filament_pla_eco.json',
    'Snapmaker/filament/fdm_filament_pla.json',
    'Snapmaker/filament/fdm_filament_pva.json',
    'Snapmaker/filament/fdm_filament_tpu.json',
    'Snapmaker/filament/PolyLite PLA @U1 base.json',
    'Snapmaker/filament/PolyLite PLA @U1.json',
    'Snapmaker/filament/PolyTerra PLA @U1 base.json',
    'Snapmaker/filament/PolyTerra PLA @U1.json',
    'Snapmaker/filament/Snapmaker ABS @U1 base.json',
    'Snapmaker/filament/Snapmaker ABS @U1.json',
    'Snapmaker/filament/Snapmaker ABS Benchy @U1.json',
    'Snapmaker/filament/Snapmaker ASA @U1 base.json',
    'Snapmaker/filament/Snapmaker ASA @U1.json',
    'Snapmaker/filament/Snapmaker Breakaway Support @base.json',
    'Snapmaker/filament/Snapmaker Breakaway Support For PLA @U1.json',
    'Snapmaker/filament/Snapmaker PA-CF @U1 base.json',
    'Snapmaker/filament/Snapmaker PA-CF @U1.json',
    'Snapmaker/filament/Snapmaker PET @U1 base.json',
    'Snapmaker/filament/Snapmaker PET @U1.json',
    'Snapmaker/filament/Snapmaker PETG @U1 base.json',
    'Snapmaker/filament/Snapmaker PETG @U1.json',
    'Snapmaker/filament/Snapmaker PETG-CF @U1 base.json',
    'Snapmaker/filament/Snapmaker PETG-CF @U1.json',
    'Snapmaker/filament/Snapmaker PLA @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA @U1.json',
    'Snapmaker/filament/Snapmaker PLA Basic @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA Basic @U1.json',
    'Snapmaker/filament/Snapmaker PLA Eco @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA Eco @U1.json',
    'Snapmaker/filament/Snapmaker PLA Matte @U1.json',
    'Snapmaker/filament/Snapmaker PLA Metal @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA Metal @U1.json',
    'Snapmaker/filament/Snapmaker PLA Silk @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA Silk @U1.json',
    'Snapmaker/filament/Snapmaker PLA SnapSpeed @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA SnapSpeed @U1.json',
    'Snapmaker/filament/Snapmaker PLA-CF @U1 base.json',
    'Snapmaker/filament/Snapmaker PLA-CF @U1.json',
    'Snapmaker/filament/Snapmaker PVA @J1 base.json',
    'Snapmaker/filament/Snapmaker PVA @J1.json',
    'Snapmaker/filament/Snapmaker PVA @U1 base.json',
    'Snapmaker/filament/Snapmaker PVA @U1.json',
    'Snapmaker/filament/Snapmaker TPE @U1.json',
    'Snapmaker/filament/Snapmaker TPU @U1 base.json',
    'Snapmaker/filament/Snapmaker TPU @U1.json',
    'Snapmaker/filament/Snapmaker TPU 95A @U1 base.json',
    'Snapmaker/filament/Snapmaker TPU 95A @U1.json',
    'Snapmaker/filament/Snapmaker TPU High-Flow @U1.json',
    'Snapmaker/machine/fdm_klipper.json',
    'Snapmaker/machine/fdm_toolchanger.json',
    'Snapmaker/machine/fdm_U1.json',
    'Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/machine/Snapmaker U1.json',
    'Snapmaker/process/0.08 Extra Fine @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.08 High Quality @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.12 Fine @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.12 High Quality @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.16 High Quality @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.16 Optimal @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Bambu Support W @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Quality @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Standard @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Strength @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Support @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.20 Support W @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.24 Draft @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.25 Benchy @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/0.28 Extra Draft @Snapmaker U1 (0.4 nozzle).json',
    'Snapmaker/process/fdm_process_U1_0.08.json',
    'Snapmaker/process/fdm_process_U1_0.12.json',
    'Snapmaker/process/fdm_process_U1_0.16.json',
    'Snapmaker/process/fdm_process_U1_0.20.json',
    'Snapmaker/process/fdm_process_U1_0.24.json',
    'Snapmaker/process/fdm_process_U1_0.28.json',
    'Snapmaker/process/fdm_process_U1_common.json',
    'Snapmaker/process/fdm_process_U1.json',
  ].sort(),
);

const PROFILE_TYPES = new Set([
  'filament',
  'machine',
  'machine_model',
  'process',
]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOP_LEVEL_LICENSE_PATTERN =
  /^(copying|license|licence|notice)(\.[a-z0-9]+)?$/i;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

export function assertExactCommitRef(ref) {
  if (!COMMIT_PATTERN.test(ref)) {
    throw new Error(
      `--ref must be an exact lowercase 40-character Git commit, received ${JSON.stringify(ref)}`,
    );
  }
  return ref;
}

export function assertRetrievalDate(retrievedAt) {
  if (!DATE_PATTERN.test(retrievedAt)) {
    throw new Error(
      `--retrieved-at must use YYYY-MM-DD, received ${JSON.stringify(retrievedAt)}`,
    );
  }
  const parsed = new Date(`${retrievedAt}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== retrievedAt
  ) {
    throw new Error(
      `--retrieved-at is not a valid calendar date: ${retrievedAt}`,
    );
  }
  return retrievedAt;
}

export function assertSafeRelativePath(value, label = 'path') {
  const relativePath = requireString(value, label);
  if (
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new Error(
      `${label} is not a safe normalized relative path: ${value}`,
    );
  }
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    ) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(
      `${label} is not a safe normalized relative path: ${value}`,
    );
  }
  return relativePath;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inferPresetType(sourcePath) {
  const segments = sourcePath.split('/');
  if (segments.includes('filament')) {
    return 'filament';
  }
  if (segments.includes('process')) {
    return 'process';
  }
  return undefined;
}

export function parsePreset(bytes, sourcePath) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${sourcePath} is not valid UTF-8`, { cause: error });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourcePath} is not valid JSON`, { cause: error });
  }
  if (!isRecord(value)) {
    throw new Error(`${sourcePath} must contain a JSON object`);
  }
  const inferredType = inferPresetType(sourcePath);
  const type =
    value.type === undefined
      ? requireString(inferredType, `${sourcePath}.type`)
      : requireString(value.type, `${sourcePath}.type`);
  const name = requireString(value.name, `${sourcePath}.name`);
  if (!PROFILE_TYPES.has(type)) {
    throw new Error(`${sourcePath} has unsupported preset type ${type}`);
  }
  if (
    value.inherits !== undefined &&
    (typeof value.inherits !== 'string' || value.inherits.length === 0)
  ) {
    throw new Error(`${sourcePath}.inherits must be a non-empty string`);
  }
  if (
    value.compatible_printers !== undefined &&
    (!Array.isArray(value.compatible_printers) ||
      value.compatible_printers.some((item) => typeof item !== 'string'))
  ) {
    throw new Error(`${sourcePath}.compatible_printers must be a string array`);
  }
  return { value, type, name };
}

function isTargetCompatible(preset, target) {
  return (
    (preset.type === 'process' || preset.type === 'filament') &&
    Array.isArray(preset.value.compatible_printers) &&
    preset.value.compatible_printers.includes(target.preset)
  );
}

export function validatePresetClosure(entries, target = TARGET_PRINTER) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('preset closure must contain at least one file');
  }
  const names = new Map();
  for (const entry of entries) {
    assertSafeRelativePath(entry.upstreamPath, 'upstream preset path');
    if (names.has(entry.preset.name)) {
      throw new Error(`duplicate preset name in closure: ${entry.preset.name}`);
    }
    names.set(entry.preset.name, entry);
  }

  const machineModels = entries.filter(
    (entry) =>
      entry.preset.type === 'machine_model' &&
      entry.preset.name === `${target.vendor} ${target.model}`,
  );
  if (machineModels.length !== 1) {
    throw new Error(
      `closure must contain exactly one ${target.vendor} ${target.model} machine model`,
    );
  }

  const machines = entries.filter(
    (entry) =>
      entry.preset.type === 'machine' &&
      entry.preset.name === target.preset &&
      entry.preset.value.printer_model === `${target.vendor} ${target.model}` &&
      entry.preset.value.printer_variant === target.variant,
  );
  if (machines.length !== 1) {
    throw new Error(
      `closure must contain exactly one ${target.preset} machine preset with the expected identity`,
    );
  }

  const compatibleProfiles = entries.filter((entry) =>
    isTargetCompatible(entry.preset, target),
  );
  if (!compatibleProfiles.some((entry) => entry.preset.type === 'process')) {
    throw new Error(
      `closure has no process preset compatible with ${target.preset}`,
    );
  }
  if (!compatibleProfiles.some((entry) => entry.preset.type === 'filament')) {
    throw new Error(
      `closure has no filament preset compatible with ${target.preset}`,
    );
  }

  const roots = [...machineModels, ...machines, ...compatibleProfiles];
  const reachable = new Set();
  const visit = (entry) => {
    if (reachable.has(entry.upstreamPath)) {
      return;
    }
    reachable.add(entry.upstreamPath);
    const inherits = entry.preset.value.inherits;
    if (inherits === undefined) {
      return;
    }
    const parent = names.get(inherits);
    if (!parent) {
      throw new Error(
        `${entry.upstreamPath} inherits missing preset ${JSON.stringify(inherits)}`,
      );
    }
    visit(parent);
  };
  roots.forEach(visit);

  const extras = entries
    .filter((entry) => !reachable.has(entry.upstreamPath))
    .map((entry) => entry.upstreamPath)
    .sort();
  if (extras.length > 0) {
    throw new Error(
      `closure contains unreviewed or unreachable extras: ${extras.join(', ')}`,
    );
  }
  return roots.map((entry) => entry.upstreamPath).sort();
}

function encodeUpstreamPath(upstreamPath) {
  return upstreamPath.split('/').map(encodeURIComponent).join('/');
}

async function fetchChecked(fetchImpl, url, label, init) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(
      `${label} request failed with HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

async function validateUpstreamCommit(fetchImpl, ref) {
  const apiBase = 'https://api.github.com/repos/Snapmaker/Orca_Presets';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PrintFarmerDesktop-preset-updater',
  };
  const commitResponse = await fetchChecked(
    fetchImpl,
    `${apiBase}/commits/${ref}`,
    'commit metadata',
    { headers },
  );
  const commit = await commitResponse.json();
  if (!isRecord(commit) || commit.sha !== ref) {
    throw new Error(
      `GitHub did not resolve ${ref} to the requested exact commit`,
    );
  }

  const rootResponse = await fetchChecked(
    fetchImpl,
    `${apiBase}/contents?ref=${ref}`,
    'repository root metadata',
    { headers },
  );
  const root = await rootResponse.json();
  if (!Array.isArray(root)) {
    throw new Error('repository root metadata must be an array');
  }
  const rootNames = root.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`repository root entry ${index} must be an object`);
    }
    return requireString(entry.name, `repository root entry ${index}.name`);
  });
  if (!rootNames.includes('Snapmaker.json')) {
    throw new Error('upstream Snapmaker.json index is missing');
  }
  const license = rootNames.find((name) =>
    TOP_LEVEL_LICENSE_PATTERN.test(name),
  );
  if (license) {
    throw new Error(
      `upstream top-level notice ${license} requires explicit provenance review before updating`,
    );
  }
}

export async function downloadApprovedSnapshot({
  ref,
  retrievedAt,
  approvedPaths = APPROVED_UPSTREAM_PATHS,
  fetchImpl = fetch,
  target = TARGET_PRINTER,
}) {
  assertExactCommitRef(ref);
  assertRetrievalDate(retrievedAt);
  const normalizedPaths = approvedPaths.map((approvedPath) =>
    assertSafeRelativePath(approvedPath, 'approved upstream path'),
  );
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error('approved upstream path list contains duplicates');
  }
  const sortedPaths = [...normalizedPaths].sort();
  if (normalizedPaths.some((item, index) => item !== sortedPaths[index])) {
    throw new Error('approved upstream paths must be sorted');
  }

  await validateUpstreamCommit(fetchImpl, ref);
  const entries = await Promise.all(
    normalizedPaths.map(async (upstreamPath) => {
      const url = `https://raw.githubusercontent.com/Snapmaker/Orca_Presets/${ref}/${encodeUpstreamPath(upstreamPath)}`;
      const response = await fetchChecked(fetchImpl, url, upstreamPath, {
        redirect: 'error',
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        upstreamPath,
        bytes,
        preset: parsePreset(bytes, upstreamPath),
      };
    }),
  );
  const roots = validatePresetClosure(entries, target);
  return { entries, roots };
}

export function createManifest({ ref, retrievedAt, entries, roots }) {
  assertExactCommitRef(ref);
  assertRetrievalDate(retrievedAt);
  const selectedPaths = entries.map((entry) => entry.upstreamPath).sort();
  const rootSet = new Set(roots);
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    bundleId: BUNDLE_ID,
    targetPrinter: { ...TARGET_PRINTER },
    upstream: {
      repository: UPSTREAM_REPOSITORY,
      commit: ref,
      retrievedAt,
      sourceIndex: 'Snapmaker.json',
    },
    selectedPaths,
    roots: roots.map((root) => `profiles/${root}`).sort(),
    files: entries
      .map((entry) => ({
        path: `profiles/${entry.upstreamPath}`,
        upstreamPath: entry.upstreamPath,
        sha256: sha256(entry.bytes),
        role: rootSet.has(entry.upstreamPath) ? 'root' : 'dependency',
        type: entry.preset.type,
        name: entry.preset.name,
      }))
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    provenance: {
      authorization:
        'Bundled under explicit product-owner authorization to use official Snapmaker/Orca_Presets data.',
      licenseNotice:
        'The pinned upstream commit has no top-level license or notice file. This bundle records provenance and does not assert or invent upstream license terms.',
      transformation:
        'None. Every file under profiles/ is byte-for-byte identical to the selected upstream path at the pinned commit; this manifest is generated locally.',
      assetNotice:
        'Upstream U1 JSON names decorative bed model/texture assets that are not present in Snapmaker/Orca_Presets at the pinned commit; no substitute assets are bundled.',
    },
    updatePolicy: {
      exactCommitRequired: true,
      runtimeNetworkFetch: false,
      reviewedAllowlistRequired: true,
    },
  };
}

export function validateManifest(value) {
  if (!isRecord(value)) {
    throw new Error('manifest must contain a JSON object');
  }
  if (value.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `manifest.schemaVersion must equal ${BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (value.bundleId !== BUNDLE_ID) {
    throw new Error(`manifest.bundleId must equal ${BUNDLE_ID}`);
  }
  if (!isRecord(value.targetPrinter)) {
    throw new Error('manifest.targetPrinter must be an object');
  }
  for (const [key, expected] of Object.entries(TARGET_PRINTER)) {
    if (value.targetPrinter[key] !== expected) {
      throw new Error(`manifest.targetPrinter.${key} must equal ${expected}`);
    }
  }
  if (!isRecord(value.upstream)) {
    throw new Error('manifest.upstream must be an object');
  }
  if (value.upstream.repository !== UPSTREAM_REPOSITORY) {
    throw new Error(
      `manifest.upstream.repository must equal ${UPSTREAM_REPOSITORY}`,
    );
  }
  assertExactCommitRef(value.upstream.commit);
  assertRetrievalDate(value.upstream.retrievedAt);
  if (value.upstream.sourceIndex !== 'Snapmaker.json') {
    throw new Error('manifest.upstream.sourceIndex must equal Snapmaker.json');
  }

  const selectedPaths = requireStringArray(
    value.selectedPaths,
    'manifest.selectedPaths',
  ).map((item) => assertSafeRelativePath(item, 'manifest selected path'));
  const roots = requireStringArray(value.roots, 'manifest.roots').map((item) =>
    assertSafeRelativePath(item, 'manifest root path'),
  );
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('manifest.files must be a non-empty array');
  }
  const files = value.files.map((file, index) => {
    if (!isRecord(file)) {
      throw new Error(`manifest.files[${index}] must be an object`);
    }
    const filePath = assertSafeRelativePath(
      file.path,
      `manifest.files[${index}].path`,
    );
    const upstreamPath = assertSafeRelativePath(
      file.upstreamPath,
      `manifest.files[${index}].upstreamPath`,
    );
    if (filePath !== `profiles/${upstreamPath}`) {
      throw new Error(
        `manifest.files[${index}].path must preserve its upstream path under profiles/`,
      );
    }
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error(
        `manifest.files[${index}].sha256 must be a lowercase SHA-256`,
      );
    }
    if (file.role !== 'root' && file.role !== 'dependency') {
      throw new Error(`manifest.files[${index}].role is invalid`);
    }
    if (!PROFILE_TYPES.has(file.type)) {
      throw new Error(`manifest.files[${index}].type is invalid`);
    }
    requireString(file.name, `manifest.files[${index}].name`);
    return file;
  });
  const filePaths = files.map((file) => file.path);
  const upstreamPaths = files.map((file) => file.upstreamPath);
  for (const [label, list] of [
    ['manifest file paths', filePaths],
    ['manifest upstream paths', upstreamPaths],
    ['manifest selected paths', selectedPaths],
    ['manifest root paths', roots],
  ]) {
    if (new Set(list).size !== list.length) {
      throw new Error(`${label} contain duplicates`);
    }
    const sorted = [...list].sort();
    if (list.some((item, index) => item !== sorted[index])) {
      throw new Error(`${label} must be sorted`);
    }
  }
  if (
    selectedPaths.length !== upstreamPaths.length ||
    selectedPaths.some((item, index) => item !== upstreamPaths[index])
  ) {
    throw new Error('manifest.selectedPaths must exactly match manifest.files');
  }
  const filePathSet = new Set(filePaths);
  if (roots.some((root) => !filePathSet.has(root))) {
    throw new Error('manifest.roots must reference manifest files');
  }
  const rootSet = new Set(roots);
  if (files.some((file) => (file.role === 'root') !== rootSet.has(file.path))) {
    throw new Error('manifest file roles must exactly match manifest.roots');
  }
  if (!isRecord(value.provenance)) {
    throw new Error('manifest.provenance must be an object');
  }
  for (const key of [
    'authorization',
    'licenseNotice',
    'transformation',
    'assetNotice',
  ]) {
    requireString(value.provenance[key], `manifest.provenance.${key}`);
  }
  if (
    !isRecord(value.updatePolicy) ||
    value.updatePolicy.exactCommitRequired !== true ||
    value.updatePolicy.runtimeNetworkFetch !== false ||
    value.updatePolicy.reviewedAllowlistRequired !== true
  ) {
    throw new Error('manifest.updatePolicy does not match the pinned policy');
  }
  return value;
}

async function listFiles(rootDirectory, relativeDirectory = '') {
  const directory = path.join(
    rootDirectory,
    ...relativeDirectory.split('/').filter(Boolean),
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDirectory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `bundle contains unsupported filesystem entry ${relativePath}`,
      );
    }
  }
  return files.sort();
}

export async function verifyBundleDirectory(
  bundleDirectory,
  approvedPaths = APPROVED_UPSTREAM_PATHS,
) {
  const manifestPath = path.join(bundleDirectory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  let manifestValue;
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON`, { cause: error });
  }
  const manifest = validateManifest(manifestValue);
  const normalizedApprovedPaths = approvedPaths
    .map((item) => assertSafeRelativePath(item, 'approved upstream path'))
    .sort();
  if (
    normalizedApprovedPaths.length !== manifest.selectedPaths.length ||
    normalizedApprovedPaths.some(
      (item, index) => item !== manifest.selectedPaths[index],
    )
  ) {
    throw new Error(
      'manifest.selectedPaths does not match the reviewed path allowlist',
    );
  }
  const actualFiles = (await listFiles(bundleDirectory)).filter(
    (item) => item !== 'manifest.json',
  );
  const expectedFiles = manifest.files.map((file) => file.path);
  const missing = expectedFiles.filter((item) => !actualFiles.includes(item));
  const extras = actualFiles.filter((item) => !expectedFiles.includes(item));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `bundle file set mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extras.join(', ') || 'none'}`,
    );
  }

  const parsedEntries = [];
  for (const file of manifest.files) {
    const absolutePath = path.join(bundleDirectory, ...file.path.split('/'));
    const bytes = await readFile(absolutePath);
    const actualHash = sha256(bytes);
    if (actualHash !== file.sha256) {
      throw new Error(
        `${file.path} SHA-256 mismatch: expected ${file.sha256}, received ${actualHash}`,
      );
    }
    const preset = parsePreset(bytes, file.path);
    if (preset.name !== file.name || preset.type !== file.type) {
      throw new Error(
        `${file.path} identity does not match its manifest entry`,
      );
    }
    parsedEntries.push({
      upstreamPath: file.upstreamPath,
      bytes,
      preset,
    });
  }
  const roots = validatePresetClosure(parsedEntries);
  const expectedRoots = roots.map((root) => `profiles/${root}`).sort();
  if (
    expectedRoots.length !== manifest.roots.length ||
    expectedRoots.some((item, index) => item !== manifest.roots[index])
  ) {
    throw new Error('manifest.roots does not match the validated U1 closure');
  }
  return manifest;
}

export async function writeSnapshotBundle(bundleDirectory, snapshot) {
  const profilesDirectory = path.join(bundleDirectory, 'profiles');
  await rm(profilesDirectory, { recursive: true, force: true });
  await mkdir(profilesDirectory, { recursive: true });
  for (const entry of snapshot.entries) {
    assertSafeRelativePath(entry.upstreamPath, 'snapshot upstream path');
    const outputPath = path.join(
      profilesDirectory,
      ...entry.upstreamPath.split('/'),
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, entry.bytes);
  }
  const manifest = createManifest(snapshot);
  await writeFile(
    path.join(bundleDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}
