// Generator for the #158 malicious-input corpus.
//
// Provenance. Every fixture in this directory is synthetic and is produced
// here, so a reviewer can regenerate a hostile fixture rather than trust a
// committed blob. Nothing here is derived from a real third-party model or a
// real user profile.
//
//   node tests/fixtures/malicious-input/generate.mjs <output-dir>
//
// Output is deterministic — no timestamps, no randomness, no host paths — and
// `malicious-input fixtures > regenerate byte-for-byte from generate.mjs` in
// tests/calibrationMaliciousInputCorpus.test.ts runs this into a temporary
// directory on every CI run and compares the bytes. Editing a committed
// fixture without editing this script fails that test, which is the point:
// the fixture cannot drift away from its stated derivation.
//
// It also writes manifest.json, one record per fixture: sha256, byte length,
// the vector it carries, the entry point it is aimed at, whether it is a
// control or a hostile input, and the outcome the corpus expects. `w` refuses
// a fixture with no record, so a new fixture cannot be committed without
// stating what it is for, and the corpus cross-checks the vector and entry
// point names against its own matrix so the two cannot drift apart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node generate.mjs <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// name -> [vector, entryPoint, role, expectedOutcome, purpose]
//
// `vector` and `entryPoint` use the corpus's own spellings. `role` is
// 'control' for a benign fixture whose job is to prove the hostile one
// reached the same code, and 'malicious' otherwise. A control carries the
// vector name it is the control *for*, so the pairing is readable here.
const RECORDS = new Map(
  Object.entries({
    // --- legacy v4 backup ---
    'v4-control.json': [
      null,
      'calibrationImportV4',
      'control',
      'accepted, importable=1',
      'benign schema-v4 backup; the reachability control for every v4 cell',
    ],
    'v4-control-number.json': [
      'unsafeNumerics',
      'calibrationImportV4',
      'control',
      'accepted, importable=1',
      'same shape as the unsafe-number fixtures but every number is representable',
    ],
    'v4-deep-nesting.json': [
      'deepJson',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_TOO_DEEP',
      'object nested 40 deep, past the depth bound',
    ],
    'v4-duplicate-keys.json': [
      'duplicateKeys',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_INVALID_JSON',
      'a key repeated inside one object, so the document has two readings',
    ],
    'v4-nonfinite-number.json': [
      'unsafeNumerics',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_UNSAFE_NUMBER',
      'magnitude past the double range, which parses to Infinity',
    ],
    'v4-unsafe-integer.json': [
      'unsafeNumerics',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_UNSAFE_NUMBER',
      'integer past 2^53, which silently loses identity on every comparison',
    ],
    'v4-negative-size.json': [
      'unsafeNumerics',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_UNSAFE_NUMBER',
      'negative declared size: a length no allocation or bound can honour',
    ],
    'v4-wrong-magic.json': [
      'wrongMagicBytes',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_INVALID_MARKER',
      'does not begin with a JSON object, so it is not a v4 backup at all',
    ],
    'v4-gcode-shaped.json': [
      'gcodeOrScriptShaped',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_INVALID_MARKER',
      'G-code and shell text where the backup document should be',
    ],
    'v4-path-traversal-fields.json': [
      'pathTraversal',
      'calibrationImportV4',
      'malicious',
      'accepted as inert data, no path built from it',
      'traversal strings in name fields, to prove none is used to build a path',
    ],
    'v4-photo-control.json': [
      'malformedBase64',
      'calibrationImportV4',
      'control',
      'accepted, importable=1',
      'a correctly encoded staged photo, the control for the base64 cells',
    ],
    'v4-photo-malformed-base64.json': [
      'malformedBase64',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_INVALID_SCHEMA',
      'photo payload that is not decodable base64',
    ],
    'v4-photo-mime-mismatch.json': [
      'mimeExtensionMismatch',
      'calibrationImportV4',
      'malicious',
      'LEGACY_BACKUP_INVALID_SCHEMA',
      'declared image/png carrying JPEG bytes',
    ],

    // --- Orca profile discovery ---
    'orca-control.json': [
      null,
      'orcaProfileDiscovery',
      'control',
      'discovered',
      'benign filament profile; the reachability control for every discovery cell',
    ],
    'orca-deep-nesting.json': [
      'deepJson',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'profile nested past the depth bound',
    ],
    'orca-duplicate-keys.json': [
      'duplicateKeys',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'a key repeated inside one object of the profile',
    ],
    'orca-nonfinite-number.json': [
      'unsafeNumerics',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'magnitude past the double range',
    ],
    'orca-unsafe-integer.json': [
      'unsafeNumerics',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'integer past 2^53 in a discovered profile',
    ],
    'orca-negative-size.json': [
      'unsafeNumerics',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'negative declared size in a discovered profile',
    ],
    'orca-cycle-a.json': [
      'cyclicInheritance',
      'orcaProfileDiscovery',
      'malicious',
      'resolution terminates, leaf still returned',
      'half of an a->b->a inheritance cycle',
    ],
    'orca-cycle-b.json': [
      'cyclicInheritance',
      'orcaProfileDiscovery',
      'malicious',
      'resolution terminates, leaf still returned',
      'the other half of the a->b->a inheritance cycle',
    ],
    'orca-traversal-inherits.json': [
      'pathTraversal',
      'orcaProfileDiscovery',
      'malicious',
      'no file opened for the inherited name',
      'traversal path as an `inherits` value; inheritance is a name lookup, not a read',
    ],
    'orca-outside.json': [
      'symlinkJunctionEscape',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'the profile a link out of the search root points at',
    ],
    'orca-wrong-magic.json': [
      'wrongMagicBytes',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'binary content behind a .json name',
    ],
    'orca-gcode-shaped.json': [
      'gcodeOrScriptShaped',
      'orcaProfileDiscovery',
      'malicious',
      'excluded from results',
      'G-code and shell text behind a .json name',
    ],

    // --- Orca profile install ---
    'install-control.json': [
      null,
      'orcaProfileInstall',
      'control',
      'installed, hash verified',
      'benign generated profile; the reachability control for every install cell',
    ],
    'install-gcode-payload.txt': [
      'gcodeOrScriptShaped',
      'orcaProfileInstall',
      'malicious',
      'verificationFailed',
      'G-code and shell text offered as the payload to install',
    ],
    'install-zip-magic.bin': [
      'wrongMagicBytes',
      'orcaProfileInstall',
      'malicious',
      'verificationFailed',
      'ZIP magic bytes; also the fixture that would matter if a decompressor ever appeared',
    ],

    // --- calibration asset manifest ---
    'asset-control.stl': [
      null,
      'calibrationAssetManifest',
      'control',
      'ok',
      'a minimal structurally exact binary STL; the reachability control for every asset cell',
    ],
    'asset-deep-nesting.stl': [
      'deepJson',
      'calibrationAssetManifest',
      'malicious',
      'badMagicBytes',
      'deeply nested JSON wearing a .stl extension; never parsed as JSON',
    ],
    'asset-duplicate-keys.stl': [
      'duplicateKeys',
      'calibrationAssetManifest',
      'malicious',
      'badMagicBytes',
      'duplicate-key JSON wearing a .stl extension',
    ],
    'asset-wrong-magic.stl': [
      'wrongMagicBytes',
      'calibrationAssetManifest',
      'malicious',
      'badMagicBytes',
      'content that is not STL behind a .stl name',
    ],
    'asset-extension-mismatch.3mf': [
      'mimeExtensionMismatch',
      'calibrationAssetManifest',
      'malicious',
      'badExtension',
      'STL content offered under a .3mf extension the manifest does not declare',
    ],
    'asset-gcode-shaped.stl': [
      'gcodeOrScriptShaped',
      'calibrationAssetManifest',
      'malicious',
      'badMagicBytes',
      'G-code and shell text behind a .stl name',
    ],
    'asset-triangle-count-overflow.stl': [
      'oversized',
      'calibrationAssetManifest',
      'malicious',
      'badMagicBytes',
      'declares 0xFFFFFFFF triangles in 84 bytes: an allocation request from a header field',
    ],
  }),
);

