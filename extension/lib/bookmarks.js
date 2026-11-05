import { ROOTS, changeFields } from './model.js';

const ROOT_NAMES = { 'root:toolbar': '收藏栏', 'root:other': '其他收藏夹', 'root:mobile': '移动设备书签' };

export class BrowserBookmarks {
  constructor(api) { this.api = api; }

  async read(bindings = {}) {
    const tree = await this.api.getTree();
    const roots = [];
    let ignored = 0;
    function convert(node, root) {
      if (node.unmodifiable || node.folderType === 'managed') {
        ignored++;
        return null;
      }
      const virtualRoot = ROOTS.includes(bindings[node.id]) ? bindings[node.id] : null;
      if (virtualRoot && !root) {
        const virtual = convert(node, virtualRoot);
        virtual.virtual = true;
        roots.push(virtual);
        return null;
      }
      return {
        id: node.id, parentId: node.parentId, root: root || null, kind: node.url === undefined ? 'folder' : 'bookmark',
        title: node.title, url: node.url ?? null, dateAdded: node.dateAdded || 0,
        syncing: Boolean(node.syncing), children: (node.children || []).map(child => convert(child)).filter(Boolean),
      };
    }
    const browserRoots = tree[0]?.children;
    if (!browserRoots?.length) throw new Error('浏览器暂时没有返回书签根目录，稍后重试。');
    for (const [index, node] of browserRoots.entries()) {
      const role = rootRole(node, index);
      if (!role || node.unmodifiable || node.folderType === 'managed') { ignored++; continue; }
      roots.push(convert(node, role));
    }
    return { roots: roots.filter(Boolean), ignored, tree };
  }

  async plan(state, target) {
    const current = state.observed || {};
    const availableRoots = new Set(ROOTS.flatMap(role => current[role]?.nativeIds || []));
    const unavailable = unavailableNodes(state, target, availableRoots);
    let creates = 0, updates = 0, moves = 0, removes = 0, reorders = 0;
    for (const [id, node] of Object.entries(target.nodes)) {
      if (unavailable.has(id)) continue;
      const actual = current[id];
      if (!actual) { creates++; continue; }
      if (actual.title !== node.title || actual.url !== node.url) updates++;
      if (actual.parent !== node.parent) moves++;
    }
    for (const id of Object.keys(current)) {
      if (!ROOTS.includes(id) && !unavailable.has(id) && !target.nodes[id]) removes++;
    }
    for (const [id, ids] of Object.entries(target.children)) {
      const actual = current[id]?.children;
      if (!actual || unavailable.has(id)) continue;
      if (!ROOTS.includes(id)) {
        if (JSON.stringify(actual) !== JSON.stringify(ids)) reorders++;
        continue;
      }
      // Local/account roots cannot be interleaved physically. Compare only
      // the order that can be applied inside each available native root.
      const desiredIds = new Set(ids);
      for (const nativeId of current[id].nativeIds) {
        const group = actual.filter(child => current[child]?.rootNativeId === nativeId && desiredIds.has(child));
        const present = new Set(group);
        if (JSON.stringify(group) !== JSON.stringify(ids.filter(child => present.has(child)))) reorders++;
      }
    }
    return { creates, updates, moves, removes, reorders, total: creates + updates + moves + removes + reorders };
  }

