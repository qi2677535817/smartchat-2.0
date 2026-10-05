# -*- coding: utf-8 -*-
"""
招标文件材料清单 · 双栏复核工具生成器

输入：招标文件 PDF + 条目 JSON（含 anchor 锚点）
输出：单文件离线 HTML（内嵌 PDF、pdf.js、条目数据与坐标），左栏 PDF 右栏清单，
      点击条目跳页并精确高亮；支持复核状态机与 Word/JSON 导出。

用法：
  python build_review_html.py --pdf <招标文件.pdf> --items <items.json> --out <out.html>
                              [--vendor <pdf.js目录>] [--title <标题>]

依赖：pdfplumber
"""
import argparse
import base64
import io
import json
import os
import re
import sys

import pdfplumber

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

MANDATORY_KW = [
    "提供", "出具", "提交", "递交", "须", "应", "加盖", "盖章", "证明",
    "声明", "承诺函", "承诺书", "证书", "扫描件", "保证金", "发票", "授权",
]


def norm(s):
    return re.sub(r"\s+", "", s or "")


def build_pages(pdf):
    """逐页取词、拼接归一化文本、建立 字符→词 索引。"""
    pages = []
    for pno, page in enumerate(pdf.pages, 1):
        words = page.extract_words(keep_blank_chars=False)
        words = sorted(words, key=lambda w: (round(w["top"], 1), w["x0"]))
        text_parts = []
        widx = []
        chars = []
        for i, w in enumerate(words):
            t = norm(w["text"])
            if not t:
                continue
            text_parts.append(t)
            widx.extend([i] * len(t))
            chars.extend((ch, i) for ch in t)
        pages.append({
            "pno": pno,
            "w": float(page.width),
            "h": float(page.height),
            "words": words,
            "text": "".join(text_parts),
            "widx": widx,
            "chars": chars,
            "raw": page.extract_text() or "",
        })
    return pages


def _greedy_match(chars, a, budget):
    """字符级容错匹配：允许跳过干扰字符（表格跨列污染导致的插入文本）。

    返回 (匹配到的字符下标列表, 跳过数)；无法完整匹配时返回 None。
    """
    ai = ci = 0
    used = []
    skipped = 0
    n, m = len(chars), len(a)
    while ai < m and ci < n:
        if chars[ci][0] == a[ai]:
            used.append(ci)
            ai += 1
            ci += 1
        else:
            skipped += 1
            if skipped > budget:
                return None
            ci += 1
    if ai < m:
        return None
    return used, skipped


def locate(pages, anchor, page_hint=None):
    """定位锚点，返回 [{page, word_idx, skips, exact, span}]，按 page_hint 优先排序。"""
    a = norm(anchor)
    if not a:
        return []
    order = pages
    if page_hint:
        order = sorted(pages, key=lambda p: 0 if p["pno"] == page_hint else 1)
    budget = int(len(a) * 0.6) + 4
    results = []
    for p in order:
        if a in p["text"]:
            i = p["text"].find(a)
            widx = sorted(set(p["widx"][i:i + len(a)]))
            results.append({"page": p, "word_idx": widx, "skips": 0,
                            "exact": True, "hits": p["text"].count(a)})
            continue
        for start in range(len(p["chars"])):
            if p["chars"][start][0] != a[0]:
                continue
            seg = p["chars"][start:start + len(a) * 6 + 20]
            r = _greedy_match(seg, a, budget)
            if r is None:
                continue
            used, skipped = r
            widx = sorted(set(p["chars"][start + c][1] for c in used))
            span = widx[-1] - widx[0] + 1
            if span > len(widx) * 5 + 15:
                continue
            results.append({"page": p, "word_idx": widx, "skips": skipped,
                            "exact": False, "hits": 1})
            break
    return results


def to_rects(page, word_idx):
    """词下标集合 → 按行分组的矩形框（PDF 坐标系，原点左上）。"""
    lines = {}
    for i in word_idx:
        w = page["words"][i]
        key = round(w["top"], 1)
        e = lines.get(key)
        if e is None:
            e = {"x0": 1e9, "top": 1e9, "x1": -1e9, "bottom": -1e9}
            lines[key] = e
        e["x0"] = min(e["x0"], w["x0"])
        e["x1"] = max(e["x1"], w["x1"])
        e["top"] = min(e["top"], w["top"])
        e["bottom"] = max(e["bottom"], w["bottom"])
    out = []
    for e in sorted(lines.values(), key=lambda e: e["top"]):
        out.append([round(e["x0"], 1), round(e["top"], 1),
                    round(e["x1"], 1), round(e["bottom"], 1)])
    return out


def detect_offset(pages):
    """页脚/页眉数字投票，推算 offset = 物理页 - 文档标注页。"""
    votes = {}
    for p in pages:
        for w in p["words"]:
            t = (w["text"] or "").strip()
            if not t.isdigit():
                continue
            if not (w["top"] < 72 or w["bottom"] > p["h"] - 72):
                continue
            v = int(t)
            if 0 < v < 2000:
                d = p["pno"] - v
                votes[d] = votes.get(d, 0) + 1
                break
    if not votes:
        return None, 0
    best = max(votes.items(), key=lambda kv: kv[1])
    return best[0], best[1]


COVER_VERB = ["提供", "出具", "提交", "递交", "加盖", "盖章", "附"]
COVER_NOUN = ["声明函", "承诺函", "承诺书", "证明", "证书", "证件", "报告",
              "凭证", "发票", "扫描件", "复印件", "原件", "营业执照",
              "身份证明", "授权书", "技术资料", "彩页", "说明书", "协议"]
COVER_NOISE = ["http", "www", "电话", "客服", "邮箱", "咨询", "......", "……",
               "目  录", "联系电话", "邮编"]


