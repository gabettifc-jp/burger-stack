/* 調査 D1：M3 の記録（tools/out/m3-*.jsonl）から §3・§4 を読み出す（2026-08-14）。
   新しい測定はしない。index.html には触らない。
     node tools/d1-analyze.mjs           … すべて出す
     node tools/d1-analyze.mjs adj       … §3-3 の隣接だけ
   d1-items.json（tools/d1-probe.mjs dump の出力）が要る。 */
import { readFileSync } from 'fs';

const POL = ['base', 'norem', 'nosauce', 'noaxis', 'random'];
const POL_JA = { base: '基準', norem: '削除しない', nosauce: 'ソース無視', noaxis: '軸を無視', random: '何も考えない' };
const RJ = { nami: '並', jou: '上', tokujou: '特上', kiwami: '極' };
const CJ = { wa: '和', kokyu: '高級', chuka: '中華', kaisen: '海鮮', agemono: '揚げ物', none: '無印' };
const BAND = { nami: 60, jou: 120, tokujou: 240, kiwami: 480 };
const SAUCE_BAND = { nami: 20, jou: 80, tokujou: 200, kiwami: 360 };   // 40×(倍率−1)
const ONLY = process.argv[2] || 'all';

const ITEMS = JSON.parse(readFileSync('tools/out/d1-items.json', 'utf8')).items;
const runs = [];
for (const p of POL) for (const l of readFileSync(`tools/out/m3-${p}.jsonl`, 'utf8').trim().split('\n')) runs.push(JSON.parse(l));

const srt = a => a.slice().sort((x, y) => x - y);
const q = (a, p) => { if (!a.length) return null; const b = srt(a); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; };
const med = a => q(a, 0.5);

/* ── 条件の型（§3-1）。効果 id と効果文から機械的に決める ─────────────────── */
// 指示書 §3-1 が名前で挙げているカードは、その型に置く（機械判定より指示書を優先する）。
const TYPE_FIX = { 飴細工: 'その他・特殊', 蟹カマ: 'その他・特殊', ツナ: 'その他・特殊', いか: 'その他・特殊' };
const ADJ_ID = /^adj/;
function typeOf(nm) {
  if (TYPE_FIX[nm]) return TYPE_FIX[nm];
  const it = ITEMS[nm] || {}; const id = it.eid || ''; const t = it.text || '';
  if (!id) return '効果なし';
  if (id === 'runLenAdd' || /連続して/.test(t)) return '連続';
  // 蓄積は「上下に接さなかったスピン1回につき（おはぎ）」のように隣接の語を含むので、隣接より先に見る。
  if (id === 'growOn' || id === 'growPm' || id === 'runCountAdd') return '蓄積';
  if (id === 'coinFlipAdd' || id === 'coinFlipMult') return '確率';
  if (ADJ_ID.test(id) || /上下|接する|隣/.test(t)) return '隣接';
  if (id === 'deckCountAdd' || id === 'deckSizeMult' || id === 'drawFewerMult' || id === 'deckTopAdd' || /デッキ/.test(t)) return 'デッキを数える';
  if (id === 'boardCountAdd' || id === 'boardCuiMult' || id === 'axisKindsMult' || id === 'flatMult' || /盤面/.test(t)) return '盤面を数える';
  return 'その他・特殊';
}

/* ── カードごとの打点を集める ─────────────────────────────────────────── */
const HITS = {};
for (const r of runs) for (const s of r.spins || []) for (const [nm, d] of s.cards || []) (HITS[nm] = HITS[nm] || []).push(d);

const rows = [];
for (const nm of Object.keys(ITEMS)) {
  const it = ITEMS[nm]; if (it.pile === 'bun') continue;
  const h = HITS[nm] || [];
  const band = it.pile === 'sauce' ? SAUCE_BAND[it.rar] : BAND[it.rar];
  rows.push({ nm, pile: it.pile, cui: CJ[it.cui] || it.cui, rar: RJ[it.rar], band, n: h.length,
    med: med(h), max: h.length ? Math.max(...h) : null, q3: q(h, 0.75),
    ratio: h.length ? med(h) / band : null, rmax: h.length ? Math.max(...h) / band : null,
    type: typeOf(nm), eid: it.eid, text: it.text });
}
const low = rows.filter(r => r.ratio != null && r.ratio < 0.5).sort((a, b) => a.med - b.med || a.ratio - b.ratio);
const high = rows.filter(r => r.ratio != null && r.ratio > 2).sort((a, b) => b.ratio - a.ratio);

