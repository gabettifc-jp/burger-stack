/* 測定 M4 の集計（2026-08-14）。tools/out/m4-*.jsonl を読んで LOG に貼る形に整える。
   M3（tools/out/m3-*.jsonl）と同じ式で比を出し、並べて差分を見せる。
   tools/out/d1-items.json（tools/d1-probe.mjs dump の出力）が要る。
     node tools/m4-report.mjs > tools/out/m4-report.txt */
import { readFileSync, existsSync } from 'fs';

const POL = ['base', 'norem', 'nosauce', 'noaxis', 'takeall', 'random'];
const POL_JA = { base: '基準', norem: '削除しない', nosauce: 'ソース無視', noaxis: '軸を無視', takeall: '全部取る', random: '何も考えない' };
const M3POL = ['base', 'norem', 'nosauce', 'noaxis', 'random'];
const RJ = { nami: '並', jou: '上', tokujou: '特上', kiwami: '極' };
const CJ = { wa: '和', kokyu: '高級', chuka: '中華', kaisen: '海鮮', agemono: '揚げ物', none: '無印' };
const BAND = { nami: 60, jou: 120, tokujou: 240, kiwami: 480 };
const SAUCE_BAND = { nami: 20, jou: 80, tokujou: 200, kiwami: 360 };

const ITEMS = JSON.parse(readFileSync('tools/out/d1-items.json', 'utf8')).items;
const load = (pre, pols) => { const o = {}; for (const p of pols) { const f = `tools/out/${pre}-${p}.jsonl`; o[p] = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse) : []; } return o; };
const M4 = load('m4', POL), M3 = load('m3', M3POL);
const all4 = POL.flatMap(p => M4[p]);

const srt = a => a.slice().sort((x, y) => x - y);
const q = (a, p) => { if (!a.length) return null; const b = srt(a); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; };
const med = a => q(a, 0.5);
const sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
const yen = v => v == null ? '—' : '¥' + Math.round(v).toLocaleString();

