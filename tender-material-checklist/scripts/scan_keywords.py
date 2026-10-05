# -*- coding: utf-8 -*-
"""
招标文件关键词扫描定位脚本
用法: python scan_keywords.py <招标文件.txt> [--context N] [--output result.txt]
输出: 命中行号 + 命中行内容（UTF-8 输出）
用途: 阶段 2 快速定位要求分布区域；阶段 4 反向查漏核对。
"""
import argparse
import sys
import io

# 扫描关键词分组（分组名会随命中一起输出，便于快速判断区域）
KEYWORD_GROUPS = {
    "A.资格要求": [
        "资格", "资质", "投标人须知", "供应商资格", "前附表",
    ],
    "B.评审办法": [
        "评标办法", "评审标准", "资格性审查", "符合性审查", "评分", "得分", "分值", "打分",
    ],
    "C.投标文件组成": [
        "投标文件组成", "投标文件格式", "应提交", "应当包括", "文件格式",
    ],
    "D.否决无效条款": [
        "无效", "否决", "废标", "拒绝", "不予受理", "不予以受理", "视为无效", "取消资格",
    ],
    "E.提供材料动词": [
        "提供", "出具", "提交", "附上", "递交", "须具备", "应具备", "持有", "加盖", "签字", "盖章",
    ],
    "F.常见材料名": [
        "营业执照", "证书", "许可证", "授权书", "声明函", "承诺书", "承诺函",
        "审计报告", "财务报告", "社保证明", "纳税", "信用", "业绩", "合同",
        "检测报告", "身份证明", "保证金", "彩页", "说明书", "职称", "认证",
    ],
    "G.强制与形式要求": [
        "必须", "须", "应当", "有效期", "近三年", "近三年内", "复印件", "原件",
        "正本", "副本", "电子版", "份数", "密封",
    ],
}

# 展开所有关键词（按长度倒序，命中时优先记录最具体的关键词）
ALL_KEYWORDS = sorted(
    ((kw, g) for g, kws in KEYWORD_GROUPS.items() for kw in kws),
    key=lambda x: -len(x[0]),
)


def read_text(path):
    """尝试多种编码读取文本文件。"""
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description="招标文件关键词扫描")
    parser.add_argument("input", help="招标文件文本（.txt）路径")
    parser.add_argument("--context", type=int, default=0, help="每个命中前后各显示 N 行（默认 0）")
    parser.add_argument("--output", help="结果另存为文件路径（可选）")
    args = parser.parse_args()

    text = read_text(args.input)
    lines = text.splitlines()

    # stdout 强制 UTF-8，避免 Windows 控制台 GBK 报错
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    hits = []  # (行号, 分组, 关键词)
    for i, line in enumerate(lines, start=1):
        matched = set()
        for kw, group in ALL_KEYWORDS:
            if kw in line:
                matched.add((group, kw))
        for group, kw in sorted(matched):
            hits.append((i, group, kw))

    total_pages_hint = len(lines)
    out_lines = []
    out_lines.append(f"文件: {args.input}")
    out_lines.append(f"总行数: {total_pages_hint}, 命中总数: {len(hits)}")
    out_lines.append("=" * 60)

    # 按行号去重汇总视图
    by_line = {}
    for lineno, group, kw in hits:
        by_line.setdefault(lineno, []).append((group, kw))

    if args.context > 0:
        out_lines.append("[逐条命中视图（含上下文）]")
        printed_ranges = set()
        for lineno in sorted(by_line):
            lo, hi = lineno - args.context, lineno + args.context
            if any(lo <= r <= hi for r in printed_ranges):
                continue
            printed_ranges.add((lo, hi))
            out_lines.append("-" * 40)
            for j in range(max(0, lo), min(len(lines), hi)):
                mark = ">>" if (j + 1) in by_line else "  "
                out_lines.append(f"{mark} L{j+1}: {lines[j].strip()}")
    else:
        out_lines.append("[命中行视图]")
        for lineno in sorted(by_line):
            groups = "; ".join(f"{g}({k})" for g, k in by_line[lineno])
            out_lines.append(f"L{lineno} [{groups}] {lines[lineno-1].strip()}")

    # 分组统计
    out_lines.append("=" * 60)
    out_lines.append("[分组统计]")
    group_count = {}
    for _, group, _ in hits:
        group_count[group] = group_count.get(group, 0) + 1
    for g in sorted(KEYWORD_GROUPS):
        out_lines.append(f"{g}: {group_count.get(g, 0)} 处")
    out_lines.append("")
    out_lines.append("提示: 本扫描仅用于定位与查漏，零命中区域仍需抽查确认（可能因提取失败漏检）。")

    result = "\n".join(out_lines)
    print(result)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result)
        print(f"\n结果已保存: {args.output}")


if __name__ == "__main__":
    main()
