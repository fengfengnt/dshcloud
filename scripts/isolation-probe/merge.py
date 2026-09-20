#!/usr/bin/env python3
"""把多台宿主各跑一次 isolation-probe.sh --save 出来的 TSV，合成一份左右对照的报告。

用法：
  merge.py a.tsv b.tsv [c.tsv ...] [--labels "mac (M1),linux (Debian 13)"] [--out 报告.md] [--intro 引言.md]

设计原则：这份文件只**搬运**探针实测的字段，不做任何判断。
两台一致还是不同，由结论字段本身决定，不由本脚本推测。
"""
import sys

GROUPS = ["隔离", "加固", "信息隐藏", "其他"]
# 表里的呈现顺序（按论文的三层排，不按编号大小）
ORDER = ["1", "2", "3", "3b", "9", "4", "4b", "5", "7", "6", "8"]


def parse(path):
    data = {"label": path, "env": [], "rows": {}, "skips": {}, "files": []}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if not parts or not parts[0]:
                continue
            kind = parts[0]
            if kind == "L" and len(parts) > 1:
                data["label"] = parts[1]
            elif kind == "E" and len(parts) > 2:
                data["env"].append((parts[1], parts[2]))
            elif kind == "R" and len(parts) > 7:
                data["rows"][parts[1]] = {
                    "group": parts[2], "what": parts[3], "cmd": parts[4],
                    "out": parts[5], "rule": parts[6], "verdict": parts[7],
                }
            elif kind == "S" and len(parts) > 4:
                data["skips"][parts[1]] = {
                    "group": parts[2], "item": parts[3], "reason": parts[4],
                }
            elif kind == "F" and len(parts) > 5:
                data["files"].append({
                    "group": parts[1], "name": parts[2], "before": parts[3],
                    "after": parts[4], "verdict": parts[5],
                })
    return data


def cell(text):
    return (text or "").replace("|", "\\|") or "—"


def env_table(hosts):
    keys, seen = [], set()
    for host in hosts:
        for key, _ in host["env"]:
            if key not in seen:
                seen.add(key)
                keys.append(key)
    lines = ["| 项 | " + " | ".join(h["label"] for h in hosts) + " |",
             "|---" * (len(hosts) + 1) + "|"]
    for key in keys:
        values = []
        for host in hosts:
            found = [v for k, v in host["env"] if k == key]
            values.append(cell(found[0] if found else ""))
        lines.append("| %s | %s |" % (key, " | ".join(values)))
    return lines


def verdict_of(host, row_id):
    row = host["rows"].get(row_id)
    if row:
        return row["verdict"]
    if row_id in host["skips"]:
        return "未测"
    return "未测"


def note_for(hosts, row_id):
    verdicts = [verdict_of(host, row_id) for host in hosts]
    if len(set(verdicts)) == 1:
        return "两台一致" if verdicts[0] != "未测" else "两台都没测"
    if "未测" in verdicts:
        return "只有部分宿主测到"
    return "两台结论不同"


def host_cell(host, row_id):
    row = host["rows"].get(row_id)
    if row:
        return "%s<br><sub>%s</sub>" % (cell(row["verdict"]), cell(row["out"]))
    skip = host["skips"].get(row_id)
    if skip:
        return "未测<br><sub>%s</sub>" % cell(skip["reason"])
    return "—"


def row_ids_in_group(hosts, group):
    ids = []
    for host in hosts:
        for row_id, row in host["rows"].items():
            if row["group"] == group and row_id not in ids:
                ids.append(row_id)
        # 只有真正对应一行结果的跳过项才进结果表；slug（如 appchain）只进未测表
        for row_id, skip in host["skips"].items():
            if skip["group"] == group and row_id in ORDER and row_id not in ids:
                ids.append(row_id)
    return sorted(ids, key=lambda i: (ORDER.index(i) if i in ORDER else 99, i))


