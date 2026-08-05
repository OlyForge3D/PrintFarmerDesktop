import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const now = '2026-08-04T00:00:00.000Z';

function project(overrides = {}) {
  return {
    id: 'project-1',
    name: 'Synthetic calibration',
    mode: 'flowRate',
    status: 'inProgress',
    printerId: null,
    printer: null,
    filamentId: null,
    filamentName: null,
    skuId: null,
    spoolId: null,
    steps: [],
    currentStepId: null,
    photos: [],
    generatedProfile: null,
    notes: null,
    confidence: null,
    retestRequested: false,
    legacyId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function backup(projectOverrides) {
  return JSON.stringify({
    schemaVersion: 4,
    exportedAt: now,
    projects: projectOverrides === undefined ? [] : [project(projectOverrides)],
  });
}

function nestedProfile(depth) {
  const value = nestedValue(depth);
  return JSON.stringify({
    name: 'Synthetic PLA @0.4 nozzle',
    type: 'filament',
    value,
  });
}

function nestedValue(depth) {
  let value = 'leaf';
  for (let index = 0; index < depth; index++) value = { child: value };
  return value;
}

function binaryStl(triangleCount) {
  const bytes = Buffer.alloc(84 + triangleCount * 50);
  bytes.writeUInt32LE(triangleCount, 80);
  return bytes;
}

const fixtures = new Map([
  ['legacy/valid.json', backup()],
  ['legacy/wrong-magic.json', 'G28\nG1 Z10\n'],
  [
    'legacy/duplicate-keys.json',
    `{"schemaVersion":4,"exportedAt":"${now}","projects":[],"schemaVersion":4}`,
  ],
  ['legacy/deeply-nested.json', backup({ hostileNesting: nestedValue(24) })],
  [
    'legacy/unsafe-number.json',
    backup({ printer: { name: 'Synthetic', nozzleDiameterMm: 0 } }).replace(
      '"nozzleDiameterMm":0',
      '"nozzleDiameterMm":1e999',
    ),
  ],
  [
    'legacy/unsafe-integer.json',
    backup({ payload_count: 0 }).replace(
      '"payload_count":0',
      '"payload_count":9007199254740993',
    ),
  ],
  ['legacy/negative-size.json', backup({ payload_size: -1 })],
  [
    'legacy/malformed-base64.json',
    backup({
      photos: [
        {
          id: 'photo-1',
          caption: 'synthetic',
          order: 0,
          dataUrl: 'data:image/png;base64,%%%not-base64%%%',
        },
      ],
    }),
  ],
  [
    'legacy/mime-mismatch.json',
    backup({
      photos: [
        {
          id: 'photo-1',
          caption: 'synthetic',
          order: 0,
          dataUrl: `data:image/jpeg;base64,${Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]).toString('base64')}`,
        },
      ],
    }),
  ],
  [
    'legacy/cyclic-inheritance.json',
    backup({
      generatedProfile: {
        exactJson: '{"name":"Self","type":"filament","inherits":"Self"}',
        hash: null,
      },
    }),
  ],
  [
    'legacy/path-traversal.json',
    backup({
      generatedProfile: {
        exactJson:
          '{"name":"Traversal","type":"filament","inherits":"..\\\\outside"}',
        hash: null,
      },
    }),
  ],
  [
    'legacy/gcode-shaped.json',
    backup({ generatedProfile: { exactJson: 'G28\nG1 Z10\n', hash: null } }),
  ],
  [
    'legacy/script-shaped.json',
    backup({
      generatedProfile: {
        exactJson: '#!/bin/sh\nprintf synthetic\n',
        hash: null,
      },
    }),
  ],
  [
    'orca/valid.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","filament_type":"PLA"}',
  ],
  ['orca/deeply-nested.json', nestedProfile(40)],
  [
    'orca/duplicate-keys.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","type":"filament"}',
  ],
  [
    'orca/cycle-a.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","inherits":"__proto__"}',
  ],
  [
    'orca/cycle-b.json',
    '{"name":"__proto__","type":"filament","inherits":"constructor"}',
  ],
  [
    'orca/cycle-c.json',
    '{"name":"constructor","type":"filament","inherits":"Synthetic PLA @0.4 nozzle"}',
  ],
  [
    'orca/path-traversal.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","inherits":"../outside"}',
  ],
  [
    'orca/unsafe-number.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","filament_max_volumetric_speed":[1e999]}',
  ],
  [
    'orca/unsafe-integer.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","serial":9007199254740993}',
  ],
  [
    'orca/negative-size.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","payload_size":-1}',
  ],
  [
    'orca/dangling-inheritance.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","inherits":"Missing parent"}',
  ],
  [
    'orca/empty-inheritance.json',
    '{"name":"Synthetic PLA @0.4 nozzle","type":"filament","inherits":""}',
  ],
  ['orca/wrong-magic.json', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])],
  ['orca/gcode-shaped.json', 'G28\nM104 S300\n'],
  ['orca/script-shaped.json', '#!/bin/sh\nprintf synthetic\n'],
  ['asset/valid.stl', binaryStl(1)],
  ['asset/wrong-magic.stl', Buffer.alloc(100, 0xab)],
  ['asset/gcode-shaped.stl', 'G28\nM104 S300\n'],
  ['asset/script-shaped.stl', '#!/bin/sh\nprintf synthetic\n'],
  [
    'asset/mime-mismatch.3mf',
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]),
  ],
]);