/* ── 5-1 方策の比較 ────────────────────────────────────────────────── */
console.log('### 5-1. 方策の比較\n');
console.log('#### 10営業日目の所持金（家賃を払ったあと）\n');
console.log('| 方策 | 到達 | 中央値 | 第1四分位 | 第3四分位 | 最小 | 最大 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
const money10 = {};
for (const p of POL) {
  const xs = M4[p].map(r => (r.days || []).find(d => d.d === 10)).filter(Boolean).map(d => d.money);
  money10[p] = xs;
  console.log(`| ${POL_JA[p]} | ${xs.length}/${M4[p].length} | ${yen(med(xs))} | ${yen(q(xs, 0.25))} | ${yen(q(xs, 0.75))} | ${yen(xs.length ? Math.min(...xs) : null)} | ${yen(xs.length ? Math.max(...xs) : null)} |`);
}
console.log('\n#### 営業日ごとの通過率（参考）\n');
console.log('| 方策 | ' + Array.from({ length: 10 }, (_, i) => (i + 1) + '日').join(' | ') + ' |');
console.log('| --- | ' + Array.from({ length: 10 }, () => '---').join(' | ') + ' |');
for (const p of POL) {
  const n = M4[p].length;
  const row = Array.from({ length: 10 }, (_, i) => Math.round(100 * M4[p].filter(r => (r.days || []).some(d => d.d === i + 1)).length / n) + '%');
  console.log(`| ${POL_JA[p]} | ${row.join(' | ')} |`);
}
console.log('\n#### 10営業日後のデッキ枚数・引く枚数\n');
console.log('| 方策 | デッキ中央値 | 第1四分位 | 第3四分位 | 最大 | 引く枚数(具材+ソース)の中央値 | デッキ÷引く枚数 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const p of POL) {
  const rs = M4[p].filter(r => (r.days || []).some(d => d.d === 10));
  const dk = rs.map(r => r.deck), cp = rs.map(r => r.cap);
  console.log(`| ${POL_JA[p]} | ${med(dk)} | ${q(dk, 0.25)} | ${q(dk, 0.75)} | ${dk.length ? Math.max(...dk) : '—'} | ${med(cp)} | ${(med(dk) / med(cp)).toFixed(2)} |`);
}
console.log('\n#### 3択の取捨・削除・具材枠（1ランあたり中央値／10営業日の合計）\n');
console.log('| 方策 | 取った | 見送った | 削除 | 具材枠の購入 | 店でカードを買った |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const p of POL) {
  const rs = M4[p];
  console.log(`| ${POL_JA[p]} | ${med(rs.map(r => sum(r.takes)))} | ${med(rs.map(r => sum(r.skips)))} | ${med(rs.map(r => sum(r.removes)))} | ${med(rs.map(r => sum(r.slots)))} | ${med(rs.map(r => (r.buys || []).filter(b => b.kind === 'card').length))} |`);
}
console.log('\n#### 営業日ごとの見送りと削除（基準方策・中央値）\n');
console.log('| 営業日 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [k, ja] of [['skips', '見送り'], ['takes', '取った'], ['removes', '削除'], ['slots', '具材枠']]) {
  const row = Array.from({ length: 10 }, (_, i) => med(M4.base.filter(r => (r.days || []).some(d => d.d === i + 1)).map(r => (r[k] || {})[i + 1] || 0)));
  console.log(`| ${ja} | ${row.join(' | ')} |`);
}

/* ── 5-2 カードの打点 ─────────────────────────────────────────────── */
function cardRows(runs) {
  const H = {};
  for (const r of runs) for (const s of r.spins || []) for (const [nm, d] of s.cards || []) (H[nm] = H[nm] || []).push(d);
  const rows = [];
  for (const nm of Object.keys(ITEMS)) {
    const it = ITEMS[nm]; if (it.pile === 'bun') continue;
    const h = H[nm] || [];
    const band = it.pile === 'sauce' ? SAUCE_BAND[it.rar] : BAND[it.rar];
    rows.push({ nm, pile: it.pile === 'sauce' ? 'ソース' : '具材', cui: CJ[it.cui] || it.cui, rar: RJ[it.rar], band,
      n: h.length, med: med(h), q3: q(h, 0.75), max: h.length ? Math.max(...h) : null,
      ratio: h.length ? med(h) / band : null });
  }
  return rows;
}
const R4 = cardRows(all4), R3 = cardRows(M3POL.flatMap(p => M3[p]));
const by3 = {}; for (const r of R3) by3[r.nm] = r;
R4.sort((a, b) => (b.ratio == null ? -1 : b.ratio) - (a.ratio == null ? -1 : a.ratio));
const out4 = R4.filter(r => r.ratio != null && (r.ratio > 2 || r.ratio < 0.5));
console.log('\n### 5-2. カードの打点\n');
console.log(`**帯の2倍を超える／半分を下回るカード：${out4.length}枚**（上振れ ${out4.filter(r => r.ratio > 2).length}・下振れ ${out4.filter(r => r.ratio < 0.5).length}）。M3 は61枚（上振れ15・下振れ46）。`);
const few = R4.filter(r => r.n > 0 && r.n < 100).map(r => `${r.nm}（${r.n}回）`);
console.log(`\n出現0回のカード：${R4.filter(r => r.n === 0).map(r => r.nm).join('、') || 'なし'}。出現100回未満：${few.join('、') || 'なし'}。`);
const show = (title, rows) => {
  console.log(`\n#### ${title}\n`);
  console.log('| カード | 山 | 軸 | 帯 | 帯の値 | 出現 | 中央値 | 第3四分位 | 最大 | 中央値÷帯 | M3の比 | 動き |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const o = by3[r.nm], r3 = o && o.ratio != null ? o.ratio : null;
    const d = (r.ratio != null && r3 != null) ? (r.ratio - r3) : null;
    console.log(`| ${r.nm} | ${r.pile} | ${r.cui} | ${r.rar} | ${r.band} | ${r.n} | ${r.med != null ? r.med : '—'} | ${r.q3 != null ? r.q3 : '—'} | ${r.max != null ? r.max : '—'} | ${r.ratio != null ? r.ratio.toFixed(2) : '—'} | ${r3 != null ? r3.toFixed(2) : '—'} | ${d != null ? (d >= 0 ? '+' : '') + d.toFixed(2) : '—'} |`);
  }
};
show('上位20枚（比の大きい順）', R4.filter(r => r.ratio != null).slice(0, 20));
show('下位20枚（比の小さい順）', R4.filter(r => r.ratio != null).slice(-20).reverse());
show('全101枚（比の大きい順）', R4);

/* ── 5-3 隣接の成立率 ─────────────────────────────────────────────── */
const cuiOf = nm => (ITEMS[nm] || {}).cui || 'none';
console.log('\n### 5-3. 隣接の成立率\n');
console.log('| 方策 | スピン | 中段の枚数(中央) | 接する具材1枚 | 2枚 | 上下どちらかが同軸 | 上下の両方が同軸 | M3の「両方」 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
const M3BOTH = { base: '3.8%', norem: '3.0%', nosauce: '3.9%', noaxis: '3.0%', takeall: '—', random: '3.4%' };
const runLen = {};
for (const p of POL) {
  const t = { spins: 0, nb: [0, 0, 0], same: 0, sameDen: 0, both: 0, bothDen: 0, byLen: {}, run: {} };
  for (const r of M4[p]) for (const s of r.spins || []) {
    const cs = (s.cards || []).map(x => x[0]);
    if (!cs.length || (s.n - cs.length) !== 2) continue;
    t.spins++; t.byLen[cs.length] = (t.byLen[cs.length] || 0) + 1;
    for (let i = 0; i < cs.length; i++) {
      t.nb[(i > 0 ? 1 : 0) + (i < cs.length - 1 ? 1 : 0)]++;
      const cu = cuiOf(cs[i]); if (cu === 'none') continue;
      const up = i > 0 ? cuiOf(cs[i - 1]) : null, dn = i < cs.length - 1 ? cuiOf(cs[i + 1]) : null;
      t.sameDen++; if (up === cu || dn === cu) t.same++;
      if (up != null && dn != null) { t.bothDen++; if (up === cu && dn === cu) t.both++; }
    }
    let cur = null, len = 0;
    for (const nm of cs.concat([null])) {
      const cu = nm ? cuiOf(nm) : '__end';
      if (cu === cur && cu !== 'none') len++;
      else { if (len >= 1 && cur && cur !== 'none') t.run[len] = (t.run[len] || 0) + 1; cur = cu; len = 1; }
    }
  }
  runLen[p] = t.run;
  const tot = t.nb[0] + t.nb[1] + t.nb[2];
  const lens = Object.entries(t.byLen).sort((a, b) => b[1] - a[1])[0];
  console.log(`| ${POL_JA[p]} | ${t.spins} | ${lens ? lens[0] : '—'} | ${(100 * t.nb[1] / tot).toFixed(1)}% | ${(100 * t.nb[2] / tot).toFixed(1)}% | ${(100 * t.same / t.sameDen).toFixed(1)}% | ${(100 * t.both / t.bothDen).toFixed(1)}% | ${M3BOTH[p]} |`);
}
console.log('\n#### 中段に同じ軸が自分以外で k 枚あるときの成立率\n');
console.log('| 方策 | k | 観測 | どちらかが同軸 | 両方が同軸 |');
console.log('| --- | --- | --- | --- | --- |');
for (const p of ['base', 'noaxis', 'takeall']) {
  const byK = {};
  for (const r of M4[p]) for (const s of r.spins || []) {
    const cs = (s.cards || []).map(x => x[0]);
    if (!cs.length || (s.n - cs.length) !== 2) continue;
    for (let i = 0; i < cs.length; i++) {
      const cu = cuiOf(cs[i]); if (cu === 'none') continue;
      let k = 0; for (let j = 0; j < cs.length; j++) if (j !== i && cuiOf(cs[j]) === cu) k++;
      const kk = Math.min(k, 3), t = byK[kk] = byK[kk] || { n: 0, one: 0, both: 0, bothDen: 0 };
      t.n++;
      const up = i > 0 ? cuiOf(cs[i - 1]) : null, dn = i < cs.length - 1 ? cuiOf(cs[i + 1]) : null;
      if (up === cu || dn === cu) t.one++;
      if (up != null && dn != null) { t.bothDen++; if (up === cu && dn === cu) t.both++; }
    }
  }
  for (const k of [0, 1, 2, 3]) { const t = byK[k]; if (!t) continue;
    console.log(`| ${POL_JA[p]} | ${k === 3 ? '3以上' : k} | ${t.n} | ${(100 * t.one / t.n).toFixed(1)}% | ${t.bothDen ? (100 * t.both / t.bothDen).toFixed(1) + '%' : '—'} |`); }
}
console.log('\n#### 同じ軸が続いた長さ\n');
console.log('| 方策 | 1（孤立） | 2 | 3 | 4 | 5以上 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const p of POL) {
  const t = runLen[p], tot = Object.values(t).reduce((a, b) => a + b, 0);
  const g = k => (100 * (t[k] || 0) / tot).toFixed(1) + '%';
  const g5 = (100 * Object.entries(t).filter(([k]) => +k >= 5).reduce((a, b) => a + b[1], 0) / tot).toFixed(1) + '%';
  console.log(`| ${POL_JA[p]} | ${g(1)} | ${g(2)} | ${g(3)} | ${g(4)} | ${g5} |`);
}

/* ── 5-4 そのほか ─────────────────────────────────────────────────── */
console.log('\n### 5-4. そのほか\n');
console.log('| 方策 | レアリティの落下（合計／1ランあたり） | 献立表を買ったラン | 3枠が埋まった割合 | 埋まった営業日(中央) | 入れ替え | セルフチェック警告 | エラー |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const p of POL) {
  const rs = M4[p], n = rs.length;
  const fb = rs.reduce((a, r) => a + (r.fb || 0), 0);
  const ken = rs.filter(r => (r.artBuys || []).some(b => b.nm === '献立表')).length;
  const fills = rs.map(r => r.fills).filter(x => x != null);
  console.log(`| ${POL_JA[p]} | ${fb} / ${(fb / n).toFixed(1)} | ${ken} | ${(100 * fills.length / n).toFixed(1)}% | ${med(fills) != null ? med(fills) : '—'} | ${rs.reduce((a, r) => a + (r.artSwaps || 0), 0)} | ${rs.reduce((a, r) => a + (r.warn || 0), 0)} | ${rs.reduce((a, r) => a + (r.errs || 0), 0)} |`);
}
console.log('\n#### 段数とデッキ枚数のどちらが律速か（全スピン%）\n');
console.log('| 方策 | 具材：段数律速 | 具材：デッキ律速 | 一致 | ソース：段数律速 | ソース：デッキ律速 | 一致 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const p of POL) {
  let n = 0, it = 0, id = 0, ie = 0, st = 0, sd = 0, se = 0;
  for (const r of M4[p]) for (const s of r.spins || []) { n++;
    if (s.ic > s.ing) it++; else if (s.ic < s.ing) id++; else ie++;
    if (s.sc > s.sau) st++; else if (s.sc < s.sau) sd++; else se++; }
  const f = v => (100 * v / n).toFixed(1) + '%';
  console.log(`| ${POL_JA[p]} | ${f(it)} | ${f(id)} | ${f(ie)} | ${f(st)} | ${f(sd)} | ${f(se)} |`);
}
console.log('\n#### 終わり方\n');
console.log('| 方策 | 10営業日到達 | 家賃を払えず終了 | ハーネスが止まった | エラー |');
console.log('| --- | --- | --- | --- | --- |');
for (const p of POL) {
  const rs = M4[p], c = k => rs.filter(r => r.ended === k).length;
  console.log(`| ${POL_JA[p]} | ${c('cleared')} | ${c('broke')} | ${c('stuck')} | ${c('error')} |`);
}
console.log('\n#### 極のソース6枚（帯360）\n');
console.log('| ソース | 出現 | 中央値 | 第3四分位 | 最大 | 中央値÷帯 | M3の比 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const nm of ['フォンドヴォー', '花椒油', 'ブイヤベース', '南蛮酢', '煎り酒', 'スペシャルソース']) {
  const r = R4.find(x => x.nm === nm), o = by3[nm];
  console.log(`| ${nm} | ${r.n} | ${r.med != null ? r.med : '—'} | ${r.q3 != null ? r.q3 : '—'} | ${r.max != null ? r.max : '—'} | ${r.ratio != null ? r.ratio.toFixed(2) : '—'} | ${o && o.ratio != null ? o.ratio.toFixed(2) : '—'} |`);
}
