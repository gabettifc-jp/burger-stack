/* 測定 M3 の集計（2026-08-14）。tools/m3-measure.mjs が書いた jsonl を読むだけ。
   使い方： node tools/m3-report.mjs tools/out/m3-*.jsonl                */
import { readFileSync } from 'fs';

const files = process.argv.slice(2);
const runs = [];
for (const f of files) for (const l of readFileSync(f, 'utf8').split('\n')) if (l.trim()) runs.push(JSON.parse(l));

const POLS = ['base', 'norem', 'nosauce', 'noaxis', 'random'];
const POL_JA = { base:'基準', norem:'削除しない', nosauce:'ソース無視', noaxis:'軸を無視', random:'何も考えない' };
const byPol = p => runs.filter(r => r.policy === p);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2) : 0; };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length-1, Math.floor(s.length * p))] : 0; };
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
const yen = v => '¥' + Math.round(v).toLocaleString('en-US');

console.log('# 測定 M3 の集計\n');
console.log('総ラン数: ' + runs.length + '（' + POLS.map(p => POL_JA[p] + ' ' + byPol(p).length).join(' / ') + '）');
console.log('エラー: ' + runs.filter(r => r.errs > 0).length + 'ラン / selfCheck 警告: ' + runs.filter(r => r.warn > 0).length + 'ラン'
  + ' / 分類不能: ' + runs.filter(r => r.ended === 'error').length + 'ラン');
console.log('レアリティのフォールバック: のべ ' + runs.reduce((s, r) => s + (r.fb || 0), 0) + '件\n');

// ── 5-1 通過率 ────────────────────────────────────────────────────────
console.log('## 1. 営業日ごとの通過率（方策別）\n');
console.log('| 方策 | ' + Array.from({length:10}, (_, i) => (i+1) + '日' ).join(' | ') + ' |');
console.log('| --- |' + ' --- |'.repeat(10));
const reach = {};
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  reach[p] = Array.from({length:10}, (_, i) => rs.filter(r => (r.daysSurvived || 0) >= i+1).length / rs.length * 100);
  console.log('| ' + POL_JA[p] + ' | ' + reach[p].map(v => v.toFixed(0) + '%').join(' | ') + ' |');
}
console.log('\n**10営業日への到達率**：' + POLS.filter(p => reach[p]).map(p => POL_JA[p] + ' ' + reach[p][9].toFixed(1) + '%').join(' / '));
console.log('\n差（基準との差・ポイント）：');
for (const p of POLS.slice(1)) if (reach[p]) console.log('  基準 − ' + POL_JA[p] + ' = ' + (reach.base[9] - reach[p][9]).toFixed(1) + 'ポイント');

// ── 5-1 所持金 ────────────────────────────────────────────────────────
console.log('\n## 2. 営業日の終了時（家賃を払った後）の所持金\n');
console.log('| 方策 | 営業日 | 中央値 | 第1四分位 | 第3四分位 | 最小 | 最大 | n |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  for (const d of [1, 3, 5, 10]) {
    const v = rs.map(r => (r.days || []).find(x => x.d === d)).filter(Boolean).map(x => x.money);
    if (!v.length) continue;
    console.log('| ' + POL_JA[p] + ' | ' + d + '日目 | ' + yen(med(v)) + ' | ' + yen(q(v, 0.25)) + ' | ' + yen(q(v, 0.75)) + ' | ' + yen(Math.min(...v)) + ' | ' + yen(Math.max(...v)) + ' | ' + v.length + ' |');
  }
}
{
  let drops = 0, cases = [];
  for (const r of runs) { const ds = (r.days || []).slice().sort((a, b) => a.d - b.d);
    for (let i = 1; i < ds.length; i++) if (ds[i].money < ds[i-1].money){ drops++; if (cases.length < 5) cases.push(`${r.policy}/seed${r.seed}/${ds[i].d}日目 ${yen(ds[i-1].money)}→${yen(ds[i].money)}`); } }
  console.log('\n**前日より所持金が減った営業日**: ' + drops + '回' + (cases.length ? '（例：' + cases.join('、') + '）' : ''));
  const last = byPol('base').map(r => { const ds = (r.days||[]).filter(x => x.d === 10); return ds.length ? ds[0].money : null; }).filter(v => v != null);
  if (last.length){ const m = med(last);
    console.log('**基準の10営業日目の所持金**: 中央値 ' + yen(m) + ' / 第1四分位 ' + yen(q(last,0.25)) + ' / 第3四分位 ' + yen(q(last,0.75))
      + ' → 散らばりは中央値の ' + (((q(last,0.75) - q(last,0.25)) / Math.max(1, m)) * 100).toFixed(0) + '%'); }
}

