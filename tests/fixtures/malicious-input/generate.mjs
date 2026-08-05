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
// It also writes manifest.json, one line per fixture: sha256, byte length,
// and what the fixture is hostile about.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node generate.mjs <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

/** name -> what makes this fixture hostile. Every `w` call must be described. */
const PURPOSE = new Map();
const written = [];

const w = (name, data, purpose) => {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  writeFileSync(path.join(out, name), bytes);
  written.push({
    name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    purpose: purpose ?? PURPOSE.get(name) ?? 'control fixture (vector removed)',
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
  'integer past 2^53 in a v4 backup step',
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
  'negative declared size in a v4 backup step',
);
w(
  'orca-unsafe-integer.json',
  withUnsafeInt(j(profile({ filament_length: [UNSAFE_INT_SENTINEL] }))),
  'integer past 2^53 in a discovered Orca profile',
);
w(
  'orca-negative-size.json',
  j(profile({ filament_spool_size: [-1] })),
  'negative declared size in a discovered Orca profile',
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
