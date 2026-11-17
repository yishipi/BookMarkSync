# 1.0.2 审查与修复记录

日期：2026-11-17。本轮先审查 1.0.1 的全部 32 个受版本控制文件，再修复发现的两处同步竞争问题。历史修复记录可在 Git 历史中查看。

## 已修复

| 级别 | 问题 | 修复后的行为 |
| --- | --- | --- |
| P2 | 本轮同步已捕获书签，但在应用对端变化前，用户刚删除了该书签或文件夹；应用阶段可能将其重新创建 | 应用前重新识别刚消失的已知条目，延后处理相关子树，由最终捕获记录删除；对端新增子项仍会保留 |
| P2 | 应用对端变化期间，用户刚调整的书签顺序可能被旧顺序覆盖 | 重排前检查同一实际父目录内已有条目的相对顺序，保留本轮新发生的排序，随后捕获并同步到另一端 |

新增 7 项回归测试，覆盖书签删除、文件夹子树删除、父文件夹删除与对端新增子项、收藏栏和嵌套文件夹排序、账号收藏栏排序，以及两端同时排序。7 项测试在旧实现上均失败，修复后全部通过。测试调用生产同步引擎和书签适配层，仅替换浏览器 API 与文件交换边界。

扩展版本升至 **1.0.2**，扩展身份、交换协议和权限保持兼容，不需要重新建立共享目录。

## 文件覆盖与复核

使用 Open Code Review 委托流程：OCR 负责文件预览和规则解析，由当前 Codex 模型完成代码审查，没有调用第三方模型端点。

全量审查覆盖 32 个文件：OCR 可审查的 24 个文件，以及工具默认排除、另行人工检查的 5 份 Markdown 和 3 个测试文件。本次修复另复核以下 7 个变更文件：

| 文件 | 状态 | 复核 |
| --- | --- | --- |
| `extension/lib/bookmarks.js` | modified | reviewed |
| `extension/manifest.json` | modified | reviewed |
| `extension/options.html` | modified | reviewed |
| `package.json` | modified | reviewed |
| `tests/in-flight.test.js` | added，OCR 默认排除 | 人工 reviewed |
| `REVIEW.md` | modified，OCR 默认排除 | 人工 reviewed |
| `VALIDATION.md` | modified，OCR 默认排除 | 人工 reviewed |

本次 total_files 为 7，reviewed_files 为 7，skipped_files 为 0，coverage_rate 为 100%。复核未发现需要继续修复的问题。

56 项测试、静态检查及真实 Chrome / Edge 的四组浏览器验证通过，详情见 [验证记录](VALIDATION.md)。本地审查证据保存在 `work/full-review-20261117-*`、`work/fix-1.0.2-*`；工作目录和浏览器测试配置不会提交或打包。