// ── 5-2 カードの打点 ─────────────────────────────────────────────────
console.log('\n## 3. カードの打点（101枚）\n');
const CARD = {};   // name -> { hits:[], band, pile, cui, rar }
for (const r of runs) for (const s of (r.spins || [])) for (const [nm, dmg] of (s.cards || [])) {
  (CARD[nm] = CARD[nm] || { hits: [] }).hits.push(dmg);
}
const META = JSON.parse(readFileSync('tools/out/m3-cards.json', 'utf8'));   // 名前→{pile,cui,rar,band} は measure が出す
const BAND = { nami: 60, jou: 120, tokujou: 240, kiwami: 480 };
const SAUCE_BAND = { nami: 20, jou: 80, tokujou: 200, kiwami: 360 };   // 40×(倍率−1)
const rows = [];
for (const nm of Object.keys(META)) {
  const m = META[nm], h = (CARD[nm] || { hits: [] }).hits;
  const band = m.pile === 'sauce' ? SAUCE_BAND[m.rar] : BAND[m.rar];
  rows.push({ nm, pile: m.pile, cui: m.cui, rar: m.rar, band, n: h.length,
    med: h.length ? med(h) : null, max: h.length ? Math.max(...h) : null,
    ratio: h.length ? med(h) / band : null });
}
rows.sort((a, b) => (b.ratio == null ? -1 : b.ratio) - (a.ratio == null ? -1 : a.ratio));
const out = rows.filter(r => r.ratio != null && (r.ratio > 2 || r.ratio < 0.5));
console.log('**帯の2倍を超える／半分を下回るカード: ' + out.length + '枚**（上振れ ' + out.filter(r => r.ratio > 2).length + ' / 下振れ ' + out.filter(r => r.ratio < 0.5).length + '）');
console.log('**出現回数0のカード: ' + rows.filter(r => r.n === 0).length + '枚**' + (rows.filter(r => r.n === 0).length ? '（' + rows.filter(r => r.n === 0).map(r => r.nm).join('・') + '）' : ''));
const show = (title, list) => {
  console.log('\n### ' + title + '\n');
  console.log('| カード | 山 | 軸 | 帯 | 帯の値 | 出現 | 打点の中央値 | 打点の最大 | 比 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of list) console.log('| ' + r.nm + ' | ' + (r.pile === 'sauce' ? 'ソース' : '具材') + ' | ' + (r.cui || '無印') + ' | ' + r.rar
    + ' | ' + r.band + ' | ' + r.n + ' | ' + (r.med != null ? r.med : '—') + ' | ' + (r.max != null ? r.max : '—') + ' | ' + (r.ratio != null ? r.ratio.toFixed(2) : '—') + ' |');
};
show('上位20枚（比の大きい順）', rows.filter(r => r.ratio != null).slice(0, 20));
show('下位20枚（比の小さい順）', rows.filter(r => r.ratio != null).slice(-20).reverse());
console.log('\n### 全101枚\n');
console.log('| カード | 山 | 軸 | 帯 | 帯の値 | 出現 | 打点の中央値 | 打点の最大 | 比 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log('| ' + r.nm + ' | ' + (r.pile === 'sauce' ? 'ソース' : '具材') + ' | ' + (r.cui || '無印') + ' | ' + r.rar
  + ' | ' + r.band + ' | ' + r.n + ' | ' + (r.med != null ? r.med : '—') + ' | ' + (r.max != null ? r.max : '—') + ' | ' + (r.ratio != null ? r.ratio.toFixed(2) : '—') + ' |');

