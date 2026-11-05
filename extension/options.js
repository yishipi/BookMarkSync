import { database } from './lib/storage.js';

const element = id => document.getElementById(id);
const browserLabel = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
let view;
let busy = false;
let initialized = false;

async function command(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || '扩展后台暂时无法连接，请稍后重试。');
  return response.result;
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
}

function row(title, description, action) {
  const outer = document.createElement('div');
  outer.className = 'row';
  const content = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const detail = document.createElement('small');
  detail.textContent = description;
  content.append(heading, detail);
  outer.append(content);
  if (action) {
    const button = document.createElement('button');
    button.textContent = '恢复';
    button.onclick = () => runAction(action);
    outer.append(button);
  }
  return outer;
}

function render(next) {
  view = next;
  const phase = view.status.phase;
  const labels = { setup: '开始设置', preview: '等待开始', ready: '自动同步中', paused: '已暂停', permission: '需要目录授权', error: '等待重试' };
  element('status-title').textContent = labels[phase] || '本地书签同步';
  element('status-message').textContent = view.status.message;
  element('status-dot').className = `dot ${phase}`;
  element('browser-label').textContent = view.config.label || browserLabel;
  element('bookmark-count').textContent = view.bookmarks.toLocaleString();
  element('folder-count').textContent = view.folders.toLocaleString();
  element('last-sync').textContent = view.status.lastSync ? new Date(view.status.lastSync).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未同步';
  element('directory-name').textContent = view.config.directoryName || '尚未连接目录';
  element('workspace-name').textContent = view.config.workspace ? `工作区 ${view.config.workspace.id.slice(0, 8)} · 两端须选择同一目录` : '首次连接后会显示合并预览，不会立即修改书签。';
  if (!initialized) {
    element('label').value = view.config.label || browserLabel;
    element('interval').value = String(view.config.intervalSeconds);
    initialized = true;
  }
  element('enable').hidden = !view.config.workspace || view.config.enabled || phase === 'permission';
  element('enable').textContent = view.status.lastSync ? '恢复自动同步' : '开始自动同步';
  element('sync').hidden = !view.config.workspace || (phase === 'preview' && !view.status.lastSync) || phase === 'permission';
  element('pause').hidden = !view.config.enabled;
  element('grant').hidden = phase !== 'permission';
  element('save').hidden = !view.config.workspace;
  element('choose').textContent = view.config.workspace ? '更换目录' : '选择目录';
  const plan = view.status.plan;
  element('plan').hidden = phase !== 'preview' || !plan;
  if (plan) element('plan').textContent = `本端预计：新增 ${plan.creates}，更新 ${plan.updates}，移动 ${plan.moves}，删除 ${plan.removes}。首次合并的匹配歧义会保留；完整备份在应用前保存。`;
  element('peers').replaceChildren();
  for (const peer of view.status.peers || []) element('peers').append(row(peer.label || '另一端', `最近发布 ${formatTime(peer.modified)}`));
  if (!view.status.peers?.length) element('peers').append(row('等待另一端', '请在另一个浏览器中安装扩展，连接同一目录并开始同步。'));
  element('recovery').replaceChildren();
  for (const conflict of view.conflicts.slice(0, 30)) {
    const fields = { title: '标题', url: '网址', parent: '位置', deleted: '删除状态' };
    element('recovery').append(row(`${conflict.title} · ${fields[conflict.field]}冲突`,
      `保留版本：${String(conflict.loser.value).slice(0, 220)} · ${formatTime(conflict.loser.stamp.time)}`,
      async () => render(await command('restore', { id: conflict.id, conflictKey: conflict.key }))));
  }
  for (const item of view.deleted.slice(0, 30)) {
    element('recovery').append(row(`${item.title || '未命名'} · 已删除${item.kind === 'folder' ? '文件夹' : '书签'}`,
      `${item.url || '恢复文件夹时会恢复同一次删除的子项'} · ${formatTime(item.at)}`,
      async () => render(await command('restore', { id: item.id }))));
  }
  if (!view.deleted.length && !view.conflicts.length) element('recovery').append(row('暂无恢复记录', '同时修改产生的冲突版本和已删除内容会显示在这里。'));
  element('diagnostics').textContent = `本端标识 ${view.actor} · 忽略只读项 ${view.status.ignored || 0} · 恢复记录 ${view.deletedCount} · 最近触发 ${view.status.reason || '尚无'}${view.status.repairs?.length ? ` · 已处理文件夹冲突 ${view.status.repairs.length}` : ''}`;
}

async function runAction(action) {
  if (busy) return;
  busy = true;
  element('notice').hidden = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await action(); }
  catch (error) {
    if (error.name !== 'AbortError') {
      element('notice').textContent = error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ? '尚未取得目录读写权限。请重新选择目录并允许访问，或点击“恢复目录授权”。'
        : error.message;
      element('notice').hidden = false;
    }
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function settings() {
  return { label: element('label').value.trim() || browserLabel, intervalSeconds: Number(element('interval').value) };
}

element('choose').onclick = () => runAction(async () => {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'bookmark-sync-shared-directory' });
  const directoryKey = `selection:${crypto.randomUUID()}`;
  await database.set(directoryKey, handle);
  try { render(await command('configure', { settings: { ...settings(), directoryKey } })); }
  finally { await database.remove(directoryKey); }
});
element('grant').onclick = () => runAction(async () => {
  const handle = await database.get('directory');
  if (!handle) throw new Error('目录记录不存在，请重新选择目录。');
  const permission = await handle.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error('尚未授予读写权限，自动同步会继续等待。');
  render(await command('permissionRestored'));
});
element('enable').onclick = () => runAction(async () => render(await command('enable')));
element('pause').onclick = () => runAction(async () => render(await command('pause')));
element('sync').onclick = () => runAction(async () => render(await command('sync')));
element('save').onclick = () => runAction(async () => {
  render(await command('configure', { settings: settings() }));
});
element('export').onclick = () => runAction(async () => {
  const backup = await command('export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `BookMarkSync-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

void runAction(async () => render(await command('status')));
setInterval(() => { if (!busy && !document.hidden) void command('status').then(render).catch(() => {}); }, 3000);
