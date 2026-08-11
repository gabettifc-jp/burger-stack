// burger-stack 経済シミュレータ（開発用・ゲーム本体とは別。依存: playwright-core + Chromium）
//
// 目的: 非復元化（#57）以降の構造で、買い物方針ごとに「実際に組まれた段数の分布」を測る。
//       元の m67 economy sim（none / reinvest）に allin（#54）、balanced・card（本測定）を足したもの。
//       結果は LOG.md に貼る。価格スケールはゲームの既定（#59：リロール/取り除き 2.0・他 OFF）をそのまま使う。
//
// 使い方:
//   MODE=full  node tools/economy-allin.mjs   # 3方針×8シード（既定）
//   MODE=probe node tools/economy-allin.mjs   # 1方針1シード（動作確認）
//   環境変数 PW_CHROMIUM で Chromium 実行ファイルを指定可。
//
// 方針（policy）:
//   none     … 店で何も買わない（比較用）
//   reinvest … 中華カードを買い増す（比較用・従来）
//   allin    … 段数スロット優先の全額投入（#54・上振れの端）
//   card     … 段数スロットを買わずカードのみ増やす（単一軸・もう一方の端）
//   balanced … 段数上限とデッキ枚数の少ない方を買う（単一軸・実プレイに近い主方針）。
//              削除：軸が合わないカードを、削除価格が次の段数スロット価格より高くなるまで削る。
//              ※「削除の止め時（削除価格＞段スロット価格で停止）」は測定側の決め打ちであり、
//                これが「実プレイの動き」の定義になってしまう点は自覚のうえで採用（LOG.md に明記）。
//
// 注意: 計測専用の開発ツール。ゲーム本体（得点計算・抽選・乱数・価格）には触れない。既定値も変更しない。

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
  const INIT = {}; for (const k of names) INIT[k] = items[k].count;
  const resetInit = () => { for (const k of names) items[k].count = INIT[k]; };
  const setTiers = (i, s) => { C.params.tiers.ingredients = i; C.params.tiers.sauces = s; };
  const rentBase = C.params.run.rentBase, rentMul = C.params.run.rentMul, every = C.params.run.rentEvery;
  const dayGoal = Math.max(1, Math.round(C.params.run.dayGoal || 5));
  const rentDue = (day) => Math.round(rentBase * Math.pow(rentMul, day));
  const FOCUS = 'chuka';                                   // 寄せる単一軸
  const chukaOf = pile => names.filter(n => items[n].cuisine === FOCUS && items[n].pile === pile);
  const chukaIng = chukaOf('ingredient'), chukaSau = chukaOf('sauce'), chukaBun = chukaOf('bun');
  const rarOf = n => items[n].rar || 'nami';

  // 価格：#59 の要素別スケール（shop.scale.*）をそのまま使う（slot/card OFF・reroll/remove 2.0）。
  const scaleFor = elem => { const s = ((C.params.shop.scale) || {})[elem] || {}; return { on: !!s.onBuy, mul: s.mul || 1.5 }; };
  const priceOf = (base, elem, key, buys) => { const sc = scaleFor(elem); return Math.max(0, Math.round(base * (sc.on ? Math.pow(sc.mul, buys[key] || 0) : 1))); };
  const slotPrice = (key, buys) => priceOf(key === 'ing' ? C.params.shop.ingredientSlotCost : C.params.shop.sauceSlotCost, 'slot', key, buys);
  const cardPrice = (rar, buys) => { const base = (C.params.rarity.prices && C.params.rarity.prices[rar] != null) ? C.params.rarity.prices[rar] : 100; return priceOf(base, 'card', 'card', buys); };
  const removePrice = buys => priceOf(C.params.shop.removeCost, 'remove', 'remove', buys);

  const pileCopies = pk => { let n = 0; for (const nm of names) if (items[nm].pile === pk) n += items[nm].count; return n; };
  const deckSnap = () => { const by = {}; let tot = 0; for (const nm of names) { const c = items[nm].count; if (c > 0) { const cu = items[nm].cuisine || 'none'; by[cu] = (by[cu] || 0) + c; tot += c; } } return { total: tot, byAxis: by }; };
  const mainAxisOf = by => { let m = 'none', best = -1; for (const k of Object.keys(by)) if (by[k] > best) { best = by[k]; m = k; } return m; };
  const nIngNow = () => Math.round(C.params.tiers.ingredients), nSauNow = () => Math.round(C.params.tiers.sauces);
  const buyCard = (pool, buys, rec) => {   // 買える中で最も安い単一軸カードを1枚（金を効率よく使う）
    let best = null, bp = Infinity;
    for (const nm of pool) { const pc = cardPrice(rarOf(nm), buys); if (pc <= buys.money && pc < bp) { bp = pc; best = nm; } }
    if (!best) return false; buys.money -= bp; items[best].count++; buys['card'] = (buys['card'] || 0) + 1; rec.bought.push({ kind: 'card', name: best, cost: bp }); return true;
  };
  const buySlot = (key, buys, rec) => { const sp = slotPrice(key, buys); if (buys.money < sp) return false; buys.money -= sp; if (key === 'ing') C.params.tiers.ingredients++; else C.params.tiers.sauces++; buys[key] = (buys[key] || 0) + 1; buys.tierBuys++; rec.bought.push({ kind: 'slot', name: key === 'ing' ? 'ingredients' : 'sauces', cost: sp }); return true; };
  const pickDeletable = () => {   // 軸が合わない（FOCUS以外）中段カードのうち、山の最後の1枚でない・基礎点が最も低いもの
    let best = null, bb2 = Infinity;
    for (const nm of names) { const it = items[nm]; if (it.count <= 0) continue; if (it.pile !== 'ingredient' && it.pile !== 'sauce') continue; if (it.cuisine === FOCUS) continue; if (pileCopies(it.pile) <= 1) continue; if (it.base < bb2) { bb2 = it.base; best = nm; } }
    return best;
  };

  // 1ランを回す。dayGoal 営業日で終点（または家賃を払えず終了）。段数分布のため全スピンを記録（lock 早停止はしない）。
  function simRun(policy, seed) {
    R.clearArtifacts(); R.clearTemporal(); resetInit(); setTiers(3, 1); R.seedNow(seed >>> 0);
    const buys = { money: 0, tierBuys: 0 };
    let day = 0, spins = 0, removes = 0; let cum = 0; let died = false;
    const run = { summary: { seed: seed >>> 0, source: 'sim', policy, status: 'playing' }, spins: [] };
    for (let guard = 0; guard < dayGoal * every + 5; guard++) {
      const b = bb(); let sc = 0; if (b) { const r = ev(b.stack); sc = (r && isFinite(r.total)) ? r.total : 0; }
      spins++; cum += sc; buys.money += sc;
      const ingC = pileCopies('ingredient'), sauC = pileCopies('sauce');
      const deckMid = ingC + sauC, slotMid = nIngNow() + nSauNow();
      const limit = deckMid < slotMid ? 'deck' : (slotMid < deckMid ? 'slot' : 'equal');   // 段数を決めていたのは？
      const dk = deckSnap();
      const rec = { spin: spins, day: Math.floor((spins - 1) / every) + 1, score: sc, cum, tiers: b ? b.stack.length : 0,
        deckTotal: dk.total, deckMid, slotMid, limit, bought: [], removed: [] };
      run.spins.push(rec);
      if (spins % every === 0) {
        const due = rentDue(day);
        if (buys.money < due) { died = true; rec.rent = { amount: due, residual: buys.money, paid: false }; break; }
        buys.money -= due; rec.rent = { amount: due, residual: buys.money, paid: true }; day++;
        // ---- 買い物 ----
        if (policy === 'allin') {
          for (let it = 0; it < 3000; it++) { if (nIngNow() + nSauNow() < 800) { const pI = slotPrice('ing', buys), pS = slotPrice('sau', buys); if (pI <= pS && buys.money >= pI) { buySlot('ing', buys, rec); continue; } if (pS < pI && buys.money >= pS) { buySlot('sau', buys, rec); continue; } } if (buyCard(chukaIng.concat(chukaSau, chukaBun), buys, rec)) continue; break; }
        } else if (policy === 'card') {
          for (let it = 0; it < 3000; it++) { if (!buyCard(chukaIng.concat(chukaSau, chukaBun), buys, rec)) break; }   // カードのみ・段スロット買わず
        } else if (policy === 'reinvest') {
          for (let it = 0; it < 40; it++) { if (!buyCard(chukaIng.concat(chukaSau), buys, rec)) break; }
        } else if (policy === 'balanced') {
          // 削除：軸が合わないカードを、削除価格 > 段スロット価格 になるまで削る（＝同じ金で段を増やす方が得になったら止める）
          for (let it = 0; it < 50; it++) { const rp = removePrice(buys), sp = slotPrice('ing', buys); if (rp > sp) break; const victim = pickDeletable(); if (!victim || buys.money < rp) break; buys.money -= rp; items[victim].count--; buys['remove'] = (buys['remove'] || 0) + 1; removes++; rec.removed.push({ name: victim, cause: 'shop' }); }
          // 買い：段数上限とデッキ枚数（中段）の少ない方を買う。単一軸。
          for (let it = 0; it < 3000; it++) {
            const ingC2 = pileCopies('ingredient'), sauC2 = pileCopies('sauce'); const nI = nIngNow(), nS = nSauNow();
            const deckMid2 = ingC2 + sauC2, slotMid2 = nI + nS;
            let bought = false;
            if (deckMid2 < slotMid2) {                                   // デッキ不足→カードを買う（不足している山へ）
              const pool = (ingC2 < nI && chukaIng.length) ? chukaIng : (sauC2 < nS && chukaSau.length) ? chukaSau : (chukaIng.length ? chukaIng : chukaSau);
              bought = buyCard(pool, buys, rec);
            } else {                                                     // デッキ≧上限→段数スロットを買う（余りが多い山へ）
              const key = (ingC2 - nI) >= (sauC2 - nS) ? 'ing' : 'sau';
              bought = buySlot(key, buys, rec);
            }
            if (!bought) break;
          }
        }
        if (day >= dayGoal) break;
      }
    }
    const dk = deckSnap();
    run.summary.spins = run.spins.length; run.summary.finalCum = cum; run.summary.mainAxis = mainAxisOf(dk.byAxis);
    run.summary.finalTiers = run.spins.length ? run.spins[run.spins.length - 1].tiers : 0;
    run.summary.daysSurvived = day; run.summary.finalDeck = dk; run.summary.status = 'ended';
    return { run, died, removes, finalDeckTotal: dk.total, finalCum: cum, daysSurvived: day };
  }

  // ---- 統計 ----
  const sortNum = a => a.slice().sort((x, y) => x - y);
  const median = a => { if (!a.length) return null; const b = sortNum(a); return b[Math.floor(b.length / 2)]; };
  const quart = (a, q) => { if (!a.length) return null; const b = sortNum(a); return b[Math.min(b.length - 1, Math.floor(q * (b.length - 1)))]; };
  const pct = (a, f) => a.length ? +(100 * a.filter(f).length / a.length).toFixed(1) : null;

  const SEEDS = MODE === 'probe' ? [101] : [101, 202, 303, 404, 505, 606, 707, 808];
  const POLICIES = MODE === 'probe' ? ['balanced'] : ['allin', 'balanced', 'card'];

  const result = {};
  for (const pol of POLICIES) {
    const runs = SEEDS.map(s => simRun(pol, s));
    const allSpins = runs.flatMap(r => r.run.spins);
    const tiers = allSpins.map(s => s.tiers);
    const byDay = {}; for (let d = 1; d <= dayGoal; d++) byDay[d] = median(allSpins.filter(s => s.day === d).map(s => s.tiers));
    const limitCounts = { deck: 0, slot: 0, equal: 0 }; for (const s of allSpins) limitCounts[s.limit]++;
    const nSp = allSpins.length || 1;
    result[pol] = {
      spinsTotal: allSpins.length, runsSurvivedToGoal: runs.filter(r => r.daysSurvived >= dayGoal).length, died: runs.filter(r => r.died).length,
      tierDist: { min: Math.min(...tiers), q1: quart(tiers, 0.25), median: median(tiers), q3: quart(tiers, 0.75), max: Math.max(...tiers) },
      tiersByDay: byDay,
      limitPct: { deck: +(100 * limitCounts.deck / nSp).toFixed(1), slot: +(100 * limitCounts.slot / nSp).toFixed(1), equal: +(100 * limitCounts.equal / nSp).toFixed(1) },
      cond: { tiers_le6: pct(tiers, t => t <= 6), deck_le10: pct(allSpins.map(s => s.deckTotal), d => d <= 10), tiers_lt8: pct(tiers, t => t < 8) },
      finalDeck_med: median(runs.map(r => r.finalDeckTotal)), removes_med: median(runs.map(r => r.removes)), finalCum_med: median(runs.map(r => r.finalCum)),
    };
  }
  return { policies: POLICIES, seeds: SEEDS, params: { dayGoal, every, rentBase, rentMul, focus: FOCUS, scale: C.params.shop.scale, chuka: { ing: chukaIng, sau: chukaSau, bun: chukaBun } }, result };
}, MODE);

console.log(JSON.stringify({ errors, mode: MODE, out }, null, 2));
await browser.close();
if (errors.length) process.exitCode = 1;
