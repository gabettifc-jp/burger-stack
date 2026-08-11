// burger-stack カード寄与測定ツール（開発用・ゲーム本体とは別。依存: playwright-core + Chromium）
//
// 目的: CONFIG.items の全カード（とアーティファクト）について、そのカードを1枚含むデッキと
//       含まない同条件のデッキの得点差（＝寄与）と比を、複数の文脈・複数シードで測る。結果は LOG.md に貼る。
//
// 使い方:
//   MODE=full  node tools/card-contrib.mjs   # 全カード＋道具（既定）
//   MODE=probe node tools/card-contrib.mjs   # 数枚だけ（動作確認）
//   環境変数 PW_CHROMIUM で Chromium 実行ファイルを指定可。
//
// 文脈（context）:
//   single   … 初期デッキ相当（ゴマバンズ＋無印中段）＋対象カード1枚
//   sameaxis … single ＋ 対象と同じ軸の中段カードを数枚 ＋対象カード1枚
//   big      … 対象と同じ軸の中段カードで約20枚のデッキ ＋対象カード1枚
//   段数はデッキ枚数に合わせる（tiers を十分大きく＝非復元で全部引き切る）。バンズは枠2。
//   バンズを測るときだけ枠バンズを1枚に減らし、対象バンズが2枚目として必ず入るようにする（clean測定）。
//
// 注意: 計測専用。ゲーム本体（得点計算・カード値・価格）には触れない。index.html は変更しない。

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';

const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const url = 'file://' + fileURLToPath(new URL('../index.html', import.meta.url));
const MODE = process.env.MODE || 'full';

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
const p = await browser.newContext().then(c => c.newPage());
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', e => errors.push('pageerror:' + e.message));
await p.goto(url, { waitUntil: 'load' });

const out = await p.evaluate((MODE) => {
  const C = window.CONFIG, items = C.items, ev = window.evaluate, bb = window.buildBurger, R = window.RUN;
  const names = Object.keys(items);
  const isBun = n => items[n].pile === 'bun';
  const midsOfAxis = A => names.filter(n => (items[n].cuisine || 'none') === A && (items[n].pile === 'ingredient' || items[n].pile === 'sauce'));
  const NONE_MIDS = ['パティ', 'チーズ', 'きゅうり', 'ケチャップ'];
  const GOMA = 'ゴマバンズ';
  const SEEDS = []; for (let i = 0; i < 16; i++) SEEDS.push((1234577 + i * 40503) >>> 0);   // 16 の固定シード
  const CAP = 1e15;
  const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

  function measure(counts, arts) {
    for (const n of names) items[n].count = 0;
    for (const k in counts) items[k].count = counts[k];
    C.params.tiers.ingredients = 60; C.params.tiers.sauces = 60;                 // 段数はデッキ枚数に合わせる（全引き）
    R.clearArtifacts(); if (R.clearTemporal) R.clearTemporal();
    if (arts && arts.length) R.setArtifacts(arts);
    const s = [];
    for (const sd of SEEDS) { R.seedNow(sd >>> 0); const b = bb(); if (b) { const r = ev(b.stack); const t = (r && isFinite(r.total)) ? r.total : CAP; s.push(Math.min(t, CAP)); } else s.push(0); }
    R.clearArtifacts();
    return median(s);
  }
  const frameCounts = xIsBun => { const c = {}; c[GOMA] = xIsBun ? 1 : 2; return c; };
  const addMids = (c, list, total) => { if (!list.length) return; for (let k = 0; k < total; k++) { const nm = list[k % list.length]; c[nm] = (c[nm] || 0) + 1; } };
  function baseFor(ctx, X) {
    const A = items[X].cuisine || 'none'; const xb = isBun(X); const c = frameCounts(xb);
    if (ctx === 'single') { for (const m of NONE_MIDS) c[m] = (c[m] || 0) + 1; }
    else if (ctx === 'sameaxis') { for (const m of NONE_MIDS) c[m] = (c[m] || 0) + 1; const pack = midsOfAxis(A).filter(n => n !== X).slice(0, 4); for (const m of pack) c[m] = (c[m] || 0) + 1; }
    else { let pool = midsOfAxis(A).filter(n => n !== X); if (!pool.length) pool = NONE_MIDS.filter(n => n !== X); addMids(c, pool, 18); }
    return c;
  }
  const withX = (base, X) => { const c = Object.assign({}, base); c[X] = (c[X] || 0) + 1; return c; };
  const CTX = ['single', 'sameaxis', 'big'];

  const CARDS = MODE === 'probe' ? ['パティ', 'フォアグラ', 'ほたて', 'パン・ド・カンパーニュ'].filter(n => items[n]) : names;
  const cards = {};
  for (const X of CARDS) {
    const rec = { axis: items[X].cuisine || 'none', pile: items[X].pile, base: items[X].base, ctx: {} };
    for (const ctx of CTX) { const base = baseFor(ctx, X); const wo = measure(base); const w = measure(withX(base, X)); rec.ctx[ctx] = { without: Math.round(wo), with: Math.round(w), contrib: Math.round(w - wo), ratio: +(w / Math.max(1, wo)).toFixed(3) }; }
    cards[X] = rec;
  }
  // アーティファクト
  const AXART = { axisWa: 'wa', axisChuka: 'chuka', axisKaisen: 'kaisen', axisKokyu: 'kokyu', axisAgemono: 'agemono' };
  const ARTS = MODE === 'probe' ? ['厨房の火力'] : Object.keys(C.artifacts);
  const arts = {};
  for (const an of ARTS) {
    const id = C.artifacts[an].id; const A = AXART[id] || 'none'; const rec = { id, axis: A, ctx: {} };
    for (const ctx of CTX) {
      const c = frameCounts(false);
      if (ctx === 'single') { for (const m of NONE_MIDS) c[m] = (c[m] || 0) + 1; }
      else if (ctx === 'sameaxis') { for (const m of NONE_MIDS) c[m] = (c[m] || 0) + 1; const pack = midsOfAxis(A).slice(0, 4); for (const m of pack) c[m] = (c[m] || 0) + 1; }
      else { let pool = midsOfAxis(A); if (!pool.length) pool = NONE_MIDS; addMids(c, pool, 18); }
      const wo = measure(c, []); const w = measure(c, [an]); rec.ctx[ctx] = { without: Math.round(wo), with: Math.round(w), contrib: Math.round(w - wo), ratio: +(w / Math.max(1, wo)).toFixed(3) };
    }
    arts[an] = rec;
  }
  // 軸ごとの base 平均（和6.2の裏取り用）
  const axAgg = {}; for (const n of names) { const a = items[n].cuisine || 'none'; (axAgg[a] = axAgg[a] || []).push(items[n].base); }
  const axisBaseAvg = {}; for (const a in axAgg) axisBaseAvg[a] = +(axAgg[a].reduce((x, y) => x + y, 0) / axAgg[a].length).toFixed(2);

  return { seeds: SEEDS, seedCount: SEEDS.length, ctxList: CTX, cards, arts, axisBaseAvg };
}, MODE);

console.log(JSON.stringify({ errors, mode: MODE, out }));
await browser.close();
if (errors.length) process.exitCode = 1;
