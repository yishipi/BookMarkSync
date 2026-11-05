import { BrowserBookmarks } from './lib/bookmarks.js';
import { SyncEngine } from './lib/engine.js';
import { database, DirectoryExchange } from './lib/storage.js';

const label = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
const engine = new SyncEngine({ store: database, bookmarks: new BrowserBookmarks(chrome.bookmarks),
  exchange: handle => new DirectoryExchange(handle), label });
let queue = Promise.resolve();
let debounce;
let importing = false;

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('BookMarkSync', error));
  return result;
}

async function showStatus(view) {
  const phase = view.status.phase;
  const text = phase === 'permission' ? '授权' : phase === 'error' ? '!' : phase === 'paused' ? 'Ⅱ' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: phase === 'error' ? '#b42318' : '#9a6700' });
  await chrome.action.setTitle({ title: `BookMarkSync · ${view.status.message}` });
  return view;
}

async function ensureAlarm() {
  const view = await engine.summary();
  const alarm = await chrome.alarms.get('periodic-sync');
  if (!view.config.enabled) {
    if (alarm) await chrome.alarms.clear('periodic-sync');
    return;
  }
  const periodInMinutes = view.config.intervalSeconds / 60;
  if (!alarm || alarm.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.create('periodic-sync', { periodInMinutes });
  }
}

async function synchronize(reason, force = false) {
  if (importing && !force) return engine.summary();
  const view = await engine.run({ reason, force });
  await ensureAlarm();
  return showStatus(view);
}

function changed() {
  // The alarm survives suspension; the short timer only improves foreground latency.
  void chrome.alarms.create('dirty-sync', { delayInMinutes: 0.5 });
  clearTimeout(debounce);
  debounce = setTimeout(() => { void enqueue(() => synchronize('书签变更')); }, 1200);
}

chrome.bookmarks.onCreated.addListener(changed);
chrome.bookmarks.onChanged.addListener(changed);
chrome.bookmarks.onMoved.addListener(changed);
chrome.bookmarks.onRemoved.addListener(changed);
chrome.bookmarks.onChildrenReordered.addListener(changed);
chrome.bookmarks.onImportBegan.addListener(() => { importing = true; });
chrome.bookmarks.onImportEnded.addListener(() => { importing = false; changed(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (['periodic-sync', 'dirty-sync'].includes(alarm.name)) void enqueue(() => synchronize('定时检查'));
});
chrome.runtime.onStartup.addListener(() => { void enqueue(() => synchronize('浏览器启动')); });
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
  void enqueue(async () => { await ensureAlarm(); return showStatus(await engine.summary()); });
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void enqueue(() => synchronize('切回浏览器'));
});

function isManager(url) { return /^(chrome|edge):\/\/(bookmarks|favorites)(\/|\?|$)/.test(url || ''); }
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (isManager(change.url || tab.url) && (change.url || change.status === 'complete')) {
    void enqueue(() => synchronize('打开收藏夹管理器'));
  }
});
chrome.tabs.onActivated.addListener(info => {
  void chrome.tabs.get(info.tabId).then(tab => {
    if (isManager(tab.url)) return enqueue(() => synchronize('切回收藏夹管理器'));
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const commands = {
    status: () => engine.summary(),
    configure: () => engine.configure(message.settings || {}),
    permissionRestored: () => engine.permissionRestored(),
    enable: () => engine.setEnabled(true),
    pause: () => engine.setEnabled(false),
    sync: () => synchronize('手动同步', true),
    restore: () => engine.restore(message.id, message.conflictKey),
    export: async () => ({ schema: 1, createdAt: Date.now(), tree: await chrome.bookmarks.getTree() }),
  };
  if (!Object.hasOwn(commands, message?.type)) return false;
  void enqueue(async () => {
    const result = await commands[message.type]();
    if (message.type !== 'export') { await ensureAlarm(); await showStatus(result); }
    return result;
  }).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
  return true;
});

void enqueue(async () => { await ensureAlarm(); return showStatus(await engine.summary()); });
