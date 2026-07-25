import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

interface ZipEntry {
  name: string;
  bytes: Buffer;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createEditableRetargetFixture(directory: string): {
  file: string;
  sha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const text = (value: string): Buffer => Buffer.from(value, 'utf8');
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      bytes: text(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Override PartName="/Metadata/project_settings.config" ContentType="application/json"/>
  <Override PartName="/Metadata/model_settings.config" ContentType="application/xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      bytes: text(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>`),
    },
    {
      name: '3D/3dmodel.model',
      bytes: text(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">OrcaSlicer-2.3.5</metadata>
  <resources>
    <object id="1" name="Independent triangle" type="model"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
  </resources>
  <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 0"/></build>
</model>`),
    },
    {
      name: 'Metadata/project_settings.config',
      bytes: text(
        JSON.stringify({
          printer_model: 'Independent source printer',
          printer_settings_id: 'Independent 0.4',
          print_settings_id: 'Independent standard',
          layer_height: '0.2',
          filament_type: ['PLA'],
          filament_colour: ['#336699'],
          inner_wall_speed: '9999',
          default_acceleration: '99999',
        }),
      ),
    },
    {
      name: 'Metadata/model_settings.config',
      bytes: text(
        '<config><object id="1" extruder="1"/><plate><metadata key="object_id" value="1"/></plate></config>',
      ),
    },
  ];
  const file = path.join(directory, 'independent-u1-source.3mf');
  const bytes = storedZip(entries);
  writeFileSync(file, bytes);
  return {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function findPackagedExecutable(repoRoot: string): string {
  const out = path.join(repoRoot, 'out');
  const expected =
    process.platform === 'win32'
      ? 'PrintFarmer Desktop.exe'
      : 'PrintFarmer Desktop';
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'make') visit(full);
      } else if (
        entry.name === expected &&
        (process.platform === 'win32' ||
          full.includes(`${path.sep}Contents${path.sep}MacOS${path.sep}`))
      ) {
        candidates.push(full);
      }
    }
  };
  if (existsSync(out) && statSync(out).isDirectory()) visit(out);
  const executable = candidates.sort(
    (left, right) => left.length - right.length,
  )[0];
  if (!executable) {
    throw new Error(
      `Packaged executable '${expected}' was not found under ${out}. Run npm run package first.`,
    );
  }
  return executable;
}
