# Git 管理与上传

## 两层仓库的决定

采用“父仓库忽略 B_S，B_S 独立管理”的方式。它比 submodule 更适合当前单人课程作业：独立克隆、提交、打包，不需要每次开发后再更新父仓库的子模块指针。

父仓库此前跟踪 B_S/Assignment.pdf，因此只添加忽略规则不足以隔离。已在父仓库加入 `/B_S/`，并通过 `git rm --cached -- B_S/Assignment.pdf` 取消其索引，磁盘原件保留。父仓库历史里的原版本仍在，未重写历史。这次变更单独提交为 `62970e0`，未推送父仓库。

依据：[Git 官方 gitignore 文档](https://git-scm.com/docs/gitignore)。

从父仓库克隆不会自动得到 B_S。新电脑需要另行克隆作业仓库；如果以后确实需要父仓库锁定作业版本，再考虑 submodule。不要在父仓库用 `git add -f B_S`，不要把内层 .git 当普通文件复制提交到父仓库。

## 每阶段的真实记录

1. 在 B_S 中确认 `git rev-parse --show-toplevel` 指向 B_S，而不是上层目录。
2. 从现有基线创建 `codex/sNN-description` 阶段分支。
3. 完成本阶段的小增量，执行对应检查，记录实际结果和未解决问题。
4. 精确暂存该阶段文件，检查 `git diff --cached`，提交 `feat:` / `fix:` / `test:` / `docs:` / `chore:`。
5. 有独立 origin 时推送阶段分支；验收后快进合并到 main，并推送 main。保留阶段提交，不 squash 成一个成品提交。

提交时间使用真实时间。用户原创 PDF 与 AI 协助的实现分别说明来源，不能把 AI 写的代码描述为人工独立实现。人工模块由用户自行编写并提交，提交前关闭该模块中的 AI 补全。

作业第 4 页要求“代码用 git 进行管理”“包含 git 相关信息（如 git log 日志）”，没有规定必须每次修改都 push。建议每个验收阶段 push 一次，较长阶段在有意义的里程碑追加提交和备份。

## 配置远程

等待用户提供独立 SSH/HTTPS URL；不得把父仓库 origin 复制过来。下列 REMOTE_URL 为占位符，先替换再执行。

```sh
git remote add origin REMOTE_URL
git remote -v
git push -u origin main
git push -u origin HEAD
```

如果远程非空，先 fetch 并比较历史，不直接 force push。私有仓库更方便控制作业材料访问范围。完成推送后记录远程分支和提交哈希；本地 commit 与已上传必须明确区分。

## 最终提交

在 S8 生成提交材料，而不是在每次提交中递归保存 git log：

```sh
mkdir -p output/submission
git log --all --date=iso-strict --pretty=fuller --stat > output/submission/git-log.txt
git bundle create output/submission/history.bundle --all
git bundle verify output/submission/history.bundle
```

源代码压缩包、设计文档、使用手册、测试报告、Docker 配置及演示视频一并整理。`git archive` 不包含 .git；仅交 ZIP 不能替代 Git 历史，需同时提供日志与 bundle，或按老师要求附带 .git。最终提交须排除依赖缓存、上传票据、凭据和运行数据。
