# -*- coding: utf-8 -*-
"""
高亮框几何验证：反向证明"高亮框覆盖的确实是条目原文"。

做法：对每条条目，按其高亮矩形逐一从 PDF 中 crop 出该区域，提取文字，
      再把所有裁剪文字与条目 anchor 做归一化比对，统计覆盖率。
覆盖率 100% = 框住的区域完整包含原文（高亮精准无误）。

用法：python verify_rects.py --pdf <招标文件.pdf> --items <items_带rects.json> [--report out.txt]

注意：--items 需为 HTML 生成脚本落盘的中间结果（含 page/rects 字段），
      可在生成 HTML 后用 --dump 参数取得，或直接读取生成报告同目录的 *_items.json。
"""
import argparse
import io
import json
import re
import sys

import pdfplumber

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass


def norm(s):
    return re.sub(r"\s+", "", s or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--report", default=None)
    ap.add_argument("--pad", type=float, default=1.5, help="裁剪框外扩像素，默认1.5")
    args = ap.parse_args()

    with open(args.items, "r", encoding="utf-8") as f:
        data = json.load(f)
    items = data["items"] if isinstance(data, dict) else data

    lines = []
    bad = []
    skip = []
    with pdfplumber.open(args.pdf) as pdf:
        for it in items:
            a = norm(it.get("anchor", ""))
            page = it.get("page")
            rects = it.get("rects") or []
            if not page or not rects:
                lines.append("[SKIP] #%-3s %s（无定位）" % (it["id"], it["name"]))
                skip.append(it["id"])
                continue
            p = pdf.pages[page - 1]
            W, H = float(p.width), float(p.height)
            texts = []
            oob = 0
            for (x0, top, x1, bottom) in rects:
                if x0 < -1 or top < -1 or x1 > W + 1 or bottom > H + 1:
                    oob += 1
                box = (max(0, x0 - args.pad), max(0, top - args.pad),
                       min(W, x1 + args.pad), min(H, bottom + args.pad))
                try:
                    texts.append(p.crop(box).extract_text() or "")
                except Exception as e:  # noqa
                    texts.append("")
            got = norm("".join(texts))
            # 覆盖率：anchor 中能在裁剪文字里找到的字符占比（按顺序贪心）
            ai = ci = 0
            while ai < len(a) and ci < len(got):
                if a[ai] == got[ci]:
                    ai += 1
                ci += 1
            cover = (ai / len(a) * 100.0) if a else 0.0
            ok = cover >= 99.9
            lines.append("[%s] #%-3s %-30s 框%-2d 覆盖%.1f%% 越界%d %s"
                         % ("PASS" if ok else "FAIL", it["id"], it["name"][:28],
                            len(rects), cover, oob,
                            "" if ok else "裁剪文字：" + got[:60]))
            if not ok:
                bad.append(it["id"])

    header = "高亮框几何验证：共 %d 条，PASS %d 条，SKIP %d 条（无定位），FAIL %d 条 %s" % (
        len(items), len(items) - len(bad) - len(skip), len(skip), len(bad), bad)
    out = header + "\n" + "-" * 70 + "\n" + "\n".join(lines)
    print(out)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(out)
        print("\n报告已保存：%s" % args.report)


if __name__ == "__main__":
    main()
