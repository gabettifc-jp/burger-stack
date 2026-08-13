// 測定 M2 の集計（開発用）。tools/m2-measure.mjs が吐いた JSONL を読んで、
//   測定指示書 M2 §1 の判定（B1〜B5）と §4 の集計を出す。基準は走らせる前に固定してある。
//
// 使い方:
//   node tools/m2-report.mjs tools/out/m2-P4.jsonl tools/out/m2-P8.jsonl tools/out/m2-Q4.jsonl tools/out/m2-Q8.jsonl

import { readFileSync } from 'fs';

const files = process.argv.slice(2);
const runs = [];
for (const f of files){
  for (const line of readFileSync(f, 'utf8').split('\n')){
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch(e){ console.log('パースできない行: ' + f); }
  }
}
const RO = ['nami','jou','tokujou','kiwami'];
const RJ = { nami:'並', jou:'上', tokujou:'特上', kiwami:'極' };
const AX = ['wa','chuka','kaisen','kokyu','agemono','none'];
const AJ = { wa:'和', chuka:'中華', kaisen:'海鮮', kokyu:'高級', agemono:'揚げ物', none:'無印' };

const med = a => { if (!a.length) return null; const s = a.slice().sort((x,y)=>x-y); const i = Math.floor(s.length/2);
  return s.length % 2 ? s[i] : (s[i-1] + s[i]) / 2; };
const pctf = (n, d) => d ? (n/d*100).toFixed(1) + '%' : '—';
const conds = [...new Set(runs.map(r => r.policy + '/m' + r.m))].sort();
const byCond = c => runs.filter(r => r.policy + '/m' + r.m === c);

// 終了の種類を分類する。
//   1営業日目で終了＝家賃を1回も払えずに終わった／2営業日目で終了＝1回払ったが2回目を払えなかった
const kindOf = r => {
  if (r.stopped) return 'stop';
  if (r.ended === 'broke') return (r.rentsPaid || 0) >= 1 ? 'die2' : 'die1';
  if (r.spinsDone >= 10 && (r.rentsPaid || 0) >= 2) return 'full';
  return 'other';
};

console.log('===== 本数 =====');
console.log('総ラン数: ' + runs.length + '（条件 ' + conds.length + ' × シード ' + (runs.length / conds.length) + '）');
console.log('シード: ' + Math.min(...runs.map(r=>r.seed)) + '〜' + Math.max(...runs.map(r=>r.seed)));

console.log('\n===== 生存の分布 =====');
console.log('条件     | 1営業日目で終了 | 2営業日目で終了 | 10スピン到達 | 停止 | その他');
for (const c of conds){
  const rs = byCond(c), k = rs.map(kindOf);
  const cnt = t => k.filter(x => x === t).length;
  console.log(c.padEnd(8) + ' | ' + String(cnt('die1')).padStart(15) + ' | ' + String(cnt('die2')).padStart(15)
            + ' | ' + String(cnt('full')).padStart(12) + ' | ' + String(cnt('stop')).padStart(4) + ' | ' + cnt('other'));
}
{
  const k = runs.map(kindOf), n = runs.length;
  const d1 = k.filter(x=>x==='die1').length, d2 = k.filter(x=>x==='die2').length;
  const survived1 = n - d1 - k.filter(x=>x==='stop').length;
  console.log('\n全体: 1営業日目で落ちた ' + d1 + '/' + n + ' = ' + pctf(d1, n));
  console.log('      1営業日目を越えた ' + survived1 + '本のうち 2営業日目で落ちた ' + d2 + ' = ' + pctf(d2, survived1));
}

