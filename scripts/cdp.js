import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class CDP extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else this.emit(message.method, message.params, message.sessionId);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser disconnected')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression, options = {}) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...options }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

export async function launchBrowser(executable, profile, extension) {
  const testRoot = path.resolve(fileURLToPath(new URL('../work/', import.meta.url))) + path.sep;
  if (!path.resolve(profile).toLowerCase().startsWith(testRoot.toLowerCase())) {
    throw new Error('Browser tests may only use disposable profiles inside this project work directory');
  }
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const expectedId = [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
  let registered = false;
  try {
    const preferences = JSON.parse(await readFile(path.join(profile, 'Default/Secure Preferences'), 'utf8'));
    registered = Boolean(preferences.extensions?.settings?.[expectedId]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(profile, { recursive: true });
  await unlink(path.join(profile, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const child = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--edge-skip-compat-layer-relaunch',
    '--enable-automation', '--disable-sync', '--no-service-autorun',
    '--disable-features=msEdgeContinuousFavoritesImport,msEdgeAutoImportFromIE,msEdgeAutoImportFromFirefox,msEdgeFRESpartanImportAllowed,msEdgeImportOEMFavorites',
    '--disable-default-apps', '--disable-component-update', '--disable-background-networking',
    '--no-proxy-server', '--window-size=1200,1100', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-4000); });
  let lines;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Browser exited ${child.exitCode}: ${log}`);
    try { lines = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!lines) { child.kill(); throw new Error(`Browser startup timeout: ${log}`); }
  const client = await CDP.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  let extensions = await client.send('Extensions.getExtensions');
  if (registered) {
    for (let attempt = 0; attempt < 10 && !extensions.extensions?.some(item => item.id === expectedId); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      extensions = await client.send('Extensions.getExtensions');
    }
  }
  let extensionId = extensions.extensions?.find(item => item.id === expectedId)?.id;
  const wasInstalled = Boolean(extensionId);
  // Chrome 156 intentionally removes CDP-installed temporary extensions at
  // restart. Reattach the fixture; never disguise this as a persistent install.
  const temporaryReload = registered && !wasInstalled;
  if (!extensionId) extensionId = (await client.send('Extensions.loadUnpacked', { path: extension })).id;
  const { targetId } = await client.send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  for (let attempt = 0; attempt < 100; attempt++) {
    const loaded = await client.evaluate(sessionId, 'document.readyState === "complete" && !!document.getElementById("choose")').catch(() => false);
    if (loaded) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return {
    client, extensionId, sessionId, targetId, child, profile, wasInstalled, temporaryReload,
    evaluate: expression => client.evaluate(sessionId, expression),
    close: async () => {
      await client.send('Browser.close').catch(() => {});
      client.socket.close();
      if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (child.exitCode === null) child.kill();
    },
  };
}
