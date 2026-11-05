import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of [...await files(path.join(root, 'extension')), ...await files(path.join(root, 'tests')), ...await files(path.join(root, 'scripts'))]) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'bookmarks', 'tabs']);
assert.ok(!manifest.host_permissions, '扩展不应申请互联网或 file:// 主机权限');
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
assert.ok(!manifest.permissions.includes('nativeMessaging'));
assert.ok(!manifest.permissions.includes('downloads'));
const html = await readFile(path.join(root, 'extension/options.html'), 'utf8');
assert.ok(!/\son\w+=|<script[^>]*>[^<]+<\/script>/i.test(html), '页面不得使用内联脚本');
console.log('所有 JavaScript 语法、扩展清单、本地权限与 CSP 检查通过。');
