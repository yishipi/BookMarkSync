// A logical toolbar can contain several native folders. Only siblings in the
// same physical folder have an order the browser can observe and apply.
export function childrenInFolder(observed, parent, nativeId) {
  const folder = observed[parent];
  if (!folder) return [];
  if (!folder.nativeIds) return folder.children;
  return folder.children.filter(id => observed[id]?.rootNativeId === nativeId);
}

export function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// Insertions, deletions and cross-folder moves leave only the common siblings
// comparable. Use exact order instead when guarding a native index-based move.
export function sameRelativeOrder(left, right) {
  if (sameOrder(left, right)) return true;
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return sameOrder(left.filter(id => rightIds.has(id)), right.filter(id => leftIds.has(id)));
}

// Keep base slots for shared entries and insert new items before their next
// known neighbor. A reorder replaces only the slots it can observe.
export function mergeChildOrder(base, observed, reorder = false) {
  const baseIds = new Set(base);
  const before = new Map();
  const shared = [];
  let additions = [];
  for (const id of observed) {
    if (!baseIds.has(id)) {
      additions.push(id);
      continue;
    }
    shared.push(id);
    if (additions.length) before.set(id, additions);
    additions = [];
  }
  if (reorder) {
    const sharedIds = new Set(shared);
    let next = 0;
    base = base.map(id => sharedIds.has(id) ? shared[next++] : id);
  }
  if (!before.size && !additions.length) return base;
  return base.flatMap(id => before.has(id) ? before.get(id).concat(id) : [id]).concat(additions);
}