// ── 5-3 アーティファクト ──────────────────────────────────────────────
console.log('\n## 4. アーティファクト\n');
const artCount = {};
for (const r of runs) for (const a of (r.artBuys || [])) artCount[a.nm] = (artCount[a.nm] || 0) + 1;
const filled = runs.filter(r => (r.arts || []).length >= 3).length;
const fillDays = runs.map(r => r.fills).filter(v => v != null);
console.log('**3枠が埋まったラン: ' + filled + '/' + runs.length + '（' + pct(filled, runs.length) + '）**／埋まった営業日の中央値: ' + (fillDays.length ? med(fillDays) + '営業日目' : '—'));
console.log('**入れ替え（枠が埋まった状態での買い直し）: ' + runs.reduce((s, r) => s + (r.artSwaps || 0), 0) + '回**');
console.log('\n購入回数（上位15）:');
const ac = Object.entries(artCount).sort((a, b) => b[1] - a[1]);
for (const [nm, c] of ac.slice(0, 15)) console.log('  ' + nm + ' ' + c);
console.log('購入0のアーティファクト: ' + (45 - ac.length) + '種');

// ── 5-4 デッキの組み直し ─────────────────────────────────────────────
console.log('\n## 5. デッキの帯の構成（方策別・営業日ごとの中央値）\n');
console.log('| 方策 | 営業日 | 並 | 上 | 特上 | 極 | デッキ枚数 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  for (const d of [1, 5, 10]) {
    const xs = rs.map(r => (r.days || []).find(x => x.d === d)).filter(Boolean);
    if (!xs.length) continue;
    console.log('| ' + POL_JA[p] + ' | ' + d + '日目 | ' + med(xs.map(x => x.bands.nami)) + ' | ' + med(xs.map(x => x.bands.jou))
      + ' | ' + med(xs.map(x => x.bands.tokujou)) + ' | ' + med(xs.map(x => x.bands.kiwami)) + ' | ' + med(xs.map(x => x.deck)) + ' |');
  }
}
console.log('\n取り除きと見送り（方策別・全ランの合計）:');
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  const rm = rs.reduce((s, r) => s + Object.values(r.removes || {}).reduce((a, c) => a + c, 0), 0);
  const sk = rs.reduce((s, r) => s + Object.values(r.skips || {}).reduce((a, c) => a + c, 0), 0);
  console.log('  ' + POL_JA[p] + '：取り除き ' + rm + '回 / 見送り ' + sk + '回');
}

// ── 5-5 段数とデッキ枚数のどちらが律速か ───────────────────────────────
console.log('\n## 6. 段数とデッキ枚数のどちらが律速だったか（全スピン%）\n');
console.log('| 方策 | 段数が律速 | デッキ枚数が律速 | 同数 | スピン数 |');
console.log('| --- | --- | --- | --- | --- |');
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  let a = 0, b = 0, c = 0, n = 0;
  for (const r of rs) for (const s of (r.spins || [])) { n++;
    const slots = s.ing, deckN = s.deck;
    if (deckN > slots) a++; else if (deckN < slots) b++; else c++; }
  console.log('| ' + POL_JA[p] + ' | ' + pct(a, n) + ' | ' + pct(b, n) + ' | ' + pct(c, n) + ' | ' + n + ' |');
}
console.log('\n## 7. 1スピンの得点（方策別・中央値）\n');
console.log('| 方策 | 1日目 | 3日目 | 5日目 | 10日目 |');
console.log('| --- | --- | --- | --- | --- |');
for (const p of POLS) {
  const rs = byPol(p); if (!rs.length) continue;
  const row = [1, 3, 5, 10].map(d => { const v = []; for (const r of rs) for (const s of (r.spins || [])) if (s.d === d) v.push(s.t); return v.length ? yen(med(v)) : '—'; });
  console.log('| ' + POL_JA[p] + ' | ' + row.join(' | ') + ' |');
}
