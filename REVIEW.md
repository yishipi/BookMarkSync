# 1.0.1 审查与修复记录

日期：2026-11-05。范围：完整扩展、开发脚本、测试、安装与验证说明。按照个人开发规则和 Open Code Review 委托流程，OCR 负责文件预览及规则解析，当前 Codex 模型逐文件审查及修复，没有调用第三方模型端点。

项目原来没有 Git 仓库，因此在 `work/review-1.0.1` 建立仅供审查的隔离副本，以空提交为基准，将全部文件作为新增文件预览；没有把既有代码冒充成此次新增代码，也没有修改项目的版本控制状态。

## 审查结论

完成实现检查、审查修复、回归和最终复核。本轮**没有发现未修复的问题**。49 项测试、静态检查及实际 Chrome / Edge 的完整同步、权限、目录、层级和后台恢复验证通过。此结论不等于保证不存在未知缺陷。

## 已修复的问题

| 级别 | 问题与影响 | 修复及验证 |
| --- | --- | --- |
| 高 | 选择新目录时过早替换当前句柄，校验失败可能使目录与工作区不一致 | 选择结果暂存，校验后将句柄与状态原子保存；真实浏览器验证失败时保留原连接 |
| 高 | 恢复目录授权可能强制应用尚未确认的首次同步或暂停端变化 | 恢复授权只进行相应预览；真实设置页验证未误启用，手动同步只执行一次 |
| 高 | 新建项后中断，之后的人工编辑或删除可能被回放覆盖 | 新建成功时保存观察检查点；编辑、删除两条回归路径均通过 |
| 高 | 只校验输入文件，合并结果超限可能在修改浏览器后才无法发布 | 应用前校验完整合并结果，失败不污染本地已保存状态；超限回归通过 |
| 中 | 工作区切换重置版本序号却复用参与者身份 | 新工作区采用新身份；回归验证原身份不复用 |
| 中 | 已完成回放但中断标记未清除，后续编辑可能误判 | 无需应用变更的成功同步同样清除标记；回归通过 |
| 中 | 删除过程中发生的文件夹重命名没有保留 | 删除前捕获晚到的字段变化，恢复记录保留新标题；回归通过 |
| 中 | 读取内容时权限错误被误报成 JSON 损坏 | 分离文件读取与解析，授权错误保持可恢复分类；真实撤权验证通过 |
| 中 | 工作区标识缺失时同步路径会创建新标识 | 日常同步仅检查已有标识，含副本的目录也不重建；真实文件丢失与恢复通过 |
| 中 | 未检查交换文件名与发布者身份是否相符 | 接收边界同时校验文件内容和名称；回归通过 |
| 中 | IndexedDB 批量写入同步抛错时，前面的请求可能继续提交 | 同步异常主动中止事务；真实 IndexedDB 回滚验证通过 |
| 中 | 账号根目录消失会改写整个逻辑收藏栏的顺序版本 | 同时保留不可用根目录的条目和顺序；回归通过 |
| 中 | 多份物理根目录无法交错显示时，每轮仍规划一次重排和备份 | 仅比较每份可用物理根目录内部的顺序；不可用子树延后处理，回归通过 |
| 低 | 取消选择被当作错误，暂停后按钮文字及错误反馈不清楚 | 取消时静默保留连接，补充目录与授权说明，修正恢复按钮、手动同步入口及错误颜色 |
| 低 | 清单申请了未使用的 `storage` 权限 | 移除该权限，静态检查限定为书签、定时任务、标签页三项，并复测实际浏览器 |

## 文件覆盖

OCR 最终预览的 **21 个可审查文件全部 reviewed，0 个 skipped，coverage_rate 为 100%**。以下按 `(path, status)` 记录；全部状态均为隔离副本内的 `added`。

| 文件 | 审查状态 |
| --- | --- |
| `.gitignore` | reviewed |
| `shared/.gitignore` | reviewed |
| `extension/background.js` | reviewed |
| `extension/lib/bookmarks.js` | reviewed |
| `extension/lib/capture.js` | reviewed |
| `extension/lib/engine.js` | reviewed |
| `extension/lib/model.js` | reviewed |
| `extension/lib/storage.js` | reviewed |
| `extension/manifest.json` | reviewed |
| `extension/options.css` | reviewed |
| `extension/options.html` | reviewed |
| `extension/options.js` | reviewed |
| `package.json` | reviewed |
| `scripts/cdp.js` | reviewed |
| `scripts/check.js` | reviewed |
| `scripts/folder-browser-test.js` | reviewed |
| `scripts/full-browser-test.js` | reviewed |
| `scripts/package.js` | reviewed |
| `scripts/permissions-browser-test.js` | reviewed |
| `scripts/recovery-browser-test.js` | reviewed |
| `tests/helpers.js` | reviewed |

OCR 默认排除了 3 个 `*.test.js`；已额外人工检查全部测试及其对应生产路径。Markdown 说明由工具按扩展名排除，已人工复核 README、VALIDATION 及本报告，确认安装步骤、授权提示、功能范围和测试边界与代码一致。

预览、规则及最终文件哈希记录位于 `work/review-preview.json`、`work/review-rules.json`、`work/review-final.json`。未把工作目录、测试配置或浏览器数据打包交付。