const expected = {
  'legacy/wrong-magic.json': 'LEGACY_BACKUP_INVALID_MARKER',
  'legacy/duplicate-keys.json': 'LEGACY_BACKUP_INVALID_JSON',
  'legacy/deeply-nested.json': 'LEGACY_BACKUP_TOO_DEEP',
  'legacy/unsafe-number.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/unsafe-integer.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/negative-size.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/malformed-base64.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/mime-mismatch.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/cyclic-inheritance.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/path-traversal.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/gcode-shaped.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'legacy/script-shaped.json': 'LEGACY_BACKUP_INVALID_SCHEMA',
  'orca/deeply-nested.json': 'tooDeep',
  'orca/duplicate-keys.json': 'duplicateKey',
  'orca/cycle-a.json': 'cycle',
  'orca/cycle-b.json': 'cycle',
  'orca/cycle-c.json': 'cycle',
  'orca/path-traversal.json': 'unsafeInheritance',
  'orca/unsafe-number.json': 'unsafeNumber',
  'orca/unsafe-integer.json': 'unsafeNumber',
  'orca/negative-size.json': 'unsafeNumber',
  'orca/dangling-inheritance.json': 'missingParent',
  'orca/wrong-magic.json': 'invalidJson',
  'orca/gcode-shaped.json': 'invalidJson',
  'orca/script-shaped.json': 'invalidJson',
  'asset/wrong-magic.stl': 'badMagicBytes',
  'asset/gcode-shaped.stl': 'badMagicBytes',
  'asset/script-shaped.stl': 'badMagicBytes',
  'asset/mime-mismatch.3mf': 'contentTypeMismatch',
};

for (let index = 0; index <= 10; index++) {
  const name =
    index === 0 ? 'Synthetic PLA @0.4 nozzle' : `Inheritance ${index}`;
  const parent = `Inheritance ${index + 1}`;
  fixtures.set(
    `orca/inheritance-depth-${index}.json`,
    JSON.stringify({ name, type: 'filament', inherits: parent }),
  );
}
fixtures.set(
  'orca/inheritance-depth-11.json',
  JSON.stringify({ name: 'Inheritance 11', type: 'filament' }),
);
fixtures.set(
  'orca/wide-profile.json',
  JSON.stringify({
    name: 'Synthetic PLA @0.4 nozzle',
    type: 'filament',
    wide: Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`field_${index}`, index]),
    ),
  }),
);
expected['orca/inheritance-depth-0.json'] = 'inheritanceTooDeep';

for (const [relativePath, contents] of fixtures) {
  const bytes = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents, 'utf8');
  const destination = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

