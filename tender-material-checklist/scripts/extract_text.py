# -*- coding: utf-8 -*-
"""
PDF 纯文本提取脚本（供对话附件入库使用）
独立脚本，不改动 build_review_html.py 的任何逻辑。
用法: python extract_text.py --pdf <in.pdf> --out <out.txt>
输出: 逐页 extract_text() 结果按页拼接，UTF-8 编码写入 out.txt
"""
import argparse
import sys
import io
import pdfplumber


def main():
    ap = argparse.ArgumentParser(description="提取 PDF 纯文本")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    # stdout 强制 UTF-8，避免 Windows 控制台 GBK 报错
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    pages_text = []
    with pdfplumber.open(args.pdf) as pdf:
        for page in pdf.pages:
            pages_text.append(page.extract_text() or "")

    text = "\n\n".join(pages_text)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text)

    print(f"提取完成：{len(pages_text)} 页，{len(text)} 字符 → {args.out}")


if __name__ == "__main__":
    main()
