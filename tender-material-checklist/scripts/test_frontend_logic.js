#!/usr/bin/env node
/**
 * 复核工具前端逻辑离线自检（最小 DOM 桩，无需浏览器）
 *
 * 用途：在沙箱内无法启动 Chromium 时，实证前端关键逻辑正确，而不只是做语法检查。
 * 校验项：
 *   1) 条目默认"按页码升序"排列，未定位条目排最后；
 *   2) 切换"按分类"后按分类分组、组内页码升序；
 *   3) 未覆盖语句"加入条目"能正确新增条目（状态/分类/名称）并标记已处理；
 *   4) 材料名称推断 guessName() 输出干净（不残留"提供/须/应"等动词碎片）。
 *
 * 用法：node test_frontend_logic.js <复核HTML路径>
 * 退出码：0 全部通过；1 存在失败；2 用法/解析错误。
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法：node test_frontend_logic.js <复核HTML路径>');
  process.exit(2);
}
const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*type="text\/plain")[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]);
if (!blocks.length) {
  console.error('未找到应用脚本块，请确认输入的是生成器产出的复核 HTML。');
  process.exit(2);
}
// 去掉 init() 调用（避免触发 pdf.js）；剥离真实数据注入行（它们会覆盖测试数据）
let src = blocks[blocks.length - 1]
  .replace(/\ninit\(\);\s*$/, '\n')
  .replace(/^window\.__\w+__=.*;$/gm, '');

function mkEl() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [],
    textContent: '', value: '', checked: false, innerHTML: '', id: '', className: '',
    addEventListener() {}, appendChild(c) { this.children.push(c); },
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    getContext() { return {}; },
  };
}
const LIST = mkEl();
const els = {};
global.document = {
  getElementById(id) { return id === 'list' ? LIST : (els[id] || (els[id] = mkEl())); },
  createElement() { return mkEl(); },
  querySelector() { return mkEl(); },
  querySelectorAll() { return []; },
  addEventListener() {}, body: { style: {} },
};
global.alert = function (m) { console.log('    [提示] ' + m); };

const TEST_ITEMS = [
  { id: 1, cat: 'B 格式文件', page: 35, name: 'a', quote: 'q', origin: 'o', level: '强制', rects: [[0, 0, 1, 1]] },
  { id: 2, cat: 'A 资格证明', page: 7, name: 'b', quote: 'q', origin: 'o', level: '强制', rects: [[0, 0, 1, 1]] },
  { id: 3, cat: 'A 资格证明', page: 41, name: 'c', quote: 'q', origin: 'o', level: '强制', rects: [[0, 0, 1, 1]] },
  { id: 4, cat: 'B 格式文件', page: 9, name: 'd', quote: 'q', origin: 'o', level: '强制', rects: [[0, 0, 1, 1]] },
  { id: 5, cat: 'A 资格证明', page: null, name: 'e', quote: 'q', origin: 'o', level: '强制', rects: [] },
];
global.window = {
  addEventListener() {},
  __ITEMS__: TEST_ITEMS,
  __OFFSET__: 1, __UNCOVERED__: [], __PROJECT__: {},
};

const api = new Function('window', 'document', src +
  '\nreturn {setSort:setSort, guessName:guessName, ucAdd:ucAdd, ITEMS:ITEMS, UC_DONE:UC_DONE};'
)(global.window, global.document);

const ids = () => LIST.children.map(c => c.id).filter(x => x);
const labels = () => LIST.children.map(c => c.id ? c.id.replace('card-', '#') : '[' + c.textContent + ']');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) {
    console.log('      实际：' + JSON.stringify(got));
    console.log('      期望：' + JSON.stringify(want));
  }
}

LIST.children.length = 0;
api.setSort('page');
check('按页码升序（未定位排最后）', ids(),
  ['card-2', 'card-4', 'card-1', 'card-3', 'card-5']);

LIST.children.length = 0;
api.setSort('cat');
check('按分类分组（组内页码升序）', labels(),
  ['[A 资格证明]', '#2', '#3', '#5', '[B 格式文件]', '#4', '#1']);

check('名称推断（授权书）', api.guessName('供应商须提供法定代表人授权书原件'), '法定代表人授权书');
check('名称推断（审计报告）', api.guessName('投标人应提供近三年审计报告'), '近三年审计报告');

const before = api.ITEMS.length;
LIST.children.length = 0;
api.ucAdd({ text: '投标人应提供近三年审计报告，否则投标无效', page: null, rects: [], anchor: '应提供近三年审计报告' }, 0);
const added = api.ITEMS[api.ITEMS.length - 1];
check('加入条目：新增 1 条', api.ITEMS.length - before, 1);
check('加入条目：状态为采纳', added.status, '采纳');
check('加入条目：归入查漏分类', added.cat, 'Z 人工新增（查漏）');
check('加入条目：出处未定位时不渲染 null 页码', added.origin, '页码待核对');
check('加入条目：已标记处理', api.UC_DONE['0'], 'added');

console.log('-'.repeat(46));
console.log(failed ? ('自检未通过：' + failed + ' 项失败') : '自检全部通过');
process.exit(failed ? 1 : 0);
