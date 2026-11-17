---
name: weekly-report
description: 根据当前 Git 仓库的提交撰写、重写或整理本周项目周报。
---

# 写本周周报

1. 用 `run_bash` 在当前目录执行下面的命令。按本地日历回推到周一零点，把起止时刻交给 Git，读取当前 `HEAD` 可达且提交者时间在范围内的提交。

   ```sh
   set -e
   now=$(date '+%Y-%m-%dT%H:%M:%S%z')
   monday=$(node -e '
     const start = new Date(process.argv[1])
     const daysSinceMonday = (start.getDay() + 6) % 7
     start.setDate(start.getDate() - daysSinceMonday)
     start.setHours(0, 0, 0, 0)
     console.log(start.toISOString())
   ' "$now")
   printf '起点 %s，截止 %s\n' "$monday" "$now"
   git log --since-as-filter="$monday" --until="$now" --format='%h %s%n%b' HEAD --
   ```

2. 将统计日期按本机时区写在周报开头。查询成功但没有匹配记录时，只输出日期和“当前分支本周没有提交”，到此结束。仓库还没有首次提交时也适用。当前目录不在 Git 仓库内或查询出错时，说明取材失败及实际原因。
3. 只使用此次查询返回的提交，按“进展、风险、待办”归类。一次提交可以包含多类信息。例如，“修复导出超时，回归待完成”同时给出了进展和待办。保留能核对的短提交号，省略没有材料的类别。段落顺序优先遵守用户当次要求，其次采用已保存的个人偏好。仅凭提交无法确定上线状态时，保留材料本身的说法。