def coverage_check(pages, items):
    """覆盖度校验：找出同时含"提供类动词＋材料名词"但未被任何条目覆盖的语句（防漏）。"""
    anchors = [norm(i.get("anchor", "")) for i in items]
    quotes = [norm(i.get("quote", "")) for i in items]
    out = []
    seen = set()
    for p in pages:
        joined = norm(p["raw"])
        for sent in re.split(r"[。；！？]", joined):
            s = sent.strip()
            if len(s) < 12 or len(s) > 260 or s in seen:
                continue
            if any(n in s for n in COVER_NOISE):
                continue
            if not (any(v in s for v in COVER_VERB) and any(n in s for n in COVER_NOUN)):
                continue
            covered = any(a and a in s for a in anchors) or \
                      any(len(s) >= 8 and s in q for q in quotes)
            if covered:
                continue
            seen.add(s)
            out.append({"page": p["pno"], "text": s})
    out.sort(key=lambda d: d["page"])
    return out


CSS = """
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#F5F1E8;color:#2E2A24;font-family:"Microsoft YaHei","PingFang SC",-apple-system,sans-serif;font-size:13.5px}
.top{display:flex;align-items:center;gap:16px;padding:10px 16px;background:#FFFDF8;border-bottom:1px solid #D8CFBC;flex-wrap:wrap}
.top h1{margin:0;font-size:15.5px;font-weight:600;color:#2E2A24}
.top .meta{color:#5B554A;font-size:12px;line-height:1.7}
.tprog{display:flex;align-items:center;gap:8px;margin-left:auto}
.bar{width:170px;height:8px;background:#E3DCCB;border-radius:6px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:#7A4C31;transition:width .2s}
button{font-family:inherit;font-size:12px;padding:5px 11px;border:1px solid #C9BFA9;background:#FFFDF8;color:#2E2A24;border-radius:8px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
button:hover{background:#F1EADC;border-color:#A99C82}
button:focus-visible{outline:2px solid #7A4C31;outline-offset:1px}
button.primary{background:#7A4C31;border-color:#7A4C31;color:#FFF9F3}
button.primary:hover{background:#653D26}
button.sm{padding:3px 8px;font-size:12px}
button.on-status{border-color:#7A4C31;background:#EADCCE;font-weight:600}
.app{display:flex;height:calc(100vh - 56px);min-height:420px}
.left{flex:1;display:flex;flex-direction:column;min-width:360px}
.splitter{width:6px;cursor:col-resize;background:#E8E1D1;border-left:1px solid #D8CFBC;border-right:1px solid #D8CFBC}
.ltb{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #D8CFBC;background:#FFFDF8;flex-wrap:wrap}
.ltb input[type=number]{width:64px;padding:4px 6px;border:1px solid #C9BFA9;border-radius:6px;font-family:inherit;font-size:12px;color:#2E2A24}
.pgbadge{background:#EDE6D6;color:#4F4A40;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:500}
.viewer{flex:1;overflow:auto;padding:16px;background:#EFE9DC}
.pagewrap{position:relative;margin:0 auto;width:max-content;background:#fff;box-shadow:0 0 0 1px #D8CFBC}
#cv{display:block}
.hl{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}
.hl i{position:absolute;background:rgba(206,152,50,.38);outline:1px solid rgba(160,104,16,.85);border-radius:2px}
.hl i.active{background:rgba(166,71,60,.34);outline:2px solid #A6473C}
.pulse{animation:pl 1.1s ease-out 2}
@keyframes pl{0%{background:rgba(166,71,60,.60)}100%{background:rgba(166,71,60,.34)}}
.right{width:482px;flex:0 0 482px;display:flex;flex-direction:column;background:#F6F2E9;border-left:1px solid #D8CFBC}
.rtabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid #D8CFBC;flex-wrap:wrap}
.tab{background:#FFFDF8}
.tab.active{background:#E8DACA;border-color:#7A4C31;font-weight:600}
.rbody{flex:1;overflow:auto;padding:10px 12px}
.listbar{display:flex;align-items:center;gap:6px;margin-bottom:9px;padding-bottom:8px;border-bottom:1px dashed #CBBFA6;flex-wrap:wrap}
.sortbtn.active{background:#E8DACA;border-color:#7A4C31;font-weight:600}
.cat{margin:14px 0 6px;font-size:12px;color:#7A4C31;font-weight:600;border-bottom:1px dashed #CBBFA6;padding-bottom:4px}
.card{border:1px solid #D8CFBC;border-radius:10px;padding:9px 10px;margin-bottom:8px;background:#FFFFFF;transition:border-color .15s,background .15s}
.card:hover{border-color:#B7A98C}
.card.st-采纳{border-color:#8FAF6B;background:#E7F0D6}
.card.st-剔除{opacity:.68;border-style:dashed;background:#F1EDE3}
.card.st-存疑{border-color:#D9A23F;background:#FBF0D8}
.ch{display:flex;align-items:flex-start;gap:6px}
.ch .no{color:#7A7365;font-size:12px;font-weight:600;min-width:22px}
.ch .nm{font-weight:600;flex:1;line-height:1.5;color:#2E2A24}
.bdg{font-size:11px;padding:1px 7px;border-radius:20px;white-space:nowrap;border:1px solid transparent;font-weight:600}
.b-强制{background:#F6E0DC;color:#8F3529;border-color:#DCA99F}
.b-评分{background:#F8E9CE;color:#7A5410;border-color:#DDBE86}
.b-条件项{background:#DFE9F1;color:#33546F;border-color:#B0C6D6}
.b-编制项{background:#EADCCE;color:#7A4C31;border-color:#D2BBA4}
.b-可选{background:#EBE6DA;color:#5D5648;border-color:#CFC7B4}
.b-形式{background:#DFE9F1;color:#33546F;border-color:#B0C6D6}
.q{margin:6px 0 6px;color:#33302B;line-height:1.72;background:#F6F1E5;border-left:3px solid #C9B89A;padding:6px 9px;border-radius:0 6px 6px 0}
.mt{color:#5B554A;font-size:12px;line-height:1.7}
.acts{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap;align-items:center}
.acts select{font-family:inherit;font-size:12px;padding:3px 6px;border:1px solid #C9BFA9;border-radius:6px;background:#FFFDF8;color:#2E2A24}
.edit input,.edit textarea,.edit select{width:100%;font-family:inherit;font-size:12px;padding:5px 7px;margin-bottom:5px;border:1px solid #C9BFA9;border-radius:6px;background:#fff;color:#2E2A24}
.edit textarea{min-height:56px;resize:vertical}
.un{border:1px solid #D8CFBC;border-radius:8px;padding:8px 10px;margin-bottom:7px;background:#FFFFFF;cursor:pointer;transition:border-color .15s,background .15s}
.un:hover{border-color:#B7A98C;background:#FFFCF2}
.un.ig{background:#F1EDE3;border-style:dashed}
.un .pg{color:#7A4C31;font-size:12px;font-weight:600}
.un .ucact{float:right;font-weight:400}
.un .tx{color:#33302B;line-height:1.68;margin-top:4px}
.ucbar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.ucbar input{flex:1;padding:5px 8px;border:1px solid #C9BFA9;border-radius:6px;font-family:inherit;font-size:12px;color:#2E2A24}
.hint{color:#6B6459;font-size:12px}
.warn{background:#FBF0D8;border:1px solid #DDBE86;color:#6B4A0E;padding:7px 10px;border-radius:8px;margin-bottom:8px;line-height:1.65}
.fld{margin-bottom:7px}
.fld label{display:block;color:#5B554A;font-size:12px;margin-bottom:3px}
"""

