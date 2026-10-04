# -*- coding: utf-8 -*-
"""
PDF 文本提取脚本（供对话附件与标书条目提取使用）
独立脚本，不改动 build_review_html.py 的任何逻辑。
用法:
  python extract_text.py --pdf <in.pdf> --out <out.txt>           # 纯文本（会话附件用）
  python extract_text.py --pdf <in.pdf> --out <out.json> --json   # 分页 JSON（标书分块提取用）
输出:
  默认: 逐页 extract_text() 结果按页拼接的纯文本
  --json: {"pageCount": N, "pages": [{"pno": 1, "text": "..."}]}
"""
import argparse
import sys
import io
import json
import pdfplumber


def main():
    ap = argparse.ArgumentParser(description="提取 PDF 文本")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--json", action="store_true", help="输出分页 JSON 结构")
    args = ap.parse_args()

    # stdout 强制 UTF-8，避免 Windows 控制台 GBK 报错
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    pages_text = []
    with pdfplumber.open(args.pdf) as pdf:
        for page in pdf.pages:
            pages_text.append(page.extract_text() or "")

    if args.json:
        data = {
            "pageCount": len(pages_text),
            "pages": [{"pno": i + 1, "text": t} for i, t in enumerate(pages_text)],
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"提取完成：{len(pages_text)} 页 → {args.out}")
    else:
        text = "\n\n".join(pages_text)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"提取完成：{len(pages_text)} 页，{len(text)} 字符 → {args.out}")


if __name__ == "__main__":
    main()
