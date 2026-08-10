// burger-stack 自動測定ツール（開発用・ゲーム本体とは別。依存: playwright-core + Chromium）
//
// 目的: index.html を実ブラウザで読み込み、その場の buildBurger()/evaluate() を大量に回して
//       乗算の積の分布・得点の最高÷平均・コンボ件数の分布を出す。結果は LOG.md に貼る。
//
// 使い方:
//   node tools/measure.mjs --n=2000
//   node tools/measure.mjs --n=2000 --label="ソース倍率を広げた" \
//        --set='{"rules":{"ketchup":{"mult":2.5}},"params":{"comboBonus":{"perCombo":0.3}}}'
//
//   --n     サンプル数（既定 2000）
//   --label 記録用の見出し
//   --set   window.CONFIG に深くマージする上書き。rules は {id:{...}} で指定（配列でなく id キー）。
//   --url   対象URL（既定: 同梱の ../index.html）
//   環境変数 PW_CHROMIUM で Chromium 実行ファイルを指定可（未指定なら既定パスを試す）。
//
// 注意: これは計測専用の開発ツール。ブラウザで遊ぶだけなら不要。

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const N = parseInt(arg('n', '2000'), 10);
const label = arg('label', '');
const setJson = arg('set', '');
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const url = arg('url', 'file://' + fileURLToPath(new URL('../index.html', import.meta.url)));

const overrides = setJson ? JSON.parse(setJson) : null;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });

const result = await page.evaluate(({ N, overrides }) => {
  // 上書きを適用（rules は id 指定でマージ）
  if (overrides) {
    const C = window.CONFIG;
    if (overrides.params) {
      const deep = (t, s) => { for (const k in s) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = t[k] || {}; deep(t[k], s[k]); } else t[k] = s[k]; } };
      deep(C.params, overrides.params);
    }
    if (overrides.rules) for (const id in overrides.rules) { const r = C.rules.find(x => x.id === id); if (r) Object.assign(r, overrides.rules[id]); }
    if (overrides.items) for (const nm in overrides.items) if (C.items[nm]) Object.assign(C.items[nm], overrides.items[nm]);
  }
  const mults = [], totals = [], comboCounts = [];
  let sauceFired = 0;
  for (let k = 0; k < N; k++) {
    const b = window.buildBurger(); if (!b) continue;
    const sc = window.evaluate(b.stack);
    mults.push(sc.mult); totals.push(sc.total); comboCounts.push(sc.hits.length);
    if (sc.hits.some(h => /ケチャップ|マスタード|マヨネーズ/.test(h.label))) sauceFired++;
  }
  const sort = a => a.slice().sort((x, y) => x - y);
  const pct = (a, q) => { const s = sort(a); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const hist = a => { const h = {}; for (const v of a) h[v] = (h[v] || 0) + 1; return h; };
  const C = window.CONFIG;
  return {
    n: mults.length,
    settings: {
      tiers: C.params.tiers,
      comboBonus: C.params.comboBonus,
      rules: C.rules.map(r => ({ id: r.id, on: r.enabled !== false, mult: r.mult, add: r.add, runLen: r.runLen })),
    },
    mult: {
      min: +pct(mults, 0).toFixed(3), p10: +pct(mults, .10).toFixed(3), median: +pct(mults, .50).toFixed(3),
      mean: +mean(mults).toFixed(3), p90: +pct(mults, .90).toFixed(3), p99: +pct(mults, .99).toFixed(3),
      max: +pct(mults, 1).toFixed(3),
    },
    total: { median: pct(totals, .5), mean: +mean(totals).toFixed(1), max: pct(totals, 1), maxOverAvg: +(pct(totals, 1) / mean(totals)).toFixed(2) },
    comboCountHist: hist(comboCounts),
    sauceFireRatePct: +(sauceFired / mults.length * 100).toFixed(1),
  };
}, { N, overrides });

result.label = label;
console.log(JSON.stringify(result, null, 2));
await browser.close();
