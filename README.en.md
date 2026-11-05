# BookMarkSync

[简体中文](README.md) | **English** · [Download](https://github.com/yishipi/BookMarkSync/releases/latest)

Keep Chrome and Edge bookmarks in sync on the same computer. Install the extension in both browsers and choose the same local folder. Changes made in either browser are picked up by the other.

Bookmarks stay in local files. The extension needs no sync account or companion app and does not upload your data.

## Install

The extension currently has a Simplified Chinese interface. The button names below match what you will see.

1. Download `BookMarkSync-extension-<version>.zip` from [Releases](https://github.com/yishipi/BookMarkSync/releases/latest). Extract it to a permanent location and keep that folder.
2. Open `chrome://extensions/` in Chrome and `edge://extensions/` in Edge. Turn on **Developer mode**, click **Load unpacked**, and select the extracted folder that contains `manifest.json` in each browser.
3. Open BookMarkSync in each browser. Click **选择目录** (Choose folder), choose the same local folder for exchanging bookmarks, and allow read/write access. Choose **Allow on every visit** if the browser offers it.
4. Check the merge preview, then click **开始自动同步** (Start automatic sync) in both browsers.

If you install from source, load the repository's `extension` folder.

## Everyday use

- You can close the settings page. Bookmark changes trigger a sync, and the extension checks the other browser every 30 seconds by default. Browser scheduling or sleep can delay checks.
- The first merge keeps bookmarks from both browsers. After that, **deletions also sync to the other browser**.
- Check **恢复记录** (Recovery) for deleted items or conflicting edits. Before applying changes, the extension saves a backup and keeps the latest 10 per browser in the shared folder's `backups` directory.
- To update, replace the extension files in their existing folder, then click **Reload** on the browser's extensions page.

## Sync stopped after restarting the browser?

1. If you see **需要目录授权** (Folder access required), click **恢复目录授权** (Restore folder access). Choose **Allow on every visit** in the browser prompt if available.
2. If sync is still paused or waiting to start, click **恢复自动同步** (Resume automatic sync). Before the first successful sync, this button is called **开始自动同步** (Start automatic sync).
3. Check that the status says **自动同步中** (Automatic sync on) and that **最近同步** (Last sync) updates. If the saved folder connection was cleared, select the original shared folder again.

**立即同步** (Sync now) runs once; it does not turn on automatic sync. Each browser needs its own folder permission, and you must restore access manually if that permission expires.

## Things to know

- Only bookmarks are synced. Passwords, cookies, and website login sessions are not included.
- The browsers' built-in cloud sync can stay on. It will continue uploading and downloading bookmarks according to your browser settings.
- Opening a bookmarks menu or sidebar may not trigger an immediate check; background checks still run. Managed, read-only bookmarks are left alone.
- The installation prompt may mention access to browsing history. Tab access is used to recognize the bookmarks manager; the extension does not record browsing history or read webpage content.

## Development and feedback

Use Node.js 24 and run these commands from the project root:

```sh
npm test
npm run check
npm run package
```

[Report an issue](https://github.com/yishipi/BookMarkSync/issues) · [Release guide](docs/RELEASING.md) · [Validation notes](VALIDATION.md)

The linked guides are currently in Chinese.

## License

[MIT](LICENSE) © 2026 yishipi