// ── B1〜B5 の判定 ────────────────────────────────────────────────
console.log('\n===== §1 の判定（基準は測定前に固定・緩めない）=====');
const verdicts = [];
{
  const k = runs.map(kindOf), n = runs.length;
  const d1 = k.filter(x=>x==='die1').length;
  const r1 = d1 / n;
  const v = r1 < 0.20 ? '◯' : (r1 >= 0.50 ? '✕' : '判断保留');
  verdicts.push(['B1', '初日の壁', v, pctf(d1, n) + '（' + d1 + '/' + n + '）', '20%未満◯ / 50%以上✕']);
}
{
  const k = runs.map(kindOf);
  const stop = k.filter(x=>x==='stop').length;
  const surv = runs.length - k.filter(x=>x==='die1').length - stop;
  const d2 = k.filter(x=>x==='die2').length;
  const r2 = surv ? d2 / surv : 0;
  const v = surv === 0 ? '判断保留' : (r2 < 0.10 ? '◯' : (r2 >= 0.30 ? '✕' : '判断保留'));
  verdicts.push(['B2', '2営業日目の壁', v, pctf(d2, surv) + '（' + d2 + '/' + surv + '）', '10%未満◯ / 30%以上✕']);
}
// B3：1営業日目の提示のレアリティ
const rarOf = (day) => {
  const t = { nami:0, jou:0, tokujou:0, kiwami:0 }; let n = 0;
  for (const r of runs) for (const o of r.offers || []) if (o.day === day)
    for (const c of o.shown){ if (t[c.rar] !== undefined){ t[c.rar]++; n++; } }
  return { t, n };
};
const axOf = (day) => {
  const t = {}; let n = 0;
  for (const r of runs) for (const o of r.offers || []) if (o.day === day)
    for (const c of o.shown){ const cu = c.cuisine || 'none'; t[cu] = (t[cu]||0)+1; n++; }
  return { t, n };
};
{
  const { t, n } = rarOf(1);
  const namiOK = n && (t.nami / n) >= 0.70, kiwOK = t.kiwami === 0;
  const v = (namiOK && kiwOK) ? '◯' : '✕';
  verdicts.push(['B3', 'レアリティの実測（1営業日目）', v,
    '並 ' + pctf(t.nami, n) + ' / 極 ' + t.kiwami + '枚（' + n + '枚中）', '並70%以上かつ極0枚で◯']);
}
// B4：寄せることの価値（2営業日目終了時点の累計得点で Q が P を上回るか）
const cumOf = (policy, m) => runs.filter(r => r.policy === policy && (m == null || r.m === m) && kindOf(r) === 'full').map(r => r.cum);
{
  const P = cumOf('P'), Q = cumOf('Q');
  const mp = med(P), mq = med(Q);
  const v = (mp == null || mq == null) ? '判断保留' : (mq > mp ? '◯' : '✕');
  verdicts.push(['B4', '寄せることの価値', v,
    'P 中央値 ¥' + mp + '（n=' + P.length + '）／Q 中央値 ¥' + mq + '（n=' + Q.length + '）',
    'Q が P を上回れば◯']);
}
// B5：m の差
{
  const a = runs.filter(r => r.m === 4 && kindOf(r) === 'full').map(r => r.cum);
  const b = runs.filter(r => r.m === 8 && kindOf(r) === 'full').map(r => r.cum);
  const ma = med(a), mb = med(b);
  let v = '判断保留', note = '';
  if (ma != null && mb != null){
    const diff = Math.abs(ma - mb) / Math.max(ma, mb);
    note = 'm=4 中央値 ¥' + ma + '（n=' + a.length + '）／m=8 中央値 ¥' + mb + '（n=' + b.length + '）／差 ' + (diff*100).toFixed(1) + '%';
    v = diff >= 0.10 ? '効いている' : (diff < 0.03 ? '効いていない' : '判断保留');
  }
  verdicts.push(['B5', 'm の差', v, note, '10%以上で効いている / 3%未満で効いていない']);
}
for (const [id, what, v, num, crit] of verdicts)
  console.log(id + ' ' + what + '\n    判定: ' + v + '\n    数字: ' + num + '\n    基準: ' + crit);