  async apply(state, target, checkpoint) {
    const snapshot = await this.read(state.bindings);
    const rootMap = new Map();
    for (const root of snapshot.roots) {
      const entries = rootMap.get(root.root) || [];
      entries.push(root);
      rootMap.set(root.root, entries);
    }
    const fallback = rootMap.get('root:other')?.[0] || rootMap.get('root:toolbar')?.[0];
    if (!fallback) throw new Error('没有可写的收藏夹根目录。');
    const native = new Map();
    const nativeParents = new Map();
    function index(node) {
      const id = state.bindings[node.id];
      if (id && !ROOTS.includes(id)) native.set(id, node.id);
      for (const child of node.children) { nativeParents.set(child.id, node.id); index(child); }
    }
    snapshot.roots.forEach(index);
    const availableRoots = new Set(snapshot.roots.map(root => root.id));
    const unavailable = unavailableNodes(state, target, availableRoots);
    for (const role of ROOTS) {
      if (rootMap.has(role) || !target.children[role]?.some(id => !unavailable.has(id))) continue;
      const folder = await this.api.create({ parentId: fallback.id, title: ROOT_NAMES[role] });
      state.bindings[folder.id] = role;
      rootMap.set(role, [{ ...folder, root: role, children: [], syncing: fallback.syncing }]);
      await checkpoint();
    }
    function parentNative(parent, existing) {
      if (!ROOTS.includes(parent)) return native.get(parent);
      const options = rootMap.get(parent) || [fallback];
      // Preserve existing local/account roots; new items prefer a root synced by the browser.
      if (existing && options.some(root => root.id === existing)) return existing;
      return (options.find(root => root.syncing) || options[0]).id;
    }
    const api = this.api;
    const ensured = new Set();
    async function ensureNode(id) {
      const node = target.nodes[id];
      if (!node || unavailable.has(id) || ensured.has(id)) return;
      // Final parents are positioned first, even when they already exist. This
      // permits ancestor swaps without intermediate moves that a crash could
      // mistake for a local edit.
      if (!ROOTS.includes(node.parent)) await ensureNode(node.parent);
      let nativeId = native.get(id);
      if (!nativeId) {
        const parentId = parentNative(node.parent);
        const created = await api.create({ parentId, title: node.title,
          ...(node.kind === 'bookmark' ? { url: node.url } : {}) });
        nativeId = created.id;
        native.set(id, nativeId);
        state.bindings[nativeId] = id;
        nativeParents.set(nativeId, parentId);
        let rootNativeId = parentId;
        while (nativeParents.has(rootNativeId)) rootNativeId = nativeParents.get(rootNativeId);
        // A durable acknowledgement lets the next capture distinguish edits
        // or deletion of a newly created item from an unfinished replay.
        state.observed[id] = { nativeId, rootNativeId, dateAdded: created.dateAdded || 0,
          kind: node.kind, title: node.title, url: node.url, parent: node.parent, children: [] };
        await checkpoint();
      }
      const [actual] = await api.get(nativeId);
      const old = state.observed[id];
      const update = {};
      // If the browser/cloud changed a field since capture, leave it for the
      // next capture instead of overwriting it with a stale incoming value.
      if (actual.title !== node.title && (!old || actual.title === old.title)) update.title = node.title;
      if (node.kind === 'bookmark' && actual.url !== node.url && (!old || actual.url === old.url)) update.url = node.url;
      if (Object.keys(update).length) await api.update(nativeId, update);
      const parentId = parentNative(node.parent, actual.parentId);
      const currentParent = state.bindings[actual.parentId];
      if (actual.parentId !== parentId && (!old || currentParent === old.parent)) {
        await api.move(nativeId, { parentId });
        nativeParents.set(nativeId, parentId);
      }
      ensured.add(id);
    }
    for (const id of Object.keys(target.nodes)) await ensureNode(id);
    // Move surviving children out before deleting a parent. Never removeTree:
    // a cloud/user insertion during this pass must not be deleted as collateral.
    const stale = [...native.keys()].filter(id => !target.nodes[id]);
    async function preserveLateEdits(id, actual) {
      const old = state.observed[id];
      if (!old) return;
      const updates = {};
      if (actual.title !== old.title) updates.title = actual.title;
      if (actual.url !== undefined && actual.url !== old.url) updates.url = actual.url;
      const parent = state.bindings[actual.parentId];
      if (parent && parent !== old.parent) updates.parent = parent;
      if (!Object.keys(updates).length) return;
      changeFields(state, id, updates);
      await checkpoint();
    }
    for (const id of stale.filter(id => state.records[id]?.kind?.value === 'bookmark')) {
      const [actual] = await this.api.get(native.get(id));
      await preserveLateEdits(id, actual);
      await this.api.remove(native.get(id));
      delete state.bindings[native.get(id)];
      native.delete(id);
      await checkpoint();
    }
    let remaining = stale.filter(id => native.has(id));
    while (remaining.length) {
      let removed = false;
      for (const id of remaining) {
        const children = await this.api.getChildren(native.get(id));
        if (children.length) continue;
        const [actual] = await this.api.get(native.get(id));
        await preserveLateEdits(id, actual);
        await this.api.remove(native.get(id));
        delete state.bindings[native.get(id)];
        native.delete(id);
        removed = true;
        await checkpoint();
      }
      remaining = remaining.filter(id => native.has(id));
      if (!removed) break;
    }
    for (const [parent, ids] of Object.entries(target.children)) {
      const parents = ROOTS.includes(parent) ? (rootMap.get(parent) || []).map(root => root.id) : [native.get(parent)].filter(Boolean);
      for (const parentId of parents) {
        const children = await this.api.getChildren(parentId);
        const actualIds = new Set(children.map(child => child.id));
        const desired = ids.map(id => native.get(id)).filter(id => actualIds.has(id));
        const ours = new Set(desired);
        const originalSlots = children.map((child, index) => ours.has(child.id) ? index : -1).filter(index => index >= 0);
        for (const [index, childId] of desired.entries()) {
          const [item] = await this.api.get(childId);
          if (item.index !== originalSlots[index]) await this.api.move(childId, { parentId, index: originalSlots[index] });
        }
      }
    }
    return this.read(state.bindings);
  }
}

function unavailableNodes(state, target, availableRoots) {
  const unavailable = new Set(Object.entries(state.observed || {})
    .filter(([id, node]) => !ROOTS.includes(id) && !availableRoots.has(node.rootNativeId))
    .map(([id]) => id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [id, node] of Object.entries(target.nodes)) {
      if (!unavailable.has(id) && unavailable.has(node.parent)) { unavailable.add(id); expanded = true; }
    }
  }
  return unavailable;
}

function rootRole(node, index) {
  const types = { 'bookmarks-bar': 'root:toolbar', other: 'root:other', mobile: 'root:mobile' };
  if (node.folderType) return types[node.folderType] || null;
  if (node.id === '1') return 'root:toolbar';
  if (node.id === '2') return 'root:other';
  if (node.id === '3') return 'root:mobile';
  return ROOTS[index] || null;
}