if (ONLY === 'all' || ONLY === 'low') {
  console.log(`\n## §3-2 下振れ ${low.length}枚（中央値の低い順）\n`);
  console.log('| # | カード | 山 | 軸 | 帯 | 帯の値 | 出現 | 中央値 | 第3四分位 | 最大 | 中央値÷帯 | 最大÷帯 | 条件の型 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  low.forEach((r, i) => console.log(`| ${i + 1} | ${r.nm} | ${r.pile === 'sauce' ? 'ソース' : '具材'} | ${r.cui} | ${r.rar} | ${r.band} | ${r.n} | ${r.med} | ${r.q3} | ${r.max} | ${r.ratio.toFixed(2)} | ${r.rmax.toFixed(2)} | ${r.type} |`));

  // 最大値は 600ラン・数千回の観測の外れ値なので、それだけで「当たれば大きい」とは言えない。
  //   第3四分位（4回に1回はこれ以上）で切る：q3 が帯に届く＝ときどき仕事をする、届かない＝死に札。
  const cls = r => r.med < 0 ? '置くと損' : (r.q3 >= r.band ? 'ときどき当たる' : (r.q3 >= r.band * 0.5 ? '半分どまり' : '死に札'));
  const byType = {};
  for (const r of low) { const t = byType[r.type] = byType[r.type] || { n: 0, c: {} };
    t.n++; const k = cls(r); t.c[k] = (t.c[k] || 0) + 1; }
  console.log('\n### 型ごとの内訳（下振れ46枚・第3四分位で切る）\n');
  console.log('| 型 | 枚数 | ときどき当たる（Q3≧帯） | 半分どまり（帯の0.5〜1倍） | 死に札（Q3が帯の半分未満） | 置くと損（中央値が負） |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n))
    console.log(`| ${k} | ${v.n} | ${v.c['ときどき当たる'] || 0} | ${v.c['半分どまり'] || 0} | ${v.c['死に札'] || 0} | ${v.c['置くと損'] || 0} |`);
  for (const k of ['ときどき当たる', '半分どまり', '死に札', '置くと損'])
    console.log(`\n${k}（${low.filter(r => cls(r) === k).length}枚）: ` + low.filter(r => cls(r) === k).map(r => r.nm).join('、'));
  console.log('\n最大値だけで見ると: 最大が帯の2倍を超えるのは ' + low.filter(r => r.rmax >= 2).length + '/46枚（つまり最大値では死に札が1枚も出ない）。');
}

if (ONLY === 'all' || ONLY === 'high') {
  console.log(`\n## §4-2 上振れ ${high.length}枚（比の大きい順）\n`);
  console.log('| # | カード | 山 | 軸 | 帯 | 帯の値 | 出現 | 中央値 | 第3四分位 | 最大 | 中央値÷帯 | 条件の型 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  high.forEach((r, i) => console.log(`| ${i + 1} | ${r.nm} | ${r.pile === 'sauce' ? 'ソース' : '具材'} | ${r.cui} | ${r.rar} | ${r.band} | ${r.n} | ${r.med} | ${r.q3} | ${r.max} | ${r.ratio.toFixed(2)} | ${r.type} |`));

  const KIW = ['フォンドヴォー', '花椒油', 'ブイヤベース', '南蛮酢', '煎り酒', 'スペシャルソース'];
  console.log('\n## §4-1 極のソース6枚\n');
  console.log('| ソース | 軸 | 出現 | 中央値 | 第3四分位 | 最大 | 中央値÷帯(360) | 効果文 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const nm of KIW) { const r = rows.find(x => x.nm === nm); if (!r) { console.log(`| ${nm} | — | 見つからない |`); continue; }
    console.log(`| ${nm} | ${r.cui} | ${r.n} | ${r.med} | ${r.q3} | ${r.max} | ${r.ratio.toFixed(2)} | ${r.text} |`); }
}

/* ── §3-3 隣接条件の成立率 ─────────────────────────────────────────────── */
if (ONLY === 'all' || ONLY === 'adj') {
  // spins[].cards はバンズを除いた「中段の並び順」。バンズは stack の両端なので順序は保たれる。
  // 念のため「n − cards.length === 2」（盤面のバンズがちょうど2枚）のスピンだけを見る。
  const cuiOf = nm => (ITEMS[nm] || {}).cui || 'none';
  const st = {};   // policy -> 集計
  for (const p of POL) st[p] = { spins: 0, mids: 0, nb: [0, 0, 0], same: 0, sameDen: 0, both: 0, bothDen: 0, run: {}, byLen: {} };
  for (const r of runs) {
    const t = st[r.policy]; if (!t) continue;
    for (const s of r.spins || []) {
      const cs = (s.cards || []).map(x => x[0]);
      if (!cs.length || (s.n - cs.length) !== 2) continue;
      t.spins++; t.mids += cs.length; t.byLen[cs.length] = (t.byLen[cs.length] || 0) + 1;
      for (let i = 0; i < cs.length; i++) {
        const nb = (i > 0 ? 1 : 0) + (i < cs.length - 1 ? 1 : 0);   // 上下に接する「具材/ソース」の枚数（端はバンズ）
        t.nb[nb]++;
        const cu = cuiOf(cs[i]); if (cu === 'none') continue;
        const up = i > 0 ? cuiOf(cs[i - 1]) : null, dn = i < cs.length - 1 ? cuiOf(cs[i + 1]) : null;
        t.sameDen++; if (up === cu || dn === cu) t.same++;
        if (up != null && dn != null) { t.bothDen++; if (up === cu && dn === cu) t.both++; }
      }
      // 同じ軸が続いた長さ（無印は連鎖を切る）
      let cur = null, len = 0;
      for (const nm of cs.concat([null])) {
        const cu = nm ? cuiOf(nm) : '__end';
        if (cu === cur && cu !== 'none') len++;
        else { if (len >= 1 && cur && cur !== 'none') t.run[len] = (t.run[len] || 0) + 1; cur = cu; len = 1; }
      }
    }
  }
  console.log('\n## §3-3 隣接条件の成立率（M3 の全スピンから・盤面のバンズが2枚のスピンのみ）\n');
  console.log('| 方策 | スピン | 中段の枚数(中央) | 接する具材0枚 | 1枚 | 2枚 | 上下どちらかが同軸 | 上下の両方が同軸 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of POL) { const t = st[p]; if (!t.spins) continue;
    const tot = t.nb[0] + t.nb[1] + t.nb[2];
    const lens = Object.entries(t.byLen).sort((a, b) => b[1] - a[1])[0];
    console.log(`| ${POL_JA[p]} | ${t.spins} | ${lens ? lens[0] : '—'} | ${(100 * t.nb[0] / tot).toFixed(1)}% | ${(100 * t.nb[1] / tot).toFixed(1)}% | ${(100 * t.nb[2] / tot).toFixed(1)}% | ${(100 * t.same / t.sameDen).toFixed(1)}% | ${(100 * t.both / t.bothDen).toFixed(1)}% |`); }
  // 「軸に寄せると隣接は成立しやすくなるのか」を、方策ではなく盤面の実態で見る。
  //   そのカードと同じ軸のカードが、中段に自分以外で何枚あるか（k）ごとに成立率を出す。
  const byK = {};
  for (const r of runs) for (const s of r.spins || []) {
    const cs = (s.cards || []).map(x => x[0]);
    if (!cs.length || (s.n - cs.length) !== 2) continue;
    for (let i = 0; i < cs.length; i++) {
      const cu = cuiOf(cs[i]); if (cu === 'none') continue;
      let k = 0; for (let j = 0; j < cs.length; j++) if (j !== i && cuiOf(cs[j]) === cu) k++;
      const kk = Math.min(k, 3);
      const t = byK[kk] = byK[kk] || { n: 0, one: 0, both: 0, bothDen: 0 };
      t.n++;
      const up = i > 0 ? cuiOf(cs[i - 1]) : null, dn = i < cs.length - 1 ? cuiOf(cs[i + 1]) : null;
      if (up === cu || dn === cu) t.one++;
      if (up != null && dn != null) { t.bothDen++; if (up === cu && dn === cu) t.both++; }
    }
  }
  console.log('\n### 中段に同じ軸が自分以外で k 枚あるときの成立率（全方策・全スピン）\n');
  console.log('| 同軸 k 枚 | 観測 | 上下どちらかが同軸 | 上下の両方が同軸 |');
  console.log('| --- | --- | --- | --- |');
  for (const k of [0, 1, 2, 3]) { const t = byK[k]; if (!t) continue;
    console.log(`| ${k === 3 ? '3枚以上' : k + '枚'} | ${t.n} | ${(100 * t.one / t.n).toFixed(1)}% | ${t.bothDen ? (100 * t.both / t.bothDen).toFixed(1) + '%' : '—'} |`); }

  console.log('\n### 同じ軸が続いた長さ（1枚＝孤立）\n');
  console.log('| 方策 | 1 | 2 | 3 | 4 | 5以上 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const p of POL) { const t = st[p]; if (!t.spins) continue;
    const tot = Object.values(t.run).reduce((a, b) => a + b, 0);
    const g = k => (100 * (t.run[k] || 0) / tot).toFixed(1) + '%';
    const g5 = (100 * Object.entries(t.run).filter(([k]) => +k >= 5).reduce((a, b) => a + b[1], 0) / tot).toFixed(1) + '%';
    console.log(`| ${POL_JA[p]} | ${g(1)} | ${g(2)} | ${g(3)} | ${g(4)} | ${g5} |`); }
}
