# 按需使用技能

在 Git 项目中启动 `minipi`，直接说“写本周周报”。工具记录先显示 `read_file` 读取周报技能，再显示 `run_bash` 查询日期和提交。另开会话问“三加四等于几”，助手可直接回答。

## 周报从哪里取材

[内置周报技能](../skills/weekly-report/SKILL.md)取当前 `HEAD` 可达的提交，按提交者时间筛选，从本机时区的周一零点到请求时刻。周报标明实际日期，将有证据的内容归入进展、风险或待办。例如“已修复导出超时，回归待完成”可以分别写进进展和待办。用户当次的要求优先，其次采用[个人排序偏好](./memory.md)。

一次成功的空查询可以得出“当前分支本周没有提交”。在非仓库目录运行时，Git 返回的错误只能说明取材失败。

## 使用自己的技能

Mini-Pi 扫描安装目录的 `skills/<目录名>/SKILL.md` 和用户的 `~/.minipi/skills/<目录名>/SKILL.md`。这两个位置都跟随助手，各项目只提供任务材料。文件用 YAML 头部写名称和用途，正文写操作步骤。例如把下面的内容保存为 `~/.minipi/skills/release-notes/SKILL.md`。

```markdown
---
name: release-notes
description: 为当前项目整理版本发布说明。
---

读取项目里的变更记录，按用户能观察到的变化整理发布说明。
```

省略 `name` 时使用目录名。`description` 需要是非空文本，模型靠它选择技能。想调整周报时，可以把内置文件复制到 `~/.minipi/skills/weekly-report/SKILL.md` 后编辑。发现时，有效的同名个人版接替内置版，缺少用途的个人版会被跳过。模型已选定路径后，如果读取正文失败，会收到工具错误并说明路径与原因。[CowAgent 的同名覆盖规则](https://github.com/zhayujie/CowAgent/blob/bcc36de52ca17b45d1132f388a04b7a456bd3f95/agent/skills/loader.py#L313-L336)

新会话在启动时发现技能。已经打开的会话输入 `/reload` 后就能使用新增技能，也能继续之前的聊天。清单与正文的刷新时机见[手动刷新与提示缓存](./reload.md)。

阶段五[复盘](./self-evolution.md)可修订或创建个人技能，完成或撤销后自动刷新当前清单。复盘保护内置技能名称，不能修改上面示例的同名 `weekly-report` 覆盖；用于自进化实验的技能应另取名称，例如 `my-weekly-report`。普通手动编辑和同名覆盖规则不变。