// ── B6：1営業日目の5スピンぶんの基礎点合計と得点の中央値 ─────────────────
console.log('\n===== B6：1営業日目の盤面の基礎点合計（バンズを除く）と得点 =====');
console.log('スピン | 基礎点合計の中央値 | 得点の中央値 | 段数の中央値 | n');
for (let sp = 1; sp <= 5; sp++){
  const rows = [];
  for (const r of runs) for (const s of r.spins || []) if (s.spin === sp) rows.push(s);
  console.log('  ' + sp + '   | ' + String(med(rows.map(x=>x.baseNoBun))).padStart(18)
            + ' | ' + String(med(rows.map(x=>x.total))).padStart(12)
            + ' | ' + String(med(rows.map(x=>x.tiers))).padStart(12) + ' | ' + rows.length);
}
{
  const all = [];
  for (const r of runs) for (const s of r.spins || []) if (s.day === 1) all.push(s);
  console.log('1営業日目まとめ: 基礎点合計の中央値 ' + med(all.map(x=>x.baseNoBun))
            + ' / 得点の中央値 ' + med(all.map(x=>x.total)) + ' / n=' + all.length);
  // 参考：6〜10スピン（2営業日目）
  const d2 = [];
  for (const r of runs) for (const s of r.spins || []) if (s.day === 2) d2.push(s);
  if (d2.length) console.log('2営業日目まとめ: 基礎点合計の中央値 ' + med(d2.map(x=>x.baseNoBun))
            + ' / 得点の中央値 ' + med(d2.map(x=>x.total)) + ' / n=' + d2.length);
}

// ── B7：1営業日目の家賃後の残金と、買えたもの ────────────────────────────
console.log('\n===== B7：1営業日目の家賃後の残金と買い物 =====');
{
  // 店は家賃を払った直後に出るので、そこでの daysSurvived はもう繰り上がっている。
  //   日付ラベルでは絞れないので「最初の来店＝1営業日目の家賃後の店」として1件目を取る。
  //   10スピン到達で打ち切るため2回目の来店は発生しない（買い物はすべてこの1回ぶん）。
  const monies = [], boughtAll = [], affAll = [];
  for (const r of runs){
    const a = (r.affordable || [])[0];
    if (a) { monies.push(a.money); affAll.push(a); }
    for (const b of r.buys || []) boughtAll.push(b);
  }
  if (!monies.length){ console.log('店に到達したランが無い'); }
  console.log('家賃後の残金の中央値: ¥' + med(monies) + '（n=' + monies.length + '）');
  { const s2 = monies.slice().sort((a,b)=>a-b);
    const q = f => s2[Math.min(s2.length-1, Math.floor(f*s2.length))];
    console.log('  分布: min ¥' + s2[0] + ' / p25 ¥' + q(0.25) + ' / 中央 ¥' + med(s2) + ' / p75 ¥' + q(0.75) + ' / max ¥' + s2[s2.length-1]);
    console.log('  ¥100（並のカード1枚）に届かなかったラン: ' + s2.filter(x=>x<100).length + '/' + s2.length); }
  const perRun = {};
  for (const b of boughtAll) perRun[b.name] = (perRun[b.name]||0) + 1;
  const nBuy = boughtAll.length;
  console.log('実際に買ったもの（カードのみ・方策の範囲）: 合計 ' + nBuy + '枚 / 1ランあたり中央値 '
            + med(runs.map(r => (r.buys||[]).length)) + '枚');
  console.log('  金額: 中央値 ¥' + med(boughtAll.map(b=>b.cost)) + ' / 合計 ¥' + boughtAll.reduce((s,b)=>s+b.cost,0));
  const top = Object.entries(perRun).sort((a,b)=>b[1]-a[1]).slice(0,10);
  console.log('  よく買われた札: ' + top.map(([k,v])=>k+'×'+v).join(' , '));
  // 買えたはずのもの（所持金で足りたもの）の内訳
  const kinds = { card:0, artifact:0, action:0 };
  const actNames = {};
  for (const a of affAll){
    kinds.card += a.cards.length; kinds.artifact += a.arts.length; kinds.action += a.actions.length;
    for (const x of a.actions) actNames[x.name] = (actNames[x.name]||0) + 1;
  }
  console.log('買えたはずのもの（1営業日目の店で所持金が足りたもの・のべ）:');
  console.log('  カード ' + kinds.card + ' / アーティファクト ' + kinds.artifact + ' / 枠など ' + kinds.action);
  console.log('  枠などの内訳: ' + Object.entries(actNames).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+'×'+v).join(' , '));
}