const written = [];

const w = (name, data) => {
  const record = RECORDS.get(name);
  if (!record) {
    throw new Error(
      `${name} has no provenance record. Add one to RECORDS: a fixture with ` +
        `no stated vector, entry point, role and expected outcome is a ` +
        `committed blob a reviewer has to take on trust.`,
    );
  }
  const [vector, entryPoint, role, expectedOutcome, purpose] = record;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  writeFileSync(path.join(out, name), bytes);
  written.push({
    name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    synthetic: true,
    vector,
    entryPoint,
    role,
    expectedOutcome,
    purpose,
  });
};

const NOW = '2026-07-01T12:00:00.000Z';

// 1x1 JPEG and PNG, synthetic minimal encodings.
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const project = (extra = {}) => ({
  id: 'proj-1',
  name: 'Flow Rate',
  mode: 'flowRate',
  status: 'inProgress',
  ...extra,
});
const backup = (proj) => ({
  schemaVersion: 4,
  exportedAt: NOW,
  appVersion: '4.0.0',
  projects: [proj],
});
const j = (v) => JSON.stringify(v, null, 2) + '\n';

// deep chain, `levels` objects deep
function chain(levels) {
  let node = { leaf: 1 };
  for (let i = 0; i < levels; i++) node = { n: node };
  return node;
}

