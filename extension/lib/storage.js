import { MAX_FILE_BYTES } from './model.js';

const DB_NAME = 'bookmark-sync-local-v1';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      let request;
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('本地保存被中断。'));
      try { request = action(tx.objectStore('kv')); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export const database = {
  get: key => transaction('readonly', store => store.get(key)),
  set: (key, value) => transaction('readwrite', store => store.put(value, key)),
  remove: key => transaction('readwrite', store => store.delete(key)),
  setMany: entries => transaction('readwrite', store => {
    let request;
    for (const [key, value] of entries) request = store.put(value, key);
    return request;
  }),
};

export class DirectoryExchange {
  constructor(handle) { this.handle = handle; }

  async checkPermission() {
    const granted = await this.handle.queryPermission({ mode: 'readwrite' });
    if (granted !== 'granted') {
      const error = new Error('需要恢复共享目录的读写授权，请打开扩展设置点击“恢复授权”。');
      error.code = 'permission';
      throw error;
    }
  }

  async workspace({ create = false } = {}) {
    const name = 'BookMarkSync.workspace.json';
    const existing = await this.read(name, true);
    if (existing) return validateWorkspace(existing);
    if (!create) throw new Error('共享目录的工作区标识文件丢失，请恢复该文件，或重新选择目录并检查合并预览。');
    const documents = await this.documents();
    if (documents.length) throw new Error('目录中有同步数据，但工作区标识文件丢失。请先恢复 BookMarkSync.workspace.json，避免混用数据。');
    await this.write(name, { schema: 1, type: 'BookMarkSync', id: crypto.randomUUID(), createdAt: Date.now() });
    return validateWorkspace(await this.read(name));
  }

  async read(name, optional = false) {
    let fileHandle;
    try { fileHandle = await this.handle.getFileHandle(name); }
    catch (error) {
      if (optional && error.name === 'NotFoundError') return null;
      throw error;
    }
    const file = await fileHandle.getFile();
    if (file.size > MAX_FILE_BYTES) throw new Error(`交换文件超过 20 MiB：${name}`);
    const content = await file.text();
    try { return JSON.parse(content); }
    catch { throw new Error(`文件无法完整读取：${name}。已保留本地书签，将在下次重试。`); }
  }

  async documents() {
    const documents = [];
    for await (const [name, handle] of this.handle.entries()) {
      if (handle.kind !== 'file' || !/^replica-[a-zA-Z0-9_-]{8,100}\.json$/.test(name)) continue;
      documents.push({ name, document: await this.read(name), modified: (await handle.getFile()).lastModified });
    }
    return documents;
  }

  async write(name, value) {
    const content = JSON.stringify(value);
    if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) throw new Error(`文件超过 20 MiB，未写入：${name}`);
    const handle = await this.handle.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    try {
      await stream.write(content);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }

  async backup(actor, tree) {
    const directory = await this.handle.getDirectoryHandle('backups', { create: true });
    const exchange = new DirectoryExchange(directory);
    const name = `backup-${actor}-${Date.now()}.json`;
    await exchange.write(name, { schema: 1, createdAt: Date.now(), tree });
    const ours = [];
    for await (const [entry, handle] of directory.entries()) {
      if (handle.kind === 'file' && entry.startsWith(`backup-${actor}-`) && /^backup-[a-zA-Z0-9_-]+-\d+\.json$/.test(entry)) ours.push(entry);
    }
    for (const old of ours.sort().slice(0, -10)) await directory.removeEntry(old);
  }
}

function validateWorkspace(value) {
  if (value?.schema !== 1 || value.type !== 'BookMarkSync' ||
    !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('所选目录的工作区标识无效，请选择正确的共享目录。');
  return value;
}