JS = r"""
const ITEMS = window.__ITEMS__;
const PAGEOFFSET = window.__OFFSET__;
const UNCOVERED = window.__UNCOVERED__;
let pdfDoc=null,pageNum=1,scale=1.2,curItem=null;
const UC_DONE={};let ucFilter='';
const cv=document.getElementById('cv'),ctx=cv.getContext('2d'),
      hl=document.getElementById('hl'),viewer=document.getElementById('viewer'),
      pagewrap=document.getElementById('pagewrap');

function b64ToBytes(b64){
  const bin=atob(b64),len=bin.length,bytes=new Uint8Array(len);
  for(let i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);
  return bytes;
}
async function init(){
  const workerSrc=document.getElementById('pdfWorkerSource').textContent;
  pdfjsLib.GlobalWorkerOptions.workerSrc=URL.createObjectURL(new Blob([workerSrc],{type:'application/javascript'}));
  const b64=document.getElementById('pdfb64').textContent.trim();
  pdfDoc=await pdfjsLib.getDocument({data:b64ToBytes(b64)}).promise;
  document.getElementById('ptotal').textContent=' / '+pdfDoc.numPages;
  renderList();renderUncovered();updateProgress();await renderPage(1);
}
function printedOf(p){ return (PAGEOFFSET!==null)?(p-PAGEOFFSET):null; }
function pgLabel(p){ const q=printedOf(p); return 'PDF 第 '+p+' 页'+(q?' ／ 标注第 '+q+' 页':''); }
async function renderPage(n){
  if(n<1||n>pdfDoc.numPages)return;
  pageNum=n;
  const page=await pdfDoc.getPage(n),vp=page.getViewport({scale});
  cv.width=Math.floor(vp.width);cv.height=Math.floor(vp.height);
  cv.style.width=Math.floor(vp.width)+'px';cv.style.height=Math.floor(vp.height)+'px';
  pagewrap.style.width=Math.floor(vp.width)+'px';pagewrap.style.height=Math.floor(vp.height)+'px';
  await page.render({canvasContext:ctx,viewport:vp}).promise;
  document.getElementById('pnum').value=n;
  document.getElementById('pgbadge').textContent=pgLabel(n);
  drawHighlight();
}
function drawHighlight(){
  hl.innerHTML='';
  if(!curItem||!curItem.rects||curItem.page!==pageNum)return;
  curItem.rects.forEach(function(r,i){
    const d=document.createElement('i');
    d.style.left=(r[0]*scale)+'px';d.style.top=(r[1]*scale)+'px';
    d.style.width=((r[2]-r[0])*scale)+'px';d.style.height=((r[3]-r[1])*scale)+'px';
    if(i===0)d.className='active pulse';
    hl.appendChild(d);
  });
}
function focusItem(id){
  const it=ITEMS.find(function(x){return x.id===id});
  if(!it)return;
  curItem=it;
  if(!it.page){alert('条目 #'+id+' 未定位到原文（生成期未匹配），请人工翻页核对。');return;}
  if(it.page!==pageNum){renderPage(it.page).then(function(){
     const t=(it.rects&&it.rects[0])?it.rects[0][1]*scale:0;
     viewer.scrollTop=Math.max(0,t-110);
  });}else{drawHighlight();
     const t=(it.rects&&it.rects[0])?it.rects[0][1]*scale:0;
     viewer.scrollTop=Math.max(0,t-110);}
}
let sortMode='page';
function renderList(){
  const box=document.getElementById('list');box.innerHTML='';
  const arr=ITEMS.slice();
  if(sortMode==='cat'){
    const cats=[];arr.forEach(function(it){if(cats.indexOf(it.cat)<0)cats.push(it.cat)});
    cats.sort().forEach(function(cat){
      const h=document.createElement('div');h.className='cat';h.textContent=cat;box.appendChild(h);
      arr.filter(function(i){return i.cat===cat}).sort(byPage).forEach(function(it){box.appendChild(card(it))});
    });
  }else{
    arr.sort(byPage).forEach(function(it){box.appendChild(card(it))});
  }
  const c=document.getElementById('listcount');if(c)c.textContent=arr.length+' 条';
}
function byPage(a,b){return (a.page||9999)-(b.page||9999)||a.id-b.id;}
function setSort(m){
  sortMode=m;
  document.querySelectorAll('.sortbtn').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-s')===m);
  });
  renderList();
}
function bdgClass(lv){
  if(lv.indexOf('强制')>=0)return 'b-强制';
  if(lv.indexOf('评分')>=0)return 'b-评分';
  if(lv.indexOf('条件')>=0)return 'b-条件项';
  if(lv.indexOf('编制')>=0)return 'b-编制项';
  if(lv.indexOf('形式')>=0)return 'b-形式';
  return 'b-可选';
}
function card(it){
  const d=document.createElement('div');
  d.className='card st-'+it.status;d.id='card-'+it.id;
  d.innerHTML=
   '<div class="ch"><span class="no">#'+it.id+'</span><span class="nm">'+esc(it.name)+'</span>'+
   '<span class="bdg '+bdgClass(it.level)+'">'+esc(it.level)+'</span></div>'+
   '<div class="q">'+esc(it.quote)+'</div>'+
   '<div class="mt">'+(sortMode==='page'?('分类：'+esc(it.cat)+'<br>'):'')+'出处：'+esc(it.origin)+'<br>'+
     (it.page?('定位：'+pgLabel(it.page)+'（'+it.rects.length+' 个高亮框）'):'<span style="color:#A6473C">未定位到原文，需人工核对</span>')+
     (it.form?('<br>形式：'+esc(it.form)):'')+
     (it.note?('<br>备注：'+esc(it.note)):'')+'</div>'+
   '<div class="acts">'+
     '<button class="sm'+(it.status==='采纳'?' on-status':'')+'" data-a="采纳">采纳</button>'+
     '<button class="sm'+(it.status==='剔除'?' on-status':'')+'" data-a="剔除">剔除</button>'+
     '<button class="sm'+(it.status==='存疑'?' on-status':'')+'" data-a="存疑">存疑</button>'+
     '<button class="sm" data-a="定位">定位原文</button>'+
     '<button class="sm" data-a="编辑">编辑</button>'+
     '<select data-a="self" title="我方是否具备">'+
       ['','已有','需办理','待确认'].map(function(v){
          return '<option value="'+v+'"'+(it.self===v?' selected':'')+'>'+(v===''?'我方是否具备':'我方：'+v)+'</option>';
       }).join('')+
     '</select>'+
   '</div>';
  d.addEventListener('click',async function(e){
    const a=e.target.getAttribute&&e.target.getAttribute('data-a');
    if(!a)return;
    if(a==='定位'){focusItem(it.id);return;}
    if(a==='编辑'){openEdit(it,d);return;}
    if(a==='self'){it.self=e.target.value;updateProgress();return;}
    it.status=(it.status===a)?'待确认':a;
    updateProgress();renderList();
  });
  return d;
}
function openEdit(it,d){
  d.innerHTML='<div class="edit">'+
   '<div class="fld"><label>材料名称</label><input id="e-name"></div>'+
   '<div class="fld"><label>原文摘录</label><textarea id="e-quote"></textarea></div>'+
   '<div class="fld"><label>出处</label><input id="e-origin"></div>'+
   '<div class="fld"><label>强制级别</label><input id="e-level"></div>'+
   '<div class="fld"><label>份数/形式/盖章</label><input id="e-form"></div>'+
   '<div class="fld"><label>备注</label><input id="e-note"></div>'+
   '<div class="acts"><button class="sm" data-a="cancel">取消</button>'+
   '<button class="sm primary" data-a="save">保存</button></div></div>';
  d.querySelector('#e-name').value=it.name;d.querySelector('#e-quote').value=it.quote;
  d.querySelector('#e-origin').value=it.origin;d.querySelector('#e-level').value=it.level;
  d.querySelector('#e-form').value=it.form||'';d.querySelector('#e-note').value=it.note||'';
  d.addEventListener('click',function(e){
    const a=e.target.getAttribute&&e.target.getAttribute('data-a');
    if(a==='cancel'){renderList();}
    if(a==='save'){
      it.name=d.querySelector('#e-name').value.trim();
      it.quote=d.querySelector('#e-quote').value.trim();
      it.origin=d.querySelector('#e-origin').value.trim();
      it.level=d.querySelector('#e-level').value.trim();
      it.form=d.querySelector('#e-form').value.trim();
      it.note=d.querySelector('#e-note').value.trim();
      renderList();updateProgress();
    }
  });
}
function updateProgress(){
  const total=ITEMS.length;
  const done=ITEMS.filter(function(i){return i.status!=='待确认'}).length;
  document.querySelector('.bar i').style.width=(total?Math.round(done/total*100):0)+'%';
  document.getElementById('pcount').textContent=done+' / '+total+' 已确认';
}
const UC_NOUN=['承诺函','声明函','承诺书','授权书','身份证明','营业执照','审计报告',
  '财务报告','社保证明','纳税证明','证书','证明','凭证','发票','扫描件','复印件',
  '原件','说明书','彩页','协议','合同'];
function guessName(t){
  for(var k=0;k<UC_NOUN.length;k++){
    var i=t.indexOf(UC_NOUN[k]);
    if(i>=0){
      var s=t.slice(Math.max(0,i-6),i+UC_NOUN[k].length).replace(/[，,、。；;：:\s]/g,'');
      s=s.replace(/^(供应商|投标人|中标人|我方|须|应|需|提供|提交|出具|递交|附上|附|并|的|等|一份|供)+/,'');
      if(s)return s;
    }
  }
  return t.slice(0,18);
}
function focusRects(page,rects){
  curItem={id:'uc',page:page,rects:rects||[]};
  const go=function(){const t=(rects&&rects[0])?rects[0][1]*scale:0;viewer.scrollTop=Math.max(0,t-110);};
  if(page!==pageNum)renderPage(page).then(go);else{drawHighlight();go();}
}
function ucAdd(u,i){
  const hasLoc=!!(u.rects&&u.rects.length);
  const nid=Math.max.apply(null,ITEMS.map(function(x){return x.id}).concat([0]))+1;
  ITEMS.push({id:nid,cat:'Z 人工新增（查漏）',name:guessName(u.text),quote:u.text,
    origin:(u.page?pgLabel(u.page):'页码待核对'),level:'强制',form:'',
    note:'由"未覆盖语句"面板加入，请核对材料名称、强制级别与原文出处',
    anchor:u.anchor||u.text,page:hasLoc?u.page:null,rects:u.rects||[],status:'采纳',self:''});
  UC_DONE[i]='added';
  renderUncovered();renderList();updateProgress();
  if(hasLoc)focusRects(u.page,u.rects);
  alert('已加入条目 #'+nid+(hasLoc?'（已定位并高亮）':'（未定位到原文，请人工核对）')+
        '，切到"条目清单"可编辑完善。');
}
function renderUncovered(){
  const box=document.getElementById('ucList');
  const done=Object.keys(UC_DONE).length;
  document.getElementById('ucNum').textContent=(UNCOVERED.length-done)+'';
  box.innerHTML='';
  if(!UNCOVERED.length){box.innerHTML='<div class="hint">未发现未被覆盖的提供类语句。</div>';return;}
  const show=document.getElementById('ucShowIgn').checked;
  let shown=0;
  UNCOVERED.forEach(function(u,i){
    const st=UC_DONE[i];
    if(st&&!show)return;
    if(ucFilter&&u.text.indexOf(ucFilter)<0)return;
    shown++;
    const d=document.createElement('div');d.className='un'+(st?' ig':'');
    const locTag=(u.rects&&u.rects.length)
      ?' <span style="color:#5B554A;font-weight:400">· 可定位</span>'
      :' <span style="color:#8F3529;font-weight:400">· 未定位</span>';
    d.innerHTML='<div class="pg">'+pgLabel(u.page)+locTag+
      '<span class="ucact">'+
      (st==='added'?'<span class="hint">已加入条目 </span>':'')+
      '<button class="sm" data-a="loc">定位高亮</button> '+
      '<button class="sm" data-a="add">加入条目</button> '+
      '<button class="sm" data-a="ign">'+(st?'恢复':'忽略')+'</button></span></div>'+
      '<div class="tx">'+esc(u.text)+'</div>';
    d.addEventListener('click',function(e){
      const a=e.target.getAttribute&&e.target.getAttribute('data-a');
      if(a==='ign'){if(st)delete UC_DONE[i];else UC_DONE[i]='ign';renderUncovered();return;}
      if(a==='add'){ucAdd(u,i);return;}
      if(!u.rects||!u.rects.length){alert('该语句在生成期未定位到坐标，请人工翻到该页核对。');renderPage(u.page);return;}
      focusRects(u.page,u.rects);
    });
    box.appendChild(d);
  });
  if(!shown)box.innerHTML='<div class="hint">没有符合筛选条件的语句。</div>';
}
document.getElementById('ucFilter').addEventListener('input',function(e){ucFilter=e.target.value.trim();renderUncovered();});
document.getElementById('ucShowIgn').addEventListener('change',renderUncovered);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function gotoPage(n){return renderPage(n);}

async function rectsOnPage(pageno,anchor){
  const page=await pdfDoc.getPage(pageno),vp=page.getViewport({scale:1}),
        tc=await page.getTextContent();
  const parts=[],map=[];
  tc.items.forEach(function(it,idx){
    const s=(it.str||'').replace(/\s+/g,'');if(!s)return;
    parts.push(s);for(let k=0;k<s.length;k++)map.push(idx);
  });
  const text=parts.join(''),a=anchor.replace(/\s+/g,'');
  const pos=text.indexOf(a);
  if(pos<0)return null;
  const sel=map.slice(pos,pos+a.length),lines={};
  sel.forEach(function(i){
    const it=tc.items[i];
    const tx=pdfjsLib.Util.transform(vp.transform,it.transform);
    const x=tx[4],y=tx[5],h=Math.hypot(tx[2],tx[3])||10,w=it.width||0;
    const top=y-h*0.86,key=Math.round(top/3);
    const e=lines[key]||(lines[key]={x0:1e9,x1:-1e9,top:top,bottom:y+2});
    e.x0=Math.min(e.x0,x);e.x1=Math.max(e.x1,x+w);
    e.top=Math.min(e.top,top);e.bottom=Math.max(e.bottom,y+2);
  });
  return Object.keys(lines).map(function(k){return lines[k]})
    .sort(function(a,b){return a.top-b.top})
    .map(function(e){return [e.x0,e.top,e.x1,e.bottom]});
}
document.getElementById('btnAddLocate').addEventListener('click',async function(){
  const p=pageNum,anc=document.getElementById('n-anchor').value.trim();
  if(!anc){alert('请先填写锚点文本（应与文档原文完全一致）');return;}
  const r=await rectsOnPage(p,anc);
  const tip=document.getElementById('n-tip');
  if(!r){tip.textContent='当前页未找到该锚点文本，请确认文字与原文一致，或切换到正确页面。';curItem=null;drawHighlight();return;}
  tip.textContent='已定位：'+r.length+' 个高亮框（'+pgLabel(p)+'）';
  curItem={id:-1,page:p,rects:r};drawHighlight();
});
document.getElementById('btnAddSave').addEventListener('click',async function(){
  const g=function(id){return document.getElementById(id).value.trim()};
  const name=g('n-name'),quote=g('n-quote'),anc=g('n-anchor')||quote;
  if(!name||!quote){alert('材料名称与原文摘录为必填');return;}
  const p=pageNum,r=await rectsOnPage(p,anc);
  const nid=Math.max.apply(null,ITEMS.map(function(i){return i.id}).concat([0]))+1;
  ITEMS.push({id:nid,cat:g('n-cat')||'Z 人工新增',name:name,quote:quote,
    origin:g('n-origin'),level:g('n-level')||'强制',form:g('n-form'),note:g('n-note'),
    anchor:anc,page:r?p:null,rects:r||[],status:'采纳',self:''});
  document.getElementById('n-tip').textContent=r?('已新增条目 #'+nid):('已新增条目 #'+nid+'，但未定位到原文，请人工核对');
  ['n-name','n-quote','n-anchor','n-origin','n-form','n-note'].forEach(function(id){document.getElementById(id).value=''});
  renderList();updateProgress();
});
document.getElementById('prev').addEventListener('click',function(){renderPage(pageNum-1)});
document.getElementById('next').addEventListener('click',function(){renderPage(pageNum+1)});
document.getElementById('pnum').addEventListener('change',function(e){renderPage(parseInt(e.target.value)||1)});
document.getElementById('zin').addEventListener('click',function(){scale=Math.min(3,scale+0.2);document.getElementById('zval').textContent=Math.round(scale*100)+'%';renderPage(pageNum)});
document.getElementById('zout').addEventListener('click',function(){scale=Math.max(0.5,scale-0.2);document.getElementById('zval').textContent=Math.round(scale*100)+'%';renderPage(pageNum)});

function checkAll(){
  const un=ITEMS.filter(function(i){return i.status==='待确认'});
  if(un.length){alert('还有 '+un.length+' 条未确认（逐条选择 采纳／剔除／存疑 后才能导出）：\n'+un.slice(0,12).map(function(i){return '#'+i.id+' '+i.name}).join('\n')+(un.length>12?'\n……':''));return false;}
  return true;
}
function accepted(){return ITEMS.filter(function(i){return i.status==='采纳'})}
function rejected(){return ITEMS.filter(function(i){return i.status==='剔除'})}
function doubted(){return ITEMS.filter(function(i){return i.status==='存疑'})}
document.getElementById('btnJson').addEventListener('click',function(){
  if(!checkAll())return;
  const out={project:window.__PROJECT__,exportTime:new Date().toLocaleString('zh-CN'),items:ITEMS};
  dl(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),'材料清单确认结果.json');
});
document.getElementById('btnDoc').addEventListener('click',function(){
  if(!checkAll())return;
  const p=window.__PROJECT__;
  let h='<html><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei";font-size:10.5pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:4px 6px;font-size:9.5pt;vertical-align:top}th{background:#EFE9DE}h1{font-size:16pt}h2{font-size:12pt;margin-top:18px}</style></head><body>';
  h+='<h1>'+p.name+' — 投标材料与资质清单</h1>';
  h+='<table><tr><th style="width:110px">项目编号</th><td>'+p.code+'</td><th style="width:110px">预算／最高限价</th><td>'+p.budget+'</td></tr>'+
     '<tr><th>投标截止</th><td>'+p.deadline+'</td><th>评标方式</th><td>'+p.method+'</td></tr>'+
     '<tr><th>复核时间</th><td>'+new Date().toLocaleString('zh-CN')+'</td><th>确认条目</th><td>采纳 '+accepted().length+' 条／剔除 '+rejected().length+' 条／存疑 '+doubted().length+' 条</td></tr></table>';
  h+='<h2>一、清单主体（已采纳条目）</h2>';
  const cats=[];accepted().forEach(function(i){if(cats.indexOf(i.cat)<0)cats.push(i.cat)});
  h+='<table><tr><th style="width:34px">序号</th><th style="width:120px">材料名称</th><th>招标文件原文要求</th><th style="width:130px">出处</th><th style="width:70px">强制级别</th><th style="width:110px">份数/形式/盖章</th><th style="width:70px">我方是否具备</th><th style="width:70px">备注</th></tr>';
  let n=0;
  cats.sort().forEach(function(cat){
    h+='<tr><td colspan="8" style="background:#F6F2EA"><b>'+cat+'</b></td></tr>';
    accepted().filter(function(i){return i.cat===cat}).sort(function(a,b){return (a.page||999)-(b.page||999)||a.id-b.id}).forEach(function(i){
      n++;
      h+='<tr><td>'+n+'</td><td>'+esc(i.name)+'</td><td>'+esc(i.quote)+'</td><td>'+esc(i.origin)+(i.page?('<br>PDF第'+i.page+'页'):'')+'</td><td>'+esc(i.level)+'</td><td>'+esc(i.form||'')+'</td><td>'+esc(i.self||'')+'</td><td>'+esc(i.note||'')+'</td></tr>';
    });
  });
  h+='</table>';
  if(rejected().length){
    h+='<h2>二、已剔除项（留痕，不列入备标）</h2><table><tr><th style="width:34px">序号</th><th style="width:120px">材料名称</th><th>原文依据</th><th style="width:130px">出处</th><th style="width:70px">剔除理由</th></tr>';
    rejected().forEach(function(i,k){h+='<tr><td>'+(k+1)+'</td><td>'+esc(i.name)+'</td><td>'+esc(i.quote)+'</td><td>'+esc(i.origin)+'</td><td></td></tr>';});
    h+='</table>';
  }
  if(doubted().length){
    h+='<h2>三、存疑待议项</h2><table><tr><th style="width:34px">序号</th><th style="width:120px">材料名称</th><th>原文依据</th><th style="width:130px">出处</th></tr>';
    doubted().forEach(function(i,k){h+='<tr><td>'+(k+1)+'</td><td>'+esc(i.name)+'</td><td>'+esc(i.quote)+'</td><td>'+esc(i.origin)+'</td></tr>';});
    h+='</table>';
  }
  h+='<h2>四、核对声明</h2><p>本清单由招标文件PDF逐页提取并与原文坐标绑定，经人工逐条复核确认；条目出处页码可在源文件中原位校验。正式备标前请对照招标文件原件复核，重点关注"投标人须知前附表"与"评标办法"两处。</p></body></html>';
  dl(new Blob(['\ufeff'+h],{type:'application/msword'}),'投标材料与资质清单.doc');
});
function dl(blob,name){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},800);
}
(function(){
  const t=document.querySelectorAll('.tab');
  t.forEach(function(b){b.addEventListener('click',function(){
    t.forEach(function(x){x.classList.remove('active')});b.classList.add('active');
    const k=b.getAttribute('data-t');
    document.getElementById('listwrap').style.display=k==='list'?'block':'none';
    document.getElementById('uncovered').style.display=k==='uncovered'?'block':'none';
    document.getElementById('addpanel').style.display=k==='add'?'block':'none';
  })});
  document.querySelectorAll('.sortbtn').forEach(function(b){
    b.addEventListener('click',function(){setSort(b.getAttribute('data-s'))});
  });
  const sp=document.getElementById('split'),left=document.getElementById('left'),right=document.querySelector('.right');
  let drag=false;
  sp.addEventListener('mousedown',function(){drag=true;document.body.style.cursor='col-resize'});
  window.addEventListener('mousemove',function(e){
    if(!drag)return;
    const w=Math.min(Math.max(window.innerWidth-e.clientX,320),900);
    right.style.width=w+'px';right.style.flex='0 0 '+w+'px';
  });
  window.addEventListener('mouseup',function(){drag=false;document.body.style.cursor=''});
  document.addEventListener('keydown',function(e){
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
    if(e.key==='ArrowLeft')renderPage(pageNum-1);
    if(e.key==='ArrowRight')renderPage(pageNum+1);
  });
})();
init();
"""

