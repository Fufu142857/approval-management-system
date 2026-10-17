# Git 管理与上传

## 两层仓库的决定

采用“父仓库只忽略工程子文件夹，工程独立管理”的方式。它比 submodule 更适合当前单人课程作业：独立克隆、提交、打包，不需要每次开发后再更新父仓库的子模块指针。

目录结构：

```text
ZJU_26_Aut-Win/                 # 父课程仓库
  B_S/
    Assignment.pdf             # 本地隐私原件，已忽略
    Design.pdf                 # 本地隐私原件，已忽略
    approval-management-system/ # 独立工程仓库
      .git/
      src/
      docs/
```

父仓库忽略 `/B_S/approval-management-system/`、`/B_S/Assignment.pdf` 和 `/B_S/Design.pdf`，两份原件不再被当前分支跟踪。按用户要求，父私有仓库旧历史保留且本轮未推送。工程仓库不含 PDF 副本，并在 .gitignore 中忽略这两个文件名。

公开工程仓库曾误包含两份 PDF，已按用户指示从全部分支历史中剔除；阶段提交保留，但提交哈希发生变化。不要从旧克隆合并旧历史；有旧克隆时重新克隆清理后的仓库。原始资料只在本地读取，不得重新加入任何提交。

依据：[Git 官方 gitignore 文档](https://git-scm.com/docs/gitignore)。

从父仓库克隆会保留其跟踪的课程资料，但不会自动得到工程子目录。新电脑在 B_S 中另行克隆作业仓库；如果以后确实需要父仓库锁定作业版本，再考虑 submodule。不要在父仓库强制添加被忽略的工程目录，不要把内层 .git 当普通文件复制提交到父仓库。

## 每阶段的真实记录

1. 进入 B_S/approval-management-system，确认 `git rev-parse --show-toplevel` 指向该工程子目录，而不是 B_S 或课程总目录。
2. 从现有基线创建 `stage/sNN-description` 阶段分支。按用户要求，分支名不包含 Codex、AI 或其他助手标识；AI 使用声明保留在开发记录中。
3. 完成本阶段的小增量，执行对应检查，记录实际结果和未解决问题。
4. 精确暂存该阶段文件，检查 `git diff --cached`，提交 `feat:` / `fix:` / `test:` / `docs:` / `chore:`。
5. 有独立 origin 时推送阶段分支；验收后快进合并到 main，并推送 main。保留阶段提交，不 squash 成一个成品提交。

提交时间使用真实时间。用户原创 PDF 与 AI 协助的实现分别说明来源，不能把 AI 写的代码描述为人工独立实现。人工模块由用户自行编写并提交，提交前关闭该模块中的 AI 补全。

## 开发节奏与作者署名

Git 历史用于展示实际迭代过程，不要求每天恰好一次提交。一次学习或开发时间可以完成一个小增量，也可以针对不同问题产生多次提交；没有开发成果的日子不必提交。不要倒填日期、空提交打卡，或先完成整套系统再拆出虚假的开发过程。

本项目检查点以 STATUS.md 为准；目前已逐步完成 S2a–S2d 和 S3a，后续继续拆分可验收增量。每次继续前先阅读上一增量的代码与验证记录；一次提交说明一个可以被核对的变化，每个通过验收的增量都创建语义明确的提交并上传远程备份。STATUS、开发日志和接口文档随对应代码一起提交，交付时能把 Git 记录与验收证据对应起来。

GitHub 的协作者权限与作者署名是不同机制。展示贡献不需要邀请额外账号或赋予写入权限。当前已实测 GitHub 将 `Codex <noreply@openai.com>` 关联到 `codex` 身份：用户为主作者的协作提交保留用户作者并添加 Codex 共同作者；由 Codex 主要撰写的独立增量使用 Codex 作者身份，用户仍是提交人。用户原创设计与人工模块不会被归为 AI 作者。

提交层面的共同作者显示和仓库侧栏的贡献者统计并不完全相同。后者由 GitHub 根据默认分支上的提交和关联账号统计，显示也可能有延迟；不能以邀请权限或 README 文字代替真实作者信息。

参考：[GitHub 多作者提交](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors)、[贡献者统计说明](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors)。

作业第 4 页要求“代码用 git 进行管理”“包含 git 相关信息（如 git log 日志）”，没有规定必须每次修改都 push。建议每个验收阶段 push 一次，较长阶段在有意义的里程碑追加提交和备份。

## 配置远程

用户已指定独立远程：[approval-management-system](https://github.com/Fufu142857/approval-management-system)。配置的 origin 为 `https://github.com/Fufu142857/approval-management-system.git`；初始化检查远程为空。不得把父仓库 origin 复制过来。

当前仓库已配置 origin；以下命令仅供在其他机器重新配置时参考，已有 origin 不重复 add。

```sh
git remote add origin https://github.com/Fufu142857/approval-management-system.git
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

公开仓库只整理可公开的代码和开发文档。设计文档等隐私材料由用户通过课程指定的非公开渠道另行提交，不得加入公开仓库或公开发布附件。`git archive` 不包含 .git；仅交 ZIP 不能替代 Git 历史，需同时提供日志与 bundle，或按老师要求附带 .git。最终提交须排除依赖缓存、上传票据、凭据和运行数据。