// --- legacy v4 backup fixtures -------------------------------------------
w('v4-control.json', j(backup(project())));
w('v4-deep-nesting.json', j(backup(project({ deep: chain(40) }))));
w(
  'v4-nonfinite-number.json',
  j(
    backup(
      project({
        steps: [
          {
            id: 'step-1',
            type: 'flowRate',
            order: 1,
            attempts: [],
            currentAttemptId: null,
          },
        ],
      }),
    ),
  ).replace('"order": 1,', '"order": 1e999,'),
);
w(
  'v4-control-number.json',
  j(
    backup(
      project({
        steps: [
          {
            id: 'step-1',
            type: 'flowRate',
            order: 1,
            attempts: [],
            currentAttemptId: null,
          },
        ],
      }),
    ),
  ),
);
// duplicate key: a second literal "status" inside the project object
w(
  'v4-duplicate-keys.json',
  j(backup(project())).replace(
    '"status": "inProgress"',
    '"status": "inProgress",\n      "status": "done"',
  ),
);
w(
  'v4-photo-control.json',
  j(
    backup(
      project({
        photos: [
          { id: 'photo-1', dataUrl: `data:image/png;base64,${PNG_B64}` },
        ],
      }),
    ),
  ),
);
w(
  'v4-photo-malformed-base64.json',
  j(
    backup(
      project({
        photos: [
          { id: 'photo-1', dataUrl: 'data:image/png;base64,@@@not-base64@@@' },
        ],
      }),
    ),
  ),
);
w(
  'v4-photo-mime-mismatch.json',
  j(
    backup(
      project({
        // Declares PNG, carries JPEG magic bytes.
        photos: [
          { id: 'photo-1', dataUrl: `data:image/png;base64,${JPEG_B64}` },
        ],
      }),
    ),
  ),
);
w(
  'v4-path-traversal-fields.json',
  j(
    backup(
      project({
        name: '../../../../etc/passwd',
        legacyId: '..\\..\\..\\Windows\\System32\\config\\SAM',
        filamentName: '__PFD_TRAVERSAL_TARGET__',
      }),
    ),
  ),
);
// wrong magic bytes for a .json backup: PKZIP local file header, then JSON
w(
  'v4-wrong-magic.json',
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(j(backup(project())), 'utf8'),
  ]),
);
w(
  'v4-gcode-shaped.json',
  'G28 ; home all axes\nG1 Z5 F5000\nM104 S200\nG1 X10 Y10 F3000\nM84\n',
);

// --- OrcaSlicer profile fixtures -----------------------------------------
const PROFILE_NAME = 'PFD Corpus Filament';
const profile = (extra = {}) => ({
  type: 'filament',
  name: PROFILE_NAME,
  filament_type: 'PLA',
  ...extra,
});

w('orca-control.json', j(profile()));
w('orca-deep-nesting.json', j(profile({ deep: chain(40) })));
w(
  'orca-duplicate-keys.json',
  j(profile()).replace(
    '"filament_type": "PLA"',
    '"filament_type": "PLA",\n  "filament_type": "ABS"',
  ),
);
// A <-> B inheritance cycle. A carries the discoverable name.
w('orca-cycle-a.json', j(profile({ inherits: 'PFD Corpus Parent' })));
w(
  'orca-cycle-b.json',
  j({
    type: 'filament',
    name: 'PFD Corpus Parent',
    inherits: PROFILE_NAME,
    filament_type: 'ABS',
  }),
);
w(
  'orca-traversal-inherits.json',
  j(profile({ inherits: '../../../../outside/orca-outside.json' })),
);
w(
  'orca-nonfinite-number.json',
  j(profile({ nozzle_temperature: [220], filament_flow_ratio: [1] }))
    .replace('220', '1e999')
    .replace(
      '"filament_flow_ratio": [\n    1\n  ]',
      '"filament_flow_ratio": [\n    -1\n  ]',
    ),
);
w(
  'orca-wrong-magic.json',
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(j(profile()), 'utf8'),
  ]),
);
w(
  'orca-gcode-shaped.json',
  'G28 ; home all axes\nG1 Z5 F5000\nM104 S200\nSET_PRESSURE_ADVANCE ADVANCE=0.05\nM84\n',
);
// The profile a symlink/junction escape would reach if traversal followed it.
w(
  'orca-outside.json',
  j({
    type: 'filament',
    name: PROFILE_NAME,
    filament_type: 'ESCAPED',
  }),
);