HTML = r"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>@@TITLE@@ · 材料清单复核</title>
<style>@@CSS@@</style></head>
<body>
<div class="top">
  <div>
    <h1>@@TITLE@@ · 投标材料与资质清单复核</h1>
    <div class="meta">项目编号 @@CODE@@ ｜ 预算 @@BUDGET@@ ｜ 投标截止 @@DEADLINE@@ ｜ @@METHOD@@</div>
  </div>
  <div class="tprog"><span class="hint">复核进度</span><div class="bar"><i></i></div><span id="pcount">0 / 0</span></div>
  <button id="btnJson">导出确认JSON</button>
  <button id="btnDoc" class="primary">导出Word（.doc）</button>
</div>
<div class="app">
  <div class="left" id="left">
    <div class="ltb">
      <button id="prev">◀</button>
      <input type="number" id="pnum" value="1" min="1">
      <span id="ptotal" class="hint"></span>
      <button id="next">▶</button>
      <span class="pgbadge" id="pgbadge"></span>
      <span style="flex:1"></span>
      <button id="zout">－</button><span id="zval" class="hint">120%</span><button id="zin">＋</button>
    </div>
    <div class="viewer" id="viewer"><div class="pagewrap" id="pagewrap"><canvas id="cv"></canvas><div class="hl" id="hl"></div></div></div>
  </div>
  <div class="splitter" id="split"></div>
  <div class="right">
    <div class="rtabs">
      <button class="tab active" data-t="list">条目清单</button>
      <button class="tab" data-t="uncovered">未覆盖语句 <b id="ucNum">0</b></button>
      <button class="tab" data-t="add">新增条目</button>
    </div>
    <div class="rbody" id="listwrap">
      <div class="listbar">
        <span class="hint">排序</span>
        <button class="sm sortbtn active" data-s="page">按页码升序</button>
        <button class="sm sortbtn" data-s="cat">按分类</button>
        <span class="hint" id="listcount" style="margin-left:auto"></span>
      </div>
      <div id="list"></div>
    </div>
    <div class="rbody" id="uncovered" style="display:none">
      <div class="warn">以下语句同时含"提供类动词＋材料名词"，但当前没有任何条目覆盖，用于查漏。点卡片或"定位高亮"可在左侧跳页并框出该句原文；确认是漏项请点"加入条目"直接补录；属报价/流程类要求可点"忽略"。本面板仅作查漏用，不作为清单依据。</div>
      <div class="ucbar">
        <input id="ucFilter" placeholder="输入关键词筛选，例如：授权、证书、扫描件">
        <label class="hint" style="white-space:nowrap"><input type="checkbox" id="ucShowIgn"> 显示已处理</label>
      </div>
      <div id="ucList"></div>
    </div>
    <div class="rbody" id="addpanel" style="display:none">
      <div class="warn">先翻到原文所在页，再填写锚点文本（须与文档原文完全一致），点"在当前页定位"确认高亮无误后保存。</div>
      <div class="fld"><label>分类</label><input id="n-cat" placeholder="如 Z 人工新增"></div>
      <div class="fld"><label>材料名称 *</label><input id="n-name"></div>
      <div class="fld"><label>原文摘录 *</label><textarea id="n-quote"></textarea></div>
      <div class="fld"><label>锚点文本（默认同原文摘录）</label><input id="n-anchor"></div>
      <div class="fld"><label>出处</label><input id="n-origin" placeholder="第X章…第N页"></div>
      <div class="fld"><label>强制级别</label><input id="n-level" placeholder="强制／评分／条件项"></div>
      <div class="fld"><label>份数/形式/盖章</label><input id="n-form"></div>
      <div class="fld"><label>备注</label><input id="n-note"></div>
      <button id="btnAddLocate">在当前页定位</button>
      <button id="btnAddSave" class="primary">保存条目</button>
      <div id="n-tip" class="hint" style="margin-top:8px"></div>
    </div>
  </div>