const vectors = [
  'oversized',
  'deeplyNestedJson',
  'cyclicInheritance',
  'duplicateKeys',
  'pathTraversal',
  'symlinkOrJunctionEscape',
  'wrongMagicBytes',
  'mimeExtensionMismatch',
  'unsafeNumericValues',
  'malformedBase64DataUrl',
  'executableShapedContent',
];
const entryPoints = ['legacy', 'orca', 'asset'];
const inapplicable = {
  'orca:mimeExtensionMismatch':
    'Orca discovery receives a .json path and bytes; no MIME value enters the API.',
  'orca:malformedBase64DataUrl':
    'Orca profiles are never base64- or data-URL-decoded.',
  'asset:deeplyNestedJson':
    'Selected assets are opaque model bytes; asset content is never JSON-parsed.',
  'asset:cyclicInheritance':
    'Selected assets have no profile inheritance resolver.',
  'asset:duplicateKeys':
    'Selected assets are opaque model bytes; no object keys are parsed.',
  'asset:pathTraversal':
    'Selected asset containers are never expanded and embedded paths are never read.',
  'asset:unsafeNumericValues':
    'The only asset numeric field is an unsigned 32-bit STL triangle count.',
  'asset:malformedBase64DataUrl':
    'Selected assets are raw bytes and are never base64- or data-URL-decoded.',
};
const matrix = vectors.flatMap((vector) =>
  entryPoints.map((entryPoint) => {
    const reason = inapplicable[`${entryPoint}:${vector}`];
    return reason === undefined
      ? { vector, entryPoint, applicable: true }
      : { vector, entryPoint, applicable: false, reason };
  }),
);

const materialized = [
  {
    id: 'legacy-at-limit',
    entryPoint: 'legacy',
    recipe: 'legacy/valid.json followed by ASCII spaces',
    byteLen: 50 * 1024 * 1024,
    expectedOutcome: 'ok',
  },
  {
    id: 'legacy-over-limit',
    entryPoint: 'legacy',
    recipe: 'legacy/valid.json followed by ASCII spaces',
    byteLen: 50 * 1024 * 1024 + 1,
    expectedOutcome: 'LEGACY_BACKUP_TOO_LARGE',
  },
  {
    id: 'orca-at-limit',
    entryPoint: 'orca',
    recipe: 'orca/valid.json followed by ASCII spaces',
    byteLen: 1_048_576,
    expectedOutcome: 'ok',
  },
  {
    id: 'orca-over-limit',
    entryPoint: 'orca',
    recipe: 'orca/valid.json followed by ASCII spaces',
    byteLen: 1_048_577,
    expectedOutcome: 'tooLarge',
  },
  {
    id: 'asset-at-limit',
    entryPoint: 'asset',
    recipe: 'ASCII STL marker followed by deterministic zero bytes',
    byteLen: 1024,
    expectedOutcome: 'ok',
  },
  {
    id: 'asset-over-limit',
    entryPoint: 'asset',
    recipe: 'ASCII STL marker followed by deterministic zero bytes',
    byteLen: 1025,
    expectedOutcome: 'tooLarge',
  },
].map((entry) => {
  let prefix;
  if (entry.entryPoint === 'legacy')
    prefix = Buffer.from(fixtures.get('legacy/valid.json'));
  else if (entry.entryPoint === 'orca')
    prefix = Buffer.from(fixtures.get('orca/valid.json'));
  else prefix = Buffer.from('solid ', 'ascii');
  const hash = createHash('sha256');
  hash.update(prefix);
  let remaining = entry.byteLen - prefix.length;
  const padding = Buffer.alloc(
    Math.min(remaining, 64 * 1024),
    entry.entryPoint === 'asset' ? 0 : 0x20,
  );
  while (remaining > 0) {
    const length = Math.min(remaining, padding.length);
    hash.update(padding.subarray(0, length));
    remaining -= length;
  }
  return { ...entry, sha256: hash.digest('hex') };
});

const manifest = {
  generator: 'node tests/fixtures/calibration-malicious/generate.mjs',
  provenance:
    'Synthetic hostile inputs authored from raw primitives for PrintFarmerDesktop issue #158; no third-party models or user profiles.',
  fixtures: [...fixtures].map(([file, contents]) => {
    const bytes = Buffer.isBuffer(contents)
      ? contents
      : Buffer.from(contents, 'utf8');
    return {
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLen: bytes.length,
      expectedOutcome: expected[file] ?? 'ok',
    };
  }),
  materialized,
  matrix,
};
writeFileSync(
  path.join(root, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
