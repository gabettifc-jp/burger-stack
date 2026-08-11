// burger-stack 経済シミュレータ（開発用・ゲーム本体とは別。依存: playwright-core + Chromium）
//
// 目的: 「有り金を全部店に使う（全額投入）」買い物方針を回し、価格スケール（段数スロット／
//       レアリティ）をスイープして、家賃比が1を切って戻らなくなる営業日（＝勝ち確定日）などを測る。
//       元の m67 economy sim（none / reinvest 方針）に allin 方針を追加したもの。結果は LOG.md に貼る。
//
// 使い方:
//   MODE=full  node tools/economy-allin.mjs   # 全12条件×Nシード（既定）
//   MODE=probe node tools/economy-allin.mjs   # 1条件1シード（動作確認）
//   環境変数 PW_CHROMIUM で Chromium 実行ファイルを指定可。
//
// 方針（policy）:
//   none     … 店で何も買わない（比較用）
//   reinvest … 中華カードを買い増す（比較用・従来）
//   allin    … 有り金を使い切るまで買い続ける。優先順位＝段数スロット優先、買えなくなったら中華カードに落ちる。
//
// 注意: これは計測専用の開発ツール。既定値は変更しない（測定時のみ CONFIG のフラグを振る）。
//       得点計算・抽選・乱数ロジックには触れない。出力は plog と同じ JSON 構造（source:"sim"）。

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
  const rentDue = (day) => Math.round(rentBase * Math.pow(rentMul, day));
  const CHUKA = ['チンジャオロース', 'ペキンダック', '花巻', 'ラー油', 'マントウ'].filter(n => items[n]);
  const rarOf = n => items[n].rar || 'nami';

  // 価格（実装 shopPrice/rarityPrice と同じ式をローカル購入回数で再現）
  const slotPrice = (key, base, buys) => { const sh = C.params.shop; return Math.max(0, Math.round(base * (sh.scaleOnBuy ? Math.pow(sh.scaleMul || 1.5, buys[key] || 0) : 1))); };
  const cardPrice = (rar, buys) => { const rr = C.params.rarity; const base = (rr.prices && rr.prices[rar] != null) ? rr.prices[rar] : 100; return Math.max(0, Math.round(base * (rr.scaleOnBuy ? Math.pow(rr.scaleMul || 1.2, buys['card'] || 0) : 1))); };

  const TIER_GUARD = 800, BUYS_PER_VISIT_CAP = 2000, DAY_CAP = 45, LOCK_SCORE = 1e15;

  const deckSnap = () => { const by = {}; let tot = 0; for (const nm of names) { const c = items[nm].count; if (c > 0) { const cu = items[nm].cuisine || 'none'; by[cu] = (by[cu] || 0) + c; tot += c; } } return { total: tot, byAxis: by }; };
  const mainAxisOf = by => { let m = 'none', best = -1; for (const k of Object.keys(by)) if (by[k] > best) { best = by[k]; m = k; } return m; };

  // 1ランを plog 形式で回す（policy: 'none' | 'reinvest' | 'allin'）
  function simRun(policy, seed) {
    R.clearArtifacts(); R.clearTemporal();
    resetInit(); setTiers(3, 1);
    R.seedNow(seed >>> 0);
    const buys = {};
    let money = 0, day = 0, spins = 0, tierBuys = 0, totalBuys = 0, chi = 0, prevScore = null;
    const run = { summary: { seed: seed >>> 0, spins: 0, finalCum: 0, mainAxis: 'none', finalTiers: 0, daysSurvived: 0, source: 'sim', policy, status: 'playing', bestBurger: null }, spins: [] };
    let cum = 0; const ratios = []; let bestB = null;
    let died = false, locked = false, tierGuardHit = false;
    for (let guard = 0; guard < DAY_CAP * every + 5; guard++) {
      const b = bb(); let sc = 0; if (b) { const r = ev(b.stack); sc = (r && isFinite(r.total)) ? r.total : LOCK_SCORE; }
      spins++; cum += sc; money += sc;
      if (b && (bestB == null || sc > bestB.score)) bestB = { spin: spins, score: sc, stack: b.stack.slice() };   // 最高得点バーガー1本のみ（測定側も同形式）
      const rec = { spin: spins, score: sc, cum, tiers: b ? b.stack.length : 0, deck: deckSnap(), artifacts: [], rent: null, bought: [], removed: [] };
      run.spins.push(rec);
      if (spins % every === 0) {
        const due = rentDue(day);
        const ratio = sc > 0 ? due / sc : Infinity;
        ratios.push({ day, ratio });
        if (money < due) { died = true; rec.rent = { amount: due, residual: money, paid: false }; break; }
        money -= due; rec.rent = { amount: due, residual: money, paid: true };
        day++;
        const g = prevScore != null ? (sc / prevScore) : Infinity; prevScore = sc;
        if (policy === 'allin') {
          for (let it = 0; it < BUYS_PER_VISIT_CAP; it++) {
            const tiersNow = Math.round(C.params.tiers.ingredients) + Math.round(C.params.tiers.sauces);
            const pIng = slotPrice('ing', C.params.shop.ingredientSlotCost, buys);
            const pSau = slotPrice('sau', C.params.shop.sauceSlotCost, buys);
            if (tiersNow < TIER_GUARD) {   // 段数スロット優先（安い方）
              if (pIng <= pSau && money >= pIng) { money -= pIng; C.params.tiers.ingredients++; buys['ing'] = (buys['ing'] || 0) + 1; tierBuys++; totalBuys++; rec.bought.push({ kind: 'slot', name: 'ingredients', cost: pIng }); continue; }
              if (pSau < pIng && money >= pSau) { money -= pSau; C.params.tiers.sauces++; buys['sau'] = (buys['sau'] || 0) + 1; tierBuys++; totalBuys++; rec.bought.push({ kind: 'slot', name: 'sauces', cost: pSau }); continue; }
            }
            const card = CHUKA[chi % CHUKA.length]; const pc = cardPrice(rarOf(card), buys);   // 落ちる先：中華カード
            if (money >= pc) { money -= pc; items[card].count++; buys['card'] = (buys['card'] || 0) + 1; chi++; totalBuys++; rec.bought.push({ kind: 'card', name: card, cost: pc }); continue; }
            break;
          }
        } else if (policy === 'reinvest') {
          for (let it = 0; it < 40; it++) { const card = CHUKA[it % CHUKA.length]; const pc = cardPrice(rarOf(card), buys); if (money >= pc) { money -= pc; items[card].count++; buys['card'] = (buys['card'] || 0) + 1; totalBuys++; rec.bought.push({ kind: 'card', name: card, cost: pc }); } else break; }
        }
        // 勝ち確定：家賃比<1 かつ 得点の日次成長が家賃倍率以上（以後 rent は追いつけない）→ 停止
        if (ratio < 1 && sc > 5 * due && g >= rentMul) { locked = true; break; }
        if (sc >= LOCK_SCORE) { locked = true; break; }
        const tiersNow2 = Math.round(C.params.tiers.ingredients) + Math.round(C.params.tiers.sauces);
        if (tiersNow2 >= TIER_GUARD) { tierGuardHit = true; break; }
        if (day >= DAY_CAP) break;
      }
    }
    const dk = deckSnap();
    run.summary.spins = run.spins.length; run.summary.finalCum = cum; run.summary.mainAxis = mainAxisOf(dk.byAxis);
    run.summary.finalTiers = run.spins.length ? run.spins[run.spins.length - 1].tiers : 0;
    run.summary.daysSurvived = day; run.summary.finalDeck = dk; run.summary.status = 'ended'; run.summary.bestBurger = bestB;
    let beatDay = null;   // 家賃比が1を切って戻らなくなる営業日
    for (let i = 0; i < ratios.length; i++) { if (ratios[i].ratio < 1) { let ok = true; for (let j = i; j < ratios.length; j++) if (ratios[j].ratio >= 1) { ok = false; break; } if (ok) { beatDay = ratios[i].day; break; } } }
    const alwaysAbove1 = ratios.length > 0 && ratios.every(r => r.ratio >= 1);
    return { metrics: { beatDay, finalTiers: run.summary.finalTiers, finalTierSlots: Math.round(C.params.tiers.ingredients) + Math.round(C.params.tiers.sauces), finalCum: cum, daysSurvived: day, died, locked, tierGuardHit, reachedDayCap: day >= DAY_CAP, totalBuys, tierBuys, alwaysAbove1 }, run };
  }

  const median = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const medianNull = a => { const v = a.filter(x => x != null); return v.length ? median(v) : null; };

  const shopConds = [{ k: 'off', on: false, mul: 1 }, { k: '1.2', on: true, mul: 1.2 }, { k: '1.5', on: true, mul: 1.5 }, { k: '2.0', on: true, mul: 2.0 }];
  const rarConds = [{ k: 'off', on: false, mul: 1 }, { k: '1.2', on: true, mul: 1.2 }, { k: '1.5', on: true, mul: 1.5 }];
  const SEEDS_FULL = [101, 202, 303, 404, 505, 606, 707, 808];
  const SEEDS = MODE === 'probe' ? [101] : SEEDS_FULL;
  const useShop = MODE === 'probe' ? [shopConds[0]] : shopConds;
  const useRar = MODE === 'probe' ? [rarConds[0]] : rarConds;

  const results = []; let sample = null;
  for (const sc of useShop) for (const rc of useRar) {
    C.params.shop.scaleOnBuy = sc.on; C.params.shop.scaleMul = sc.mul;
    C.params.rarity.scaleOnBuy = rc.on; C.params.rarity.scaleMul = rc.mul;
    const per = [];
    for (const sd of SEEDS) { const r = simRun('allin', sd); per.push(r.metrics); if (!sample) sample = r.run; }
    results.push({
      shop: sc.k, rarity: rc.k, n: SEEDS.length,
      beatDay_med: medianNull(per.map(x => x.beatDay)), beatDay_all: per.map(x => x.beatDay),
      finalTiers_med: median(per.map(x => x.finalTiers)), finalTierSlots_med: median(per.map(x => x.finalTierSlots)),
      finalCum_med: median(per.map(x => x.finalCum)), daysSurvived_med: median(per.map(x => x.daysSurvived)),
      totalBuys_med: median(per.map(x => x.totalBuys)), tierBuys_med: median(per.map(x => x.tierBuys)),
      diedCount: per.filter(x => x.died).length, lockedCount: per.filter(x => x.locked).length, alwaysAbove1Count: per.filter(x => x.alwaysAbove1).length,
    });
  }
  // 参考：none / reinvest（既定価格 off/off）
  C.params.shop.scaleOnBuy = false; C.params.shop.scaleMul = 1.5; C.params.rarity.scaleOnBuy = false; C.params.rarity.scaleMul = 1.2;
  const baseCmp = {};
  if (MODE !== 'probe') for (const pol of ['none', 'reinvest']) { const bd = []; for (const sd of SEEDS) bd.push(simRun(pol, sd).metrics.beatDay); baseCmp[pol] = { beatDay_med: medianNull(bd), beatDay_all: bd }; }

  return { grid: results, sampleRun: sample, baseCmp, params: { DAY_CAP, TIER_GUARD, BUYS_PER_VISIT_CAP, every, rentBase, rentMul } };
}, MODE);

console.log(JSON.stringify({ errors, mode: MODE, out }, null, MODE === 'probe' ? 1 : 0));
await browser.close();
if (errors.length) process.exitCode = 1;