// ── レアリティと軸の分布 ────────────────────────────────────────────
console.log('\n===== 提示のレアリティと軸の分布 =====');
for (const day of [1, 2]){
  const { t, n } = rarOf(day);
  if (!n) continue;
  console.log(day + '営業日目（' + n + '枚）: ' + RO.map(k => RJ[k] + ' ' + pctf(t[k], n)).join(' / '));
}
for (const day of [1, 2]){
  const { t, n } = axOf(day);
  if (!n) continue;
  console.log(day + '営業日目の軸（' + n + '枚）: ' + AX.filter(c=>t[c]).map(c => AJ[c] + ' ' + pctf(t[c], n)).join(' / '));
}

// ── 主軸が決まるまでのスピン数 ──────────────────────────────────────
console.log('\n===== 主軸が決まるまでのスピン数 =====');
{
  const at = [];
  for (const r of runs){
    const seq = r.mainSeq || [];
    if (!seq.length) continue;
    const last = seq[seq.length - 1];
    if (last === 'none'){ at.push(null); continue; }
    let k = seq.length - 1;
    while (k > 0 && seq[k-1] === last) k--;
    at.push(k + 1);                     // 1始まり：ここから最後まで主軸が変わらない
  }
  const ok = at.filter(x => x != null);
  console.log('中央値: ' + med(ok) + 'スピン目（n=' + ok.length + '／最後まで主軸が無かったラン ' + (at.length - ok.length) + '本）');
  const hist = {};
  for (const x of ok) hist[x] = (hist[x]||0)+1;
  console.log('分布: ' + Object.keys(hist).sort((a,b)=>a-b).map(k=>k+'スピン目×'+hist[k]).join(' , '));
  // 最終的な主軸の分布
  const mains = {};
  for (const r of runs) mains[r.main] = (mains[r.main]||0)+1;
  console.log('10スピン時点の主軸: ' + Object.entries(mains).sort((a,b)=>b[1]-a[1]).map(([k,v])=>(AJ[k]||k)+'×'+v).join(' , '));
}

// ── 条件ごとの得点 ────────────────────────────────────────────────
console.log('\n===== 条件ごとの累計得点（10スピン到達したランのみ）=====');
console.log('条件     |   n | 中央値 |   平均 |    最小 |    最大');
for (const c of conds){
  const rs = byCond(c).filter(r => kindOf(r) === 'full').map(r => r.cum);
  if (!rs.length){ console.log(c.padEnd(8) + ' |   0 | — | — | — | —'); continue; }
  const mean = rs.reduce((s,x)=>s+x,0)/rs.length;
  console.log(c.padEnd(8) + ' | ' + String(rs.length).padStart(3) + ' | ¥' + String(med(rs)).padStart(5)
            + ' | ¥' + String(Math.round(mean)).padStart(5) + ' | ¥' + String(Math.min(...rs)).padStart(5)
            + ' | ¥' + String(Math.max(...rs)).padStart(5));
}
console.log('\n条件ごとの10スピン時点のデッキ枚数・主軸の枚数');
for (const c of conds){
  const rs = byCond(c);
  const dn = med(rs.map(r=>r.deckN));
  const mainN = med(rs.map(r => (r.axis && r.main !== 'none') ? (r.axis[r.main]||0) : 0));
  console.log(c.padEnd(8) + ' | デッキ ' + dn + '枚 / 主軸のカード ' + mainN + '枚');
}

// ── 停止・エラー ──────────────────────────────────────────────────
console.log('\n===== 停止・エラー =====');
{
  const st = runs.filter(r => r.stopped);
  const er = runs.filter(r => (r.errs||[]).length);
  const other = runs.filter(r => kindOf(r) === 'other');
  if (!st.length && !er.length && !other.length) console.log('なし（停止0・コンソールエラー0・分類不能0）');
  for (const r of st) console.log('停止: ' + r.policy + ' m=' + r.m + ' seed' + r.seed + ' → ' + JSON.stringify(r.stopped));
  for (const r of er) console.log('エラー: ' + r.policy + ' m=' + r.m + ' seed' + r.seed + ' → ' + r.errs.slice(0,3).join(' | '));
  for (const r of other) console.log('分類不能: ' + r.policy + ' m=' + r.m + ' seed' + r.seed
    + ' ended=' + r.ended + ' spins=' + r.spinsDone + ' rents=' + r.rentsPaid);
}
{
  const fb = runs.reduce((s,r)=>s+(r.fallbacks||0), 0);
  console.log('レアリティのフォールバック（のべ）: ' + fb + '件');
}