</div>
<script id="pdfb64" type="text/plain">@@PDFB64@@</script>
<script id="pdfWorkerSource" type="text/plain">@@WORKER@@</script>
<script>@@PDFJS@@</script>
<script>
window.__ITEMS__=@@ITEMS@@;
window.__OFFSET__=@@OFFSET@@;
window.__UNCOVERED__=@@UNCOVERED@@;
window.__PROJECT__=@@PROJECT@@;
@@APPJS@@
</script>
</body></html>
"""


def locate_uncovered(pages, uncovered_list):
    """为未覆盖语句离线预计算高亮坐标，供右栏"定位高亮"使用。

    整句精确匹配优先；失败则逐步取前缀（应对表格页跨列污染导致的长句断裂）。
    """
    ok = 0
    for u in uncovered_list:
        t = norm(u["text"])
        cand = t if len(t) <= 44 else t[:40]
        hits = locate(pages, cand, u.get("page"))
        if not hits and len(cand) > 14:
            hits = locate(pages, cand[:14], u.get("page"))
        if hits:
            h = hits[0]
            page = h["page"]
            u["page"] = page["pno"]
            u["rects"] = to_rects(page, h["word_idx"])
            u["anchor"] = cand
            u["locate"] = "OK" if h["exact"] else "容错"
            ok += 1
        else:
            u["rects"] = []
            u["anchor"] = cand
            u["locate"] = "MISS"
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--vendor", default=None, help="含 pdf.min.js / pdf.worker.min.js 的目录")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    vendor = args.vendor or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "assets", "vendor")
    pdfjs_path = os.path.join(vendor, "pdf.min.js")
    worker_path = os.path.join(vendor, "pdf.worker.min.js")
    for pth in (pdfjs_path, worker_path):
        if not os.path.isfile(pth):
            raise SystemExit("缺少 pdf.js 文件：%s（可用 curl 从 cdnjs 下载后放入 --vendor 目录）" % pth)

    with open(args.items, "r", encoding="utf-8") as f:
        data = json.load(f)
    project = data.get("project", {})
    items = data["items"]

    with pdfplumber.open(args.pdf) as pdf:
        pages = build_pages(pdf)
    offset, votes = detect_offset(pages)

    report = []
    report.append("=" * 72)
    report.append("页码校准：offset(物理页-标注页) = %s（投票命中 %d 次）" % (offset, votes))
    report.append("总页数：%d，条目数：%d" % (len(pages), len(items)))
    report.append("=" * 72)

    missing, ambiguous = [], []
    for it in items:
        hint = it.get("page")
        hits = locate(pages, it.get("anchor", ""), hint)
        if not hits:
            it["page"] = None
            it["pagePrinted"] = None
            it["rects"] = []
            it["resolve"] = "MISS"
            missing.append(it)
            report.append("[MISS] #%-3s %s（锚点：%s）"
                          % (it["id"], it["name"], it.get("anchor", "")[:40]))
            continue
        if len(hits) > 1:
            ambiguous.append(it)
        h = hits[0]
        page = h["page"]
        it["page"] = page["pno"]
        it["pagePrinted"] = (page["pno"] - offset) if offset is not None else None
        it["rects"] = to_rects(page, h["word_idx"])
        flag = "OK" if len(hits) == 1 else "AMBIG(%d)" % len(hits)
        if not h["exact"]:
            flag += "+容错"
        it["resolve"] = flag
        it.setdefault("status", "待确认")
        it.setdefault("self", "")
        report.append("[%-14s] #%-3s %-26s → 物理P%-3s 标注P%-4s 框%-2d 跳过%-3d %s"
                      % (flag, it["id"], it["name"][:24], it["page"],
                         it["pagePrinted"], len(it["rects"]), h.get("skips", 0),
                         "" if len(hits) == 1 else "候选P:" + ",".join(str(x["page"]["pno"]) for x in hits[:6])))
    for it in items:
        it.setdefault("status", "待确认")
        it.setdefault("self", "")
        it.setdefault("rects", [])
        it.setdefault("page", None)
        it.setdefault("pagePrinted", None)

    uncovered = coverage_check(pages, items)
    uc_ok = locate_uncovered(pages, uncovered)
    report.append("-" * 72)
    report.append("覆盖度校验：未被任何条目覆盖的强制类语句 %d 条（其中 %d 条已预计算高亮坐标，可点击定位）"
                  % (len(uncovered), uc_ok))
    for u in uncovered[:60]:
        report.append("  P%-3s %s" % (u["page"], u["text"][:80]))
    if len(uncovered) > 60:
        report.append("  …… 其余 %d 条见 HTML 右侧面板" % (len(uncovered) - 60))
    report.append("-" * 72)
    report.append("MISS 条目：%d 条 %s" % (len(missing), [m["id"] for m in missing]))
    report.append("歧义条目：%d 条 %s" % (len(ambiguous), [m["id"] for m in ambiguous]))
    report.append("=" * 72)
    report_text = "\n".join(report)
    print(report_text)

    with open(args.pdf, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(pdfjs_path, "r", encoding="utf-8") as f:
        pdfjs_src = f.read()
    with open(worker_path, "r", encoding="utf-8") as f:
        worker_src = f.read()

    def safe(s):
        return s.replace("</script", "<\\/script")

    html = HTML
    html = html.replace("@@CSS@@", CSS)
    html = html.replace("@@TITLE@@", args.title or project.get("name", "招标项目"))
    html = html.replace("@@CODE@@", project.get("code", ""))
    html = html.replace("@@BUDGET@@", project.get("budget", ""))
    html = html.replace("@@DEADLINE@@", project.get("deadline", ""))
    html = html.replace("@@METHOD@@", project.get("method", ""))
    html = html.replace("@@PDFB64@@", pdf_b64)
    html = html.replace("@@WORKER@@", safe(worker_src))
    html = html.replace("@@PDFJS@@", safe(pdfjs_src))
    html = html.replace("@@ITEMS@@", safe(json.dumps(items, ensure_ascii=False)))
    html = html.replace("@@OFFSET@@", "null" if offset is None else str(offset))
    html = html.replace("@@UNCOVERED@@", safe(json.dumps(uncovered, ensure_ascii=False)))
    html = html.replace("@@PROJECT@@", safe(json.dumps(project, ensure_ascii=False)))
    html = html.replace("@@APPJS@@", JS)
    left = set(re.findall(r"@@[A-Z_]+@@", html))
    if left:
        raise SystemExit("存在未替换占位符：%s" % left)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)

    rpt = os.path.splitext(args.out)[0] + "_生成报告.txt"
    with open(rpt, "w", encoding="utf-8") as f:
        f.write(report_text)
    dump = os.path.splitext(args.out)[0] + "_items.json"
    with open(dump, "w", encoding="utf-8") as f:
        json.dump({"project": project, "items": items}, f, ensure_ascii=False, indent=1)
    print("已生成：%s（%.2f MB）" % (args.out, os.path.getsize(args.out) / 1048576.0))
    print("生成报告：%s" % rpt)
    print("条目数据（含坐标，供 verify_rects.py 验证）：%s" % dump)


if __name__ == "__main__":
    main()
