/* M1 の集計。tools/out/*.jsonl を読んで §1 の判定と §4 の表を出す。ゲームには触らない。 */
import fs from 'fs';
const OUT = '/home/user/burger-stack/tools/out';
const load = f => { const p = `${OUT}/${f}`; return fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
const G5 = load('m1-goal5.jsonl'), G10 = load('m1-goal10.jsonl'), C3R = load('m1-goal5-c3.jsonl');
const POL = ['a','b','c','d','e'];
const PJA = { a:'a 左端固定', b:'b 貪欲(段数)', c:'c 単軸寄せ', d:'d 薄く保つ', e:'e 無作為' };

const med = a => { if (!a.length) return null; const s = a.slice().sort((x,y)=>x-y); const m = s.length>>1;
  return s.length%2 ? s[m] : Math.round((s[m-1]+s[m])/2); };
const pct = (n,d) => d ? Math.round(n/d*1000)/10 : 0;
const yen = n => n==null ? '—' : '¥' + n.toLocaleString('en-US');
const by = (rs, p) => rs.filter(r => r.policy === p);
const pad = (s,n) => String(s).padEnd(n, ' ');
const padL = (s,n) => String(s).padStart(n, ' ');
const cum = r => (r.plog && r.plog.summary) ? (r.plog.summary.finalCum || 0) : 0;

console.log('══════════ 実際に回した本数 ══════════');
console.log(`dayGoal 5 : ${G5.length} ラン（方策 ${POL.join(',')} × シード 1001〜${1000+G5.length/5}）`);
console.log(`dayGoal 10: ${G10.length} ラン（方策 d,e × シード 1001〜1010）`);
console.log(`C3 専用   : ${C3R.length} ラン（方策 a・北京ダックとほたてを1枚ずつ足した）`);
console.log(`合計 ${G5.length + G10.length + C3R.length} ラン`);

/* ── 停止・エラー ── */
console.log('\n══════════ 停止・詰み・エラー ══════════');
const bad = [...G5, ...G10, ...C3R].filter(r => r.outcome === 'stalled' || r.outcome === 'error' || (r.errs && r.errs.length));
if (!bad.length) console.log('なし（停止0件・コンソールエラー0件・ページエラー0件／全170ラン）');
else for (const r of bad) console.log(` ${r.policy}/${r.seed} goal${r.dayGoal} → ${r.outcome} ${JSON.stringify(r.stalled||'')} ${JSON.stringify((r.errs||[]).slice(0,2))}`);

/* ══════════ C1 生存率 ══════════ */
console.log('\n══════════ C1 生存率（dayGoal 5） ══════════');
console.log(pad('方策',14)+padL('完走',5)+padL('本数',5)+padL('完走率',8)+'   落ちた営業日の分布 [0,1,2,3,4]');
const surv = {};
for (const p of POL){
  const rs = by(G5,p), cl = rs.filter(r=>r.outcome==='cleared').length;
  const dist = [0,1,2,3,4].map(d => rs.filter(r=>r.outcome!=='cleared' && (r.fin?r.fin.days:0)===d).length);
  surv[p] = { cl, n: rs.length, rate: pct(cl, rs.length), dist };
  console.log(pad(PJA[p],14)+padL(cl,5)+padL(rs.length,5)+padL(surv[p].rate+'%',8)+'   '+JSON.stringify(dist));
}
const c1 = surv.a.rate;
console.log(`\n→ C1 は方策 a（左端固定）の完走率で判定：${surv.a.cl}/${surv.a.n} = ${c1}%`);
console.log(`   判定: ${c1>=50 ? '◯（50%以上）' : c1<30 ? '✕（30%未満）' : '判断保留（30〜50%）'}`);

/* ══════════ C2 初日の壁 ══════════ */
console.log('\n══════════ C2 初日の壁（1営業日目の5スピン合計 < ¥300） ══════════');
let wallN = 0, wallD = 0; const day1 = [];
for (const r of G5){
  const sp = (r.plog && r.plog.spins) ? r.plog.spins.filter(s => s.day === 1) : [];
  if (!sp.length) continue;
  const sum = sp.reduce((a,s)=>a+(s.score||0),0);
  day1.push(sum); wallD++; if (sum < 300) wallN++;
}
console.log(`1営業日目の売上合計：中央値 ${yen(med(day1))} ／ 最小 ${yen(Math.min(...day1))} ／ 最大 ${yen(Math.max(...day1))}`);
console.log(`家賃¥300 に届かなかったラン：${wallN}/${wallD} = ${pct(wallN,wallD)}%`);
for (const p of POL){
  const rs = by(G5,p).map(r => (r.plog&&r.plog.spins?r.plog.spins.filter(s=>s.day===1):[]).reduce((a,s)=>a+(s.score||0),0)).filter(x=>x>0);
  console.log(`  ${pad(PJA[p],14)} 中央値 ${padL(yen(med(rs)),9)}  未達 ${rs.filter(x=>x<300).length}/${rs.length}`);
}
const c2 = pct(wallN,wallD);
console.log(`→ 判定: ${c2<20 ? '◯（20%未満）' : c2>=50 ? '✕（50%以上）' : '判断保留（20〜50%）'}`);

/* ══════════ C3 希釈 ══════════ */
console.log('\n══════════ C3 希釈（北京ダック・ほたてを1枚だけ持つラン・25スピン中の盤面到達） ══════════');
console.log(pad('シード',8)+padL('スピン',7)+padL('北京ダック',11)+padL('ほたて',9)+padL('最終デッキ',11)+padL('具材山',8));
const hits = { '北京ダック':[], 'ほたて':[] };
for (const r of C3R){
  const sp = r.spins||[];
  const h1 = sp.filter(s=>s.stack.includes('北京ダック')).length, h2 = sp.filter(s=>s.stack.includes('ほたて')).length;
  hits['北京ダック'].push(h1); hits['ほたて'].push(h2);
  const lastIng = sp.length ? sp[sp.length-1].piles.ingredient : 0;
  console.log(pad(r.seed,8)+padL(sp.length,7)+padL(h1,11)+padL(h2,9)+padL(r.fin?r.fin.deck.length:0,11)+padL(lastIng,8));
}
const only25 = C3R.filter(r=>(r.spins||[]).length>=25);
const h25 = { '北京ダック': only25.map(r=>r.spins.filter(s=>s.stack.includes('北京ダック')).length),
              'ほたて':     only25.map(r=>r.spins.filter(s=>s.stack.includes('ほたて')).length) };
console.log(`\n25スピン到達した ${only25.length} ラン：北京ダック 中央値 ${med(h25['北京ダック'])}回 ／ ほたて 中央値 ${med(h25['ほたて'])}回`);
const c3v = med([...(h25['北京ダック']||[]), ...(h25['ほたて']||[])]);
console.log(`2枚あわせた中央値 ${c3v} 回`);
console.log(`→ 判定: ${c3v>=10 ? '◯（10回以上）' : c3v<5 ? '✕（5回未満）' : '判断保留（5〜10回）'}`);
// 具材山の枚数と到達率の対応
console.log('\n希釈の実測（具材山の枚数 → その状態のスピンでの到達率。全C3ラン合算）');
const bins = {};
for (const r of C3R) for (const s of (r.spins||[])){
  const k = Math.min(30, Math.max(3, s.piles.ingredient)); const b = Math.floor(k/3)*3;
  bins[b] = bins[b] || { n:0, pk:0, ht:0, slots:[] };
  bins[b].n++; if (s.stack.includes('北京ダック')) bins[b].pk++; if (s.stack.includes('ほたて')) bins[b].ht++;
  bins[b].slots.push(s.tiersCfg.i);
}
console.log(pad('具材山',10)+padL('スピン数',9)+padL('具材枠(中)',11)+padL('北京ダック',11)+padL('ほたて',9)+padL('理論値',9));
for (const b of Object.keys(bins).map(Number).sort((x,y)=>x-y)){
  const v = bins[b]; const slots = med(v.slots);
  console.log(pad(`${b}〜${b+2}枚`,10)+padL(v.n,9)+padL(slots,11)+padL(pct(v.pk,v.n)+'%',11)+padL(pct(v.ht,v.n)+'%',9)+padL(Math.round(Math.min(1,slots/(b+1))*1000)/10+'%',9));
}

/* ══════════ C4 店の吸収力 ══════════ */
console.log('\n══════════ C4 店の吸収力（8営業日目以降の来店で使えた割合・dayGoal 10） ══════════');
const late = [];
for (const r of G10) for (const v of (r.shopVisits||[])) if (v.day >= 8) late.push(v);   // v.day＝その家賃を払い終えた営業日の番号
console.log(`8営業日目以降の来店 ${late.length} 回`);
if (late.length){
  const rates = late.map(v => v.before>0 ? v.spent/v.before : 0);
  console.log(`  来店時の所持金 中央値 ${yen(med(late.map(v=>v.before)))} ／ 使えた額 中央値 ${yen(med(late.map(v=>v.spent)))}`);
  console.log(`  使えた割合 中央値 ${Math.round(med(rates.map(x=>Math.round(x*1000)))/10)}%`);
  const c4 = med(rates.map(x=>Math.round(x*1000)))/10;
  console.log(`→ 判定: ${c4>=30 ? '◯（30%以上）' : c4<10 ? '✕（10%未満）' : '判断保留（10〜30%）'}`);
}
// dayGoal 5 の全来店も参考に
console.log('\n金の流れ（N営業日の家賃を払った直後の来店。残金＝家賃を払ったあとの所持金）');
const flow = (rs, label, maxd) => { console.log(`  ${label}`);
  console.log('  '+pad('家賃を払った後',16)+padL('来店',6)+padL('残金(中)',11)+padL('使えた額(中)',13)+padL('使えた割合',11)+padL('買った点数(中)',15));
  for (let d=1; d<=maxd; d++){
    const vs = rs.flatMap(r=>(r.shopVisits||[]).filter(v=>v.day===d));
    if (!vs.length) continue;
    const rates = vs.map(v=>v.before>0?Math.round(v.spent/v.before*1000):0);
    console.log('  '+pad(d+'営業日の後',16)+padL(vs.length,6)+padL(yen(med(vs.map(v=>v.before))),11)+padL(yen(med(vs.map(v=>v.spent))),13)+padL(med(rates)/10+'%',11)+padL(med(vs.map(v=>(v.acts||[]).length)),15));
  } };
flow(G5, 'dayGoal 5（150ラン）', 5);
flow(G10, 'dayGoal 10（20ラン・方策 d,e）', 10);

/* ══════════ C5 ソース枠 ══════════ */
console.log('\n══════════ C5 ソース枠の値段（1回目 ¥2,000 が買われる営業日） ══════════');
const sauceBuys = [];
for (const rs of [G5, G10]) for (const r of rs){
  const bs = (r.plog&&r.plog.spins) ? r.plog.spins.flatMap(s=>(s.bought||[]).filter(b=>b.name==='sauces').map(b=>({day:s.day, cost:b.cost}))) : [];
  for (const b of bs) sauceBuys.push({ policy:r.policy, goal:r.dayGoal, seed:r.seed, ...b });
}
const first = sauceBuys.filter(b=>b.cost===2000), second = sauceBuys.filter(b=>b.cost===12000);
console.log(`1回目（¥2,000）を買った回数 ${first.length} ／ 2回目（¥12,000）${second.length}`);
if (first.length){
  console.log(`  買われた営業日：${JSON.stringify(first.map(b=>b.day).sort((x,y)=>x-y))}`);
  console.log(`  中央値 ${med(first.map(b=>b.day))}営業日目`);
  console.log(`  方策の内訳：${JSON.stringify(first.reduce((a,b)=>{a[b.policy]=(a[b.policy]||0)+1;return a;},{}))}`);
}
if (second.length) console.log(`  2回目の営業日：${JSON.stringify(second.map(b=>b.day).sort((x,y)=>x-y))} 中央値 ${med(second.map(b=>b.day))}`);
const c5 = first.length ? med(first.map(b=>b.day)) : null;
console.log(`→ 判定: ${c5==null ? '✕（一度も買われない）' : (c5>=3&&c5<=4) ? '◯（中央値 3〜4営業日目）' : c5>=6 ? '✕（6営業日目以降）' : '判断保留（'+c5+'営業日目）'}`);
// 具材枠と比べる
const ingBuys = G5.flatMap(r=>(r.plog&&r.plog.spins?r.plog.spins.flatMap(s=>(s.bought||[]).filter(b=>b.name==='ingredients')):[]));
console.log(`  参考：具材枠の購入は dayGoal 5 の150ランで ${ingBuys.length} 回（ソース枠は ${G5.flatMap(r=>(r.plog&&r.plog.spins?r.plog.spins.flatMap(s=>(s.bought||[]).filter(b=>b.name==='sauces')):[])).length} 回）`);

/* ══════════ C6 軸の収束 ══════════ */
console.log('\n══════════ C6 軸の収束（完走ランの最終デッキで最多軸の占有率） ══════════');
console.log(pad('方策',14)+padL('完走',5)+padL('最多軸率(中)',13)+padL('最終デッキ(中)',15)+'  最多軸の分布');
const allShare = [];
for (const p of POL){
  const rs = by(G5,p).filter(r=>r.outcome==='cleared' && r.fin);
  const sh = [], tops = {};
  for (const r of rs){
    const ax = r.fin.axis, tot = Object.values(ax).reduce((a,b)=>a+b,0);
    let top = null, tn = -1; for (const k of Object.keys(ax)) if (ax[k] > tn){ tn = ax[k]; top = k; }
    sh.push(Math.round(tn/tot*1000)); tops[top] = (tops[top]||0)+1; allShare.push(Math.round(tn/tot*1000));
  }
  if (!rs.length) { console.log(pad(PJA[p],14)+padL(0,5)+'  （完走なし）'); continue; }
  console.log(pad(PJA[p],14)+padL(rs.length,5)+padL(med(sh)/10+'%',13)+padL(med(rs.map(r=>r.fin.deck.length)),15)+'  '+JSON.stringify(tops));
}
const c6 = med(allShare)/10;
console.log(`\n全完走ランの最多軸率 中央値 ${c6}%`);
console.log(`→ 判定: ${c6>=50 ? '◯（50%以上・収束している）' : c6<30 ? '✕（30%未満・軸が決まらない）' : '判断保留（30〜50%）'}`);

/* ══════════ C7 貪欲方策 ══════════ */
console.log('\n══════════ C7 貪欲方策（段数買い）の累計を左端固定と比べる ══════════');
console.log(pad('方策',14)+padL('累計(中)',13)+padL('累計(最大)',13)+padL('最終具材枠(中)',15)+padL('最終ソース枠(中)',16));
const cums = {};
for (const p of POL){
  const rs = by(G5,p).filter(r=>r.outcome==='cleared');
  cums[p] = med(rs.map(cum));
  console.log(pad(PJA[p],14)+padL(yen(cums[p]),13)+padL(yen(Math.max(0,...rs.map(cum))),13)
    +padL(med(rs.map(r=>r.fin.ings)),15)+padL(med(rs.map(r=>r.fin.sauces)),16));
}
const ratio = cums.a ? Math.round(cums.b/cums.a*100)/100 : null;
console.log(`\nb / a = ${ratio}`);
console.log(`→ 判定: ${ratio>=2 ? '✕（2倍以上・段数買いが依然として最有力）' : ratio<1.2 ? '◯（1.2倍未満）' : '判断保留（1.2〜2倍）'}`);

/* ══════════ C8 軸の偏り ══════════ */
console.log('\n══════════ C8 軸の偏り（完走ランを最多軸で分けた累計中央値） ══════════');
const CJ = { none:'無印', wa:'和', chuka:'中華', kaisen:'海鮮', kokyu:'高級', agemono:'揚げ物' };
const byAxis = {};
for (const r of G5.filter(r=>r.outcome==='cleared' && r.fin)){
  const ax = r.fin.axis; let top=null, tn=-1;
  for (const k of Object.keys(ax)) if (ax[k]>tn){ tn=ax[k]; top=k; }
  (byAxis[top] = byAxis[top] || []).push(cum(r));
}
console.log(pad('主軸',10)+padL('完走数',8)+padL('累計(中)',13)+padL('累計(最大)',13));
const axMed = [];
for (const k of Object.keys(byAxis).sort((x,y)=>med(byAxis[y])-med(byAxis[x]))){
  console.log(pad(CJ[k]||k,10)+padL(byAxis[k].length,8)+padL(yen(med(byAxis[k])),13)+padL(yen(Math.max(...byAxis[k])),13));
  if (byAxis[k].length >= 3) axMed.push({ k, m: med(byAxis[k]), n: byAxis[k].length });
}
if (axMed.length >= 2){
  const hi = axMed[0], lo = axMed[axMed.length-1];
  const c8 = Math.round(hi.m/lo.m*100)/100;
  console.log(`\n最強 ${CJ[hi.k]} ${yen(hi.m)} / 最弱 ${CJ[lo.k]} ${yen(lo.m)} = ${c8} 倍（3ラン以上ある軸だけで比較）`);
  console.log(`→ 判定: ${c8<=3 ? '◯（3倍以内）' : c8>=5 ? '✕（5倍以上）' : '判断保留（3〜5倍）'}`);
} else console.log('→ 判定: 判断保留（3ラン以上ある主軸が2つ未満）');

/* ══════════ 生存曲線 ══════════ */
console.log('\n══════════ 生存曲線（何営業日目まで生きたか・dayGoal 5） ══════════');
console.log(pad('方策',14)+['0日','1日','2日','3日','4日','完走'].map(x=>padL(x,6)).join('')+padL('中央値',8));
for (const p of POL){
  const rs = by(G5,p);
  const row = [0,1,2,3,4].map(d => rs.filter(r=>r.outcome!=='cleared' && (r.fin?r.fin.days:0)===d).length);
  const cl = rs.filter(r=>r.outcome==='cleared').length;
  console.log(pad(PJA[p],14)+[...row,cl].map(x=>padL(x,6)).join('')+padL(med(rs.map(r=>r.outcome==='cleared'?5:(r.fin?r.fin.days:0))),8));
}
console.log('\ndayGoal 10（方策 d,e × 10シード）');
console.log(pad('方策',14)+padL('完走',6)+padL('本数',6)+padL('中央営業日',12)+padL('累計(中)',13)+padL('最終デッキ(中)',15));
for (const p of ['d','e']){
  const rs = by(G10,p); if (!rs.length) continue;
  const cl = rs.filter(r=>r.outcome==='cleared');
  console.log(pad(PJA[p],14)+padL(cl.length,6)+padL(rs.length,6)
    +padL(med(rs.map(r=>r.outcome==='cleared'?10:(r.fin?r.fin.days:0))),12)
    +padL(yen(med(cl.map(cum))),13)+padL(med(cl.map(r=>r.fin.deck.length)),15));
}

/* ══════════ デッキ枚数の推移 ══════════ */
console.log('\n══════════ デッキ枚数の推移（スピン数 → デッキ枚数の中央値・dayGoal 5） ══════════');
console.log(pad('スピン',8)+POL.map(p=>padL(p,7)).join('')+'   ← 方策');
for (const n of [1,5,10,15,20,25]){
  const row = POL.map(p => { const v = by(G5,p).map(r=>(r.spins||[])[n-1]).filter(Boolean).map(s=>s.deckN); return v.length? med(v) : '—'; });
  console.log(pad(n,8)+row.map(x=>padL(x,7)).join(''));
}
console.log('\n具材山だけの推移（同じ形式）');
for (const n of [1,5,10,15,20,25]){
  const row = POL.map(p => { const v = by(G5,p).map(r=>(r.spins||[])[n-1]).filter(Boolean).map(s=>s.piles.ingredient); return v.length? med(v) : '—'; });
  console.log(pad(n,8)+row.map(x=>padL(x,7)).join(''));
}
console.log('\n具材枠（tiers.ingredients）の推移');
for (const n of [1,5,10,15,20,25]){
  const row = POL.map(p => { const v = by(G5,p).map(r=>(r.spins||[])[n-1]).filter(Boolean).map(s=>s.tiersCfg.i); return v.length? med(v) : '—'; });
  console.log(pad(n,8)+row.map(x=>padL(x,7)).join(''));
}

/* ══════════ カードの寄与 ══════════ */
console.log('\n══════════ カードの寄与（全dayGoal5ラン合算） ══════════');
const card = {};
const allScores = [];
for (const r of G5) for (const s of (r.spins||[])){
  allScores.push(s.total);
  const on = new Set(s.stack);
  for (const nm of on){ (card[nm] = card[nm] || { on:[], off:[] }).on.push(s.total); }
}
// 乗らなかったスピン：そのカードをデッキに持っていたランのスピンだけを母数にする
for (const r of G5){
  const owned = new Set((r.plog&&r.plog.spins?r.plog.spins:[]).length ? [] : []);
  const names = new Set();
  for (const s of (r.spins||[])) for (const nm of s.stack) names.add(nm);
  for (const s of (r.spins||[])){ const on = new Set(s.stack);
    for (const nm of names) if (!on.has(nm)) (card[nm] = card[nm] || { on:[], off:[] }).off.push(s.total); }
}
const rows = Object.entries(card).map(([nm,v]) => ({ nm, n:v.on.length, mOn:med(v.on), mOff:med(v.off),
  d: (med(v.on)!=null && med(v.off)!=null) ? med(v.on)-med(v.off) : null }))
  .filter(x => x.n >= 20);
rows.sort((x,y)=> (y.mOn||0)-(x.mOn||0));
const show = (title, arr) => { console.log('\n'+title);
  console.log(pad('カード',16)+padL('到達回数',9)+padL('乗った時(中)',13)+padL('乗らない時(中)',15)+padL('差',11));
  for (const x of arr) console.log(pad(x.nm,16)+padL(x.n,9)+padL(yen(x.mOn),13)+padL(yen(x.mOff),15)+padL(yen(x.d),11)); };
show(`上位20枚（乗ったスピンの得点中央値・到達20回以上／全 ${rows.length} 枚中）`, rows.slice(0,20));

/* 交絡の補正：カードが手に入る時期と得点の伸びが相関するので、
   「同じ営業日の同じ方策のスピンの中央値」で割った比で並べ直す。1.0 が平均並み。 */
const dayMed = {};
for (const r of G5) for (const s of (r.spins||[])){ const k = r.policy+'/'+s.day; (dayMed[k]=dayMed[k]||[]).push(s.total); }
for (const k of Object.keys(dayMed)) dayMed[k] = med(dayMed[k]) || 1;
const norm = {};
for (const r of G5) for (const s of (r.spins||[])){
  const base = dayMed[r.policy+'/'+s.day] || 1; const ratio = s.total / (base || 1);
  for (const nm of new Set(s.stack)) (norm[nm] = norm[nm] || []).push(ratio);
}
const nrows = Object.entries(norm).map(([nm,v])=>({ nm, n:v.length,
  r: Math.round(med(v.map(x=>Math.round(x*1000)))/10)/100 })).filter(x=>x.n>=20).sort((x,y)=>y.r-x.r);
const showN = (t, arr) => { console.log('\n'+t);
  console.log(pad('カード',16)+padL('到達回数',9)+padL('同営業日比(中)',15));
  for (const x of arr) console.log(pad(x.nm,16)+padL(x.n,9)+padL('×'+x.r.toFixed(2),15)); };
showN('【交絡を補正】上位20枚（同じ営業日・同じ方策の中央値に対する比。1.00＝平均並み）', nrows.slice(0,20));
showN('【交絡を補正】下位20枚（同）', nrows.slice(-20));
show('下位20枚（同）', rows.slice(-20));
console.log(`\n全スピンの得点 中央値 ${yen(med(allScores))}（${allScores.length} スピン）`);

/* ══════════ 3択の出現率（方策 a のみ） ══════════ */
console.log('\n══════════ 3択の出現と取得（方策 a・左端固定＝位置で決まる） ══════════');
const off = {}, tak = {};
for (const r of by(G5,'a')) for (const s of (r.plog&&r.plog.spins?r.plog.spins:[])){
  for (const nm of (s.offered||[])) off[nm] = (off[nm]||0)+1;
  if (s.picked) tak[s.picked] = (tak[s.picked]||0)+1;
}
const offN = Object.values(off).reduce((a,b)=>a+b,0), takN = Object.values(tak).reduce((a,b)=>a+b,0);
console.log(`提示 ${offN} 枚ぶん（${Object.keys(off).length} 種）／ 取得 ${takN} 枚（${Object.keys(tak).length} 種）／ 見送り ${by(G5,'a').flatMap(r=>r.plog&&r.plog.spins?r.plog.spins:[]).filter(s=>s.pickSkipped).length} 回`);
const offRows = Object.entries(off).map(([nm,n])=>({nm,n,t:tak[nm]||0})).sort((x,y)=>y.n-x.n);
console.log('\n提示が多い15枚 / 少ない10枚（提示回数・取られた回数・取得率）');
for (const x of offRows.slice(0,15)) console.log('  '+pad(x.nm,16)+padL(x.n,5)+padL(x.t,5)+padL(pct(x.t,x.n)+'%',8));
console.log('  ...');
for (const x of offRows.slice(-10)) console.log('  '+pad(x.nm,16)+padL(x.n,5)+padL(x.t,5)+padL(pct(x.t,x.n)+'%',8));

/* ══════════ 金の流れ・その他 ══════════ */
console.log('\n══════════ その他の数字 ══════════');
const clAll = G5.filter(r=>r.outcome==='cleared');
console.log(`完走ランの最終所持金 中央値 ${yen(med(clAll.map(r=>r.fin.money)))} ／ 最大 ${yen(Math.max(...clAll.map(r=>r.fin.money)))}`);
console.log(`完走ランの最高バーガー 中央値 ${yen(med(clAll.map(r=>(r.plog.summary.bestBurger||{}).score||0)))}`);
console.log(`完走ランの最終段数 中央値 ${med(clAll.map(r=>r.plog.summary.finalTiers||0))} ／ 最大 ${Math.max(...clAll.map(r=>r.plog.summary.finalTiers||0))}`);
const removed = G5.flatMap(r=>(r.plog&&r.plog.spins?r.plog.spins.flatMap(s=>s.removed||[]):[]));
const byCause = removed.reduce((a,x)=>{a[x.cause]=(a[x.cause]||0)+1;return a;},{});
console.log(`取り除き・廃棄 ${removed.length} 件：${JSON.stringify(byCause)}`);
const arts = G5.flatMap(r=>(r.plog&&r.plog.spins?r.plog.spins.flatMap(s=>(s.bought||[]).filter(b=>b.kind==='artifact')):[]));
console.log(`アーティファクト購入 ${arts.length} 件`);
console.log(`負の得点だったスピン ${allScores.filter(x=>x<0).length} / ${allScores.length}（${pct(allScores.filter(x=>x<0).length, allScores.length)}%）／ 0点 ${allScores.filter(x=>x===0).length} 回`);