// --- calibration asset fixtures ------------------------------------------
function binaryStl(triangleCount, actualTriangles = triangleCount) {
  const buf = Buffer.alloc(80 + 4 + actualTriangles * 50, 0);
  buf.write('PFD synthetic binary STL corpus fixture', 0, 'ascii');
  buf.writeUInt32LE(triangleCount, 80);
  return buf;
}

w('asset-control.stl', binaryStl(1));
w('asset-extension-mismatch.3mf', binaryStl(1));
// 20 bytes: below the 84-byte binary-STL floor and not "solid ", so the
// content type cannot be detected at all.
w('asset-wrong-magic.stl', Buffer.alloc(20, 0x41));
// Header claims 0xFFFFFFFF triangles; the file is one triangle long.
w('asset-triangle-count-overflow.stl', binaryStl(0xffffffff, 1));
// G-code shaped, deliberately under 84 bytes.
w('asset-gcode-shaped.stl', 'G28 ; home\nG1 X10 Y10 F3000\nM104 S200\nM84\n');
// A duplicate-key JSON document offered as an .stl, under 84 bytes.
w('asset-duplicate-keys.stl', '{"a":1,"a":2}\n');

// A deeply nested JSON document offered as an .stl. Padded so that bytes
// 80..83 are the ASCII "zzzz" the binary-STL reader will interpret as a
// triangle count, which makes the rejection deterministic.
{
  let body = '{"n":'.repeat(40) + '1' + '}'.repeat(40) + '\n';
  const prefix = '{"pad":"';
  // Build: prefix + padding so that offsets 80..83 are "zzzz".
  const padLen = 80 - prefix.length;
  const head = prefix + 'p'.repeat(padLen);
  const doc = Buffer.concat([
    Buffer.from(head, 'ascii'),
    Buffer.from('zzzz', 'ascii'),
    Buffer.from('","body":' + body, 'ascii'),
  ]);
  w('asset-deep-nesting.stl', doc);
}

// --- install payloads -----------------------------------------------------
w(
  'install-gcode-payload.txt',
  'G28 ; home all axes\nG1 Z5 F5000\nM104 S200\nM84\n',
);
w(
  'install-zip-magic.bin',
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('not a profile', 'utf8'),
  ]),
);
w('install-control.json', j({ type: 'filament', name: 'PFD Corpus Install' }));

// --- unsafe numerics ------------------------------------------------------
// 9007199254740993 is 2^53 + 1: the smallest positive integer a double cannot
// represent, so it silently changes value on parse. -1 as a size or count is a
// length no allocation or bound can honour. Both were ACCEPTED as importable
// before the guard existed; only non-finite was refused, and only because
// JSON.parse cannot produce it.
//
// The literal cannot be written as a JS number — evaluating it yields
// 9007199254740992, one less, which is representable and therefore not the
// vector. It is substituted into the JSON text instead, so the committed
// bytes carry the unrepresentable token exactly as an attacker would send it.
const UNSAFE_INT = '9007199254740993';
const UNSAFE_INT_SENTINEL = -424242;
const withUnsafeInt = (text) =>
  text.split(String(UNSAFE_INT_SENTINEL)).join(UNSAFE_INT);

w(
  'v4-unsafe-integer.json',
  withUnsafeInt(
    j(
      backup(
        project({
          steps: [
            {
              id: 'step-1',
              type: 'flowRate',
              order: 1,
              payload_count: UNSAFE_INT_SENTINEL,
              attempts: [],
              currentAttemptId: null,
            },
          ],
        }),
      ),
    ),
  ),
);
w(
  'v4-negative-size.json',
  j(
    backup(
      project({
        steps: [
          {
            id: 'step-1',
            type: 'flowRate',
            order: 1,
            payload_size: -1,
            attempts: [],
            currentAttemptId: null,
          },
        ],
      }),
    ),
  ),
);
w(
  'orca-unsafe-integer.json',
  withUnsafeInt(j(profile({ filament_length: [UNSAFE_INT_SENTINEL] }))),
);
w(
  'orca-negative-size.json',
  j(profile({ filament_spool_size: [-1] })),
);

writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      issue: 158,
      generator: 'tests/fixtures/malicious-input/generate.mjs',
      synthetic: true,
      note:
        'Every entry is generated by the script named above and is compared ' +
        'byte-for-byte against a fresh run in CI. No real third-party model ' +
        'and no real user profile is included, and nothing here is executed.',
      fixtures: written.sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  ) + '\n',
);

console.log('wrote fixtures to', out);
