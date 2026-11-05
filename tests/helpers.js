import { SyncEngine } from '../extension/lib/engine.js';
import { BrowserBookmarks } from '../extension/lib/bookmarks.js';

export class MemoryStore {
  constructor() { this.data = new Map([['directory', { name: 'shared' }]]); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
  async setMany(entries) { for (const [key, value] of entries) await this.set(key, value); }
}

export class MemoryExchange {
  constructor() {
    this.workspaceValue = { schema: 1, type: 'BookMarkSync', id: crypto.randomUUID() };
    this.files = new Map(); this.backups = []; this.denied = false; this.writes = 0;
  }
  async checkPermission() {
    if (this.denied) throw Object.assign(new Error('需要目录授权'), { code: 'permission' });
  }
  async workspace() { return this.workspaceValue; }
  async documents() { return [...this.files].map(([name, document]) => ({ name, document: structuredClone(document), modified: Date.now() })); }
  async write(name, value) { this.files.set(name, structuredClone(value)); this.writes++; }
  async backup(actor, tree) { this.backups.push({ actor, tree: structuredClone(tree) }); }
}

// A narrow substitute for the browser API. The actual merge, capture, planning,
// ordering, checkpoints and engine are all production code.
export class MemoryBookmarks {
  constructor() {
    this.tree = [{ id: '0', title: '', children: [
      { id: '1', parentId: '0', title: '书签栏', folderType: 'bookmarks-bar', syncing: true, children: [] },
      { id: '2', parentId: '0', title: '其他书签', folderType: 'other', syncing: true, children: [] },
      { id: '3', parentId: '0', title: '移动设备书签', folderType: 'mobile', syncing: true, children: [] },
    ] }];
    this.nextId = 100; this.mutations = 0; this.failAfter = Infinity;
  }
  find(id) {
    function visit(nodes) {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = visit(node.children || []);
        if (found) return found;
      }
    }
    const node = visit(this.tree);
    if (!node) throw new Error(`No bookmark ${id}`);
    return node;
  }
  reindex() {
    function visit(nodes) { nodes.forEach((node, index) => { node.index = index; visit(node.children || []); }); }
    visit(this.tree);
  }
  changed() { this.reindex(); if (++this.mutations === this.failAfter) throw new Error('模拟中断'); }
  async getTree() { this.reindex(); return structuredClone(this.tree); }
  async get(id) { this.reindex(); return [structuredClone(this.find(id))]; }
  async getChildren(id) { this.reindex(); return structuredClone(this.find(id).children || []); }
  async create(options) {
    const node = { id: String(this.nextId++), parentId: options.parentId, title: options.title || '',
      dateAdded: Date.now(), ...(options.url === undefined ? { children: [] } : { url: options.url }) };
    this.find(options.parentId).children.splice(options.index ?? Infinity, 0, node);
    this.changed(); return structuredClone(node);
  }
  async update(id, fields) { Object.assign(this.find(id), fields); this.changed(); return structuredClone(this.find(id)); }
  async move(id, target) {
    const node = this.find(id);
    let parent = this.find(target.parentId || node.parentId);
    for (let cursor = parent; cursor?.parentId; cursor = this.find(cursor.parentId)) {
      if (cursor.id === id) throw new Error('Cannot move folder into descendant');
    }
    const oldParent = this.find(node.parentId);
    oldParent.children.splice(oldParent.children.indexOf(node), 1);
    node.parentId = parent.id;
    parent.children.splice(Math.min(target.index ?? Infinity, parent.children.length), 0, node);
    this.changed(); return structuredClone(node);
  }
  async remove(id) {
    const node = this.find(id);
    if (node.children?.length) throw new Error('Folder not empty');
    const parent = this.find(node.parentId);
    parent.children.splice(parent.children.indexOf(node), 1);
    this.changed();
  }
  async removeTree(id) {
    const node = this.find(id);
    const parent = this.find(node.parentId);
    parent.children.splice(parent.children.indexOf(node), 1);
    this.changed();
  }
}

export function participant(shared, label = 'Chrome') {
  const store = new MemoryStore();
  const api = new MemoryBookmarks();
  const bookmarks = new BrowserBookmarks(api);
  const engine = new SyncEngine({ store, bookmarks, exchange: () => shared, label });
  return { store, api, engine };
}

export async function start(participant) {
  await participant.engine.configure({ intervalSeconds: 30 });
  const view = await participant.engine.setEnabled(true);
  if (view.status.phase === 'error') throw new Error(view.status.message);
}

export async function settle(...participants) {
  for (let round = 0; round < 3; round++) {
    for (const item of participants) {
      const view = await item.engine.run();
      if (view.status.phase === 'error') throw new Error(view.status.message);
    }
  }
}

export function treeContents(api) {
  function clean(node) {
    return { title: node.title, ...(node.url === undefined ? { children: node.children.map(clean) } : { url: node.url }) };
  }
  return api.tree[0].children.map(clean);
}