def main():
    files, labels, out, intro = [], None, None, None
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] == "--labels":
            labels = argv[i + 1].split(",")
            i += 2
        elif argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        elif argv[i] == "--intro":
            intro = argv[i + 1]
            i += 2
        else:
            files.append(argv[i])
            i += 1
    if len(files) < 2:
        sys.stderr.write("至少要两个 TSV：merge.py a.tsv b.tsv\n")
        return 2

    hosts = [parse(path) for path in files]
    if labels:
        for host, label in zip(hosts, labels):
            host["label"] = label
    for host, path in zip(hosts, files):
        if not host["rows"]:
            sys.stderr.write("%s 里没有结果行，检查是不是只跑了 --merge\n" % path)
            return 2

    doc = []
    doc.append("# 容器隔离实测报告：%s" % " vs ".join(h["label"] for h in hosts))
    doc.append("")
    if intro:
        with open(intro, encoding="utf-8") as handle:
            doc.append(handle.read().rstrip())
        doc.append("")
    doc.append("> 配套 [CONTAINER-ISOLATION-TEST-PLAN](CONTAINER-ISOLATION-TEST-PLAN.md) 与 "
               "[CONTAINER-ISOLATION-PAPER](CONTAINER-ISOLATION-PAPER.md)。"
               "表里的每个字都来自探针的原始输出；**未测不等于通过**。")
    doc.append("")

    doc.append("## 一 实验环境")
    doc.append("")
    doc += env_table(hosts)

    doc.append("")
    doc.append("## 二 实测结果")
    for group in GROUPS:
        ids = row_ids_in_group(hosts, group)
        if not ids:
            continue
        doc.append("")
        doc.append("### %s" % group)
        doc.append("")
        header = ["#", "测什么"] + [h["label"] for h in hosts] + ["判据", "两台对照"]
        doc.append("| " + " | ".join(header) + " |")
        doc.append("|" + "---|" * len(header))
        for row_id in ids:
            what, rule = "", ""
            for host in hosts:
                if row_id in host["rows"]:
                    what = what or host["rows"][row_id]["what"]
                    rule = rule or host["rows"][row_id]["rule"]
                elif row_id in host["skips"]:
                    what = what or host["skips"][row_id]["item"]
            cells = [row_id, what] + [host_cell(h, row_id) for h in hosts]
            cells += [cell(rule), note_for(hosts, row_id)]
            doc.append("| " + " | ".join(cells) + " |")

    doc.append("")
    doc.append("## 三 lxcfs 八文件对照（同一容器，挂载前后）")
    for host in hosts:
        doc.append("")
        doc.append("**%s**" % host["label"])
        doc.append("")
        if not host["files"]:
            reason = host["skips"].get("lxcfs", {}).get("reason", "本机没有可挂载的 lxcfs")
            doc.append("未测 —— %s。" % reason)
            continue
        doc.append("| 文件 | 未挂载（宿主值） | 挂载后 | 结论 |")
        doc.append("|---|---|---|---|")
        for item in host["files"]:
            doc.append("| %s | `%s` | `%s` | **%s** |" % (
                cell(item["name"]), cell(item["before"]), cell(item["after"]), item["verdict"]))
        live = [i for i in host["files"] if i["verdict"] == "生效"]
        doc.append("")
        doc.append("%d 项里有 %d 项真正改变了取值。" % (len(host["files"]), len(live)))

    doc.append("")
    doc.append("## 四 未测项")
    doc.append("")
    doc.append("| 项 | 分组 | " + " | ".join(h["label"] for h in hosts) + " |")
    doc.append("|" + "---|" * (len(hosts) + 2))
    seen = []
    for host in hosts:
        for row_id, skip in host["skips"].items():
            if row_id not in seen:
                seen.append(row_id)
    for row_id in seen:
        item, group, cells = "", "其他", []
        for host in hosts:
            skip = host["skips"].get(row_id)
            if skip:
                item = item or skip["item"]
                group = skip["group"]
                cells.append(cell(skip["reason"]))
            else:
                cells.append("已测")
        doc.append("| %s | %s | %s |" % (cell(item), group, " | ".join(cells)))

    doc.append("")
    doc.append("## 五 每项怎么测的")
    doc.append("")
    doc.append("| # | 命令 |")
    doc.append("|---|---|")
    for group in GROUPS:
        for row_id in row_ids_in_group(hosts, group):
            cmd = ""
            for host in hosts:
                if row_id in host["rows"]:
                    cmd = cmd or host["rows"][row_id]["cmd"]
            if cmd:
                doc.append("| %s | `%s` |" % (row_id, cell(cmd)))
    doc.append("")

    doc.append("## 六 怎么用这份报告")
    doc.append("")
    doc.append("- **标「两台一致」的行** —— 它是这两类宿主共有的性质，可以直接进设计假设。")
    doc.append("- **标「两台结论不同」的行** —— 必须按宿主分别判断。用一台的结论去套另一台会错，"
               "这正是论文 §4 第三条纪律（换宿主或换运行时，既有结论一律重测）实际起作用的地方。")
    doc.append("- **标「未测」的行** —— 不代表通过，只代表这台机器上测不了。"
               "要么换一台能测的宿主补上，要么按真实流程单独验一轮。")
    doc.append("- **每个数字都能重跑。** 每项的命令在 §五；探针同时会落一份完整原始输出（raw.log），"
               "报告里的话一律只写命令与原始输出支持的部分。")
    doc.append("")

    text = "\n".join(doc) + "\n"
    if out:
        with open(out, "w", encoding="utf-8") as handle:
            handle.write(text)
        sys.stderr.write("报告：%s\n" % out)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
