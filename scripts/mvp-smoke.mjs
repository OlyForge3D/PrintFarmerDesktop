// Headless end-to-end MVP smoke test.
//
// Spawns the *real* staged sidecar binary and drives it over the same
// newline-delimited JSON-RPC transport the Electron main process uses,
// exercising the core MVP data paths against a real generated STL fixture:
// handshake -> loadScene (geometry + parts) -> scanRoot -> listModels ->
// tags -> collections. Exits non-zero on the first failed assertion.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sidecar = path.resolve('resources/sidecar', 'model-core.exe');
const work = mkdtempSync(path.join(tmpdir(), 'pf-mvp-'));
const catalogDb = path.join(work, 'catalog.sqlite3');
const modelDir = path.join(work, 'models');
import { mkdirSync } from 'node:fs';
mkdirSync(modelDir, { recursive: true });

// --- Build a real binary STL (a unit tetrahedron: 4 triangles) ---
function writeBinaryStl(file) {
  const tris = [
    [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ],
    [
      [0, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ],
    [
      [0, 0, 0],
      [0, 0, 10],
      [10, 0, 0],
    ],
    [
      [10, 0, 0],
      [0, 0, 10],
      [0, 10, 0],
    ],
  ];
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    // normal left zero; then 3 vertices
    off += 12;
    for (const v of t) {
      buf.writeFloatLE(v[0], off);
      buf.writeFloatLE(v[1], off + 4);
      buf.writeFloatLE(v[2], off + 8);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  writeFileSync(file, buf);
}

const stlPath = path.join(modelDir, 'tetra.stl');
writeBinaryStl(stlPath);

// --- JSON-RPC client over the child's stdio ---
const child = spawn(sidecar, ['--catalog-db', catalogDb], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (!msg.ok) reject(new Error(`${method} failed: ${msg.error}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

try {
  // 1. handshake
  const hs = await call('handshake');
  check(
    'handshake protocolVersion',
    hs.protocolVersion === 1,
    JSON.stringify(hs),
  );
  check(
    'handshake sidecarVersion present',
    typeof hs.sidecarVersion === 'string',
  );

  // 2. loadScene on the real STL
  const scene = await call('loadScene', { path: stlPath });
  check(
    'loadScene format is stl',
    scene.sourceFormat === 'stl',
    scene.sourceFormat,
  );
  check(
    'loadScene has 4 triangles',
    scene.indices.length === 12,
    `indices=${scene.indices.length}`,
  );
  check(
    'loadScene positions non-empty',
    Array.isArray(scene.positions) && scene.positions.length > 0,
  );
  check(
    'loadScene has one Model part',
    scene.parts.length === 1 && scene.parts[0].name === 'Model',
    JSON.stringify(scene.parts),
  );
  check(
    'loadScene part covers all triangles',
    scene.parts[0].triangleCount === 4,
    `triangleCount=${scene.parts[0]?.triangleCount}`,
  );

  // 3. scanRoot -> reconcile the folder into the persistent catalog
  const report = await call('scanRoot', { rootId: 'root-1', path: modelDir });
  check(
    'scanRoot found the model',
    report.added >= 1 || report.total >= 1,
    JSON.stringify(report),
  );

  // 4. listModels reflects the scan
  const models = await call('listModels');
  check(
    'listModels returns the scanned model',
    models.length === 1,
    `count=${models.length}`,
  );
  const hash = models[0]?.hash;
  check(
    'model has a sha-256 hash',
    typeof hash === 'string' && hash.length === 64,
    hash,
  );

  // 5. tags round-trip
  await call('addModelTag', { hash, name: 'Miniature' });
  const tags = await call('tagsForModel', { hash });
  check(
    'tag was attached',
    tags.some((t) => t.name === 'miniature' || t.name === 'Miniature'),
    JSON.stringify(tags),
  );

  // 6. collections round-trip
  const created = await call('createCollection', { name: 'Dragons' });
  check(
    'createCollection returns id',
    typeof created.id === 'string',
    JSON.stringify(created),
  );
  await call('addModelToCollection', { collectionId: created.id, hash });
  const memberships = await call('collectionsForModel', { hash });
  check(
    'model is in the collection',
    memberships.some((c) => c.id === created.id),
    JSON.stringify(memberships),
  );
} catch (err) {
  failures++;
  console.log(`  ERROR ${err.message}`);
} finally {
  child.stdin.end();
  child.kill();
}

console.log(
  failures === 0
    ? '\nALL MVP SMOKE CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
