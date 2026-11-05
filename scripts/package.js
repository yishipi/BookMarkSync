import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });

async function files(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), `${name}/`));
    else result.push({ name, bytes: await readFile(path.join(directory, entry.name)) });
  }
  return result;
}

const table = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

async function zip(name, entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(fileName.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(fileName.length, 28); record.writeUInt32LE(offset, 42);
    parts.push(local, fileName, compressed); central.push(record, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...parts, directory, end]);
  await writeFile(path.join(output, name), bytes);
  return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
}

const extensionFiles = await files(path.join(root, 'extension'));
const readme = { name: 'README.md', bytes: await readFile(path.join(root, 'README.md')) };
const validation = { name: 'VALIDATION.md', bytes: await readFile(path.join(root, 'VALIDATION.md')) };
const review = { name: 'REVIEW.md', bytes: await readFile(path.join(root, 'REVIEW.md')) };
const extensionHash = await zip(`BookMarkSync-extension-${manifest.version}.zip`, [...extensionFiles, readme, validation, review]);
const sourceFiles = [...extensionFiles.map(entry => ({ ...entry, name: `extension/${entry.name}` })), readme, validation, review,
  ...await files(path.join(root, 'scripts'), 'scripts/'), ...await files(path.join(root, 'tests'), 'tests/'),
  { name: 'package.json', bytes: await readFile(path.join(root, 'package.json')) },
  { name: '.gitignore', bytes: await readFile(path.join(root, '.gitignore')) },
  { name: 'shared/.gitignore', bytes: await readFile(path.join(root, 'shared/.gitignore')) },
];
const sourceHash = await zip(`BookMarkSync-source-${manifest.version}.zip`, sourceFiles);
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${extensionHash}\n${sourceHash}\n`);
console.log(`已生成扩展包和源码包：${output}`);
