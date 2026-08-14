/* 調査 D1：M3 で出た3件を調べるためのプローブ（2026-08-14）。
   index.html は1行も変更しない。読むだけ・実プレイ経路だけ。

   使い方：
     node tools/d1-probe.mjs dump                  … CONFIG.items / buns / artifacts を JSON に落とす
     node tools/d1-probe.mjs fb --from=A --to=B --policy=P  … レアリティの落下を「どの画面で起きたか」つきで記録
     node tools/d1-probe.mjs bun                   … バンズの所持枠が枠を超える経路を実プレイで再現する

   fb は m3-measure.mjs のボットをそのまま使い、1手ごとに RUN.rarityFallbacks() を吸い出して
   「その直後に表示された画面」で仕分ける（落下は次の画面を組むときに起きるため）。
*/
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';

const MODE = process.argv[2] || 'dump';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const TARGET = 'file:///home/user/burger-stack/index.html';
const EXE = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
if (!existsSync('tools/out')) mkdirSync('tools/out', { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(TARGET);
await page.waitForFunction(() => typeof window.RUN !== 'undefined');

/* ── dump：カード・バンズ・アーティファクトの定義をそのまま落とす ───────────── */
if (MODE === 'dump') {
  const d = await page.evaluate(() => {
    const items = {};
    for (const nm of Object.keys(CONFIG.items)) {
      const it = CONFIG.items[nm];
      items[nm] = { pile: it.pile, cui: it.cuisine || 'none', rar: it.rar, base: it.base,
        eid: (it.effect || {}).id || null, eff: it.effect || null,
        text: (typeof effectText === 'function' ? effectText(nm) : '') };
    }
    const arts = {};
    for (const nm of Object.keys(CONFIG.artifacts)) arts[nm] = CONFIG.artifacts[nm];
    return { items, buns: CONFIG.buns, arts, params: CONFIG.params };
  });
  writeFileSync('tools/out/d1-items.json', JSON.stringify(d, null, 1));
  console.log('tools/out/d1-items.json:', Object.keys(d.items).length, 'items /', Object.keys(d.arts).length, 'artifacts');
  await browser.close();
  process.exit(0);
}

/* ── bun：バンズの所持枠が枠を超える経路を実プレイで再現する ───────────────── */
if (MODE === 'bun') {
  const tap = () => page.evaluate(() => { const el = document.getElementById('tap');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
  const snap = () => page.evaluate(() => ({
    show: document.getElementById('offer').classList.contains('show'),
    title: (document.querySelector('#offer .offer-title') || {}).textContent || '',
    sub: (document.querySelector('#offer .offer-subtitle') || {}).textContent || '',
    buns: RUN.buns().length, cap: (() => { const h = document.getElementById('bunHead'); return h ? h.textContent : ''; })(),
    arts: RUN.state().artifacts.slice(), warn: selfCheck(), active: RUN.state().runActive }));

  // 手順：シードを固定して開始 → 夜の仕込みを持たせる → 営業日を1つ進めてバンズ入手まで行く
  const CASES = [
    { name: '夜の仕込み1枚（枠4）', arts: ['夜の仕込み'] },
    { name: '夜の仕込み＋バンズケース（枠5）', arts: ['夜の仕込み', 'バンズケース'] },
    { name: '調理台だけ（枠3に下がる）', arts: [] },   // 開始後に付与する
  ];
  for (let ci = 0; ci < CASES.length; ci++) {
    const c = CASES[ci];
    await page.evaluate(([arts, ci]) => {
      CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
      RUN.setPendingSeed(9100 + ci); RUN.reset();
      CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
      CONFIG.params.run.dayGoal = 10;
      for (const a of arts) RUN.grantArtifact(a);
    }, [c.arts, ci]);
    const before = await snap();
    // ケース③は「開始時に枠4ぶん埋まったあとで調理台を取る」を再現する
    if (c.name.startsWith('調理台')) {
      await page.evaluate(() => RUN.grantArtifact('調理台'));
      const after = await snap();
      console.log(`\n■ ${c.name}\n  取得前 所持 ${before.buns} / ${before.cap}\n  取得後 所持 ${after.buns} / ${after.cap}\n  selfCheck: ${JSON.stringify(after.warn)}`);
      continue;
    }
    // 営業日の最後まで回してバンズ入手の画面を出す
    let guard = 0, got = null;
    while (guard++ < 600) {
      const s = await snap();
      if (!s.active) break;
      if (s.show && /バンズを1枚入手/.test(s.title)) { got = s; break; }
      if (s.show) {
        await page.evaluate(() => {
          const t = (document.querySelector('#offer .offer-title') || {}).textContent || '';
          if (/店（/.test(t)) { const o = [...document.querySelectorAll('#offer .offer-skip')].find(y => /店を出る/.test(y.textContent)); if (o) { o.click(); return; } }
          if (/家賃の支払い/.test(t)) { const x = [...document.querySelectorAll('#offer .offer-buy')].find(y => /支払う|前借り|結果/.test(y.textContent)); if (x) { x.click(); return; } }
          const s2 = document.querySelector('#offer .offer-skip'); if (s2) { s2.click(); return; }
          const cc = document.querySelector('#offer .offer-card'); if (cc) cc.click();
        });
        await page.waitForTimeout(20);
        continue;
      }
      for (let k = 0; k < 14; k++) { if (await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent))) break; await tap(); await page.waitForTimeout(15); }
      for (let k = 0; k < 14; k++) { if (!(await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(15); }
    }
    if (!got) { console.log(`\n■ ${c.name}：バンズ入手の画面まで行けなかった`); continue; }
    // 「受け取る」を押す（押し出しは起きないはず）
    const after = await page.evaluate(() => {
      const take = [...document.querySelectorAll('#offer .offer-buy')].find(x => /受け取る/.test(x.textContent));
      if (take) take.click();
      return { buns: RUN.buns().length, head: (document.getElementById('bunHead') || {}).textContent || '', warn: selfCheck() };
    });
    console.log(`\n■ ${c.name}\n  入手画面の見出し: ${got.sub}\n  入手前 所持 ${got.buns}\n  入手後 所持 ${after.buns}（${after.head}）\n  selfCheck: ${JSON.stringify(after.warn)}`);
  }
  // ④ ランをまたぐ経路：resetRun() は resetBuns() を artifactsOwned=[] より先に呼ぶ。
  //    前のランのアーティファクトで枠が決まってしまうので、次のランが枠を超えた状態で始まる。
  const cross = await page.evaluate(() => {
    const out = [];
    RUN.setPendingSeed(9200); RUN.reset();
    out.push({ step: '素の開始', buns: RUN.buns().length, cap: bunCap(), warn: selfCheck() });
    RUN.grantArtifact('バンズケース');
    out.push({ step: 'バンズケースを取る', buns: RUN.buns().length, cap: bunCap(), warn: selfCheck() });
    RUN.setBuns(['ゴマバンズ', 'ゴマバンズ', 'ゴマバンズ', 'ゴマバンズ', 'ゴマバンズ']);
    out.push({ step: '5枠まで埋まった状態', buns: RUN.buns().length, cap: bunCap(), warn: selfCheck() });
    RUN.setPendingSeed(9201); RUN.reset();
    out.push({ step: '次のランを始める（reset）', buns: RUN.buns().length, cap: bunCap(), warn: selfCheck() });
    RUN.setPendingSeed(9202); RUN.reset();
    out.push({ step: 'もう1回 reset', buns: RUN.buns().length, cap: bunCap(), warn: selfCheck() });
    return out;
  });
  console.log('\n■ ランをまたぐ経路（resetRun の順序）');
  for (const r of cross) console.log(`  ${r.step}: 所持 ${r.buns} / 枠 ${r.cap}　selfCheck: ${JSON.stringify(r.warn)}`);
  await browser.close();
  process.exit(0);
}

/* ── fb：レアリティの落下を「直後に出た画面」つきで記録する ─────────────────── */
const FROM = +arg('from', 3001), TO = +arg('to', 3010), POLICY = arg('policy', 'base'), DAYS = +arg('days', 10);
const OUT = arg('out', `tools/out/d1-fb-${POLICY}.jsonl`);
writeFileSync(OUT, '');

const PROXY = `
  const BAND = { nami:60, jou:120, tokujou:240, kiwami:480 };
  const SAUCE_MULT = { nami:1.5, jou:3, tokujou:6, kiwami:10 };
  function proxy(nm){ const it = CONFIG.items[nm]; if (!it) return 0;
    if (it.pile === "sauce") return Math.round(40 * ((SAUCE_MULT[it.rar] || 1) - 1));
    return BAND[it.rar] || 0; }
  function proxyWithAxis(nm, useAxis){ const v = proxy(nm); if (!useAxis) return v;
    const main = RUN.mainCuisine(); const cu = (CONFIG.items[nm] || {}).cuisine || "none";
    return (main !== "none" && cu === main) ? Math.round(v * 1.3) : v; }
  window.__rngState = 0;
  function botRand(){ let t = (window.__rngState += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  function weakestInDeck(){ const d = RUN.deck(); let lo = null;
    for (const x of d){ const v = proxy(x.name); if (lo === null || v < lo.v) lo = { v, name: x.name }; }
    return lo || { v: 0, name: null }; }
  // 落下を吸い出して「いま出ている画面」で仕分ける。RUN.clearRarityFallbacks で毎回空にするので取りこぼさない。
  function drainFb(){
    const nu = RUN.rarityFallbacks(); if (!nu.length) return;
    RUN.clearRarityFallbacks();
    const t = (document.querySelector('#offer .offer-title') || {}).textContent || '(盤面)';
    const nCh = document.querySelectorAll('#offer .offer-card').length;
    window.__screenFb = (window.__screenFb || 0) + nu.length;
    for (const r of nu) window.__M3.fb.push({ w: t, d: RUN.state().daysSurvived + 1, n: nCh, cu: r.cuisine, want: r.want, got: r.got });
  }
`;

async function runOne(seed, policy) {
  const errs = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', e => errs.push('PE ' + e.message));
  await page.goto(TARGET);
  await page.waitForFunction(() => typeof window.RUN !== 'undefined');
  await page.evaluate(([seed, days, policy, proxySrc]) => {
    window.__M3 = { policy, fb: [], artBuys: [], nCh: [], screens: [] };
    eval(proxySrc);
    window.__proxy = proxy; window.__proxyAxis = proxyWithAxis; window.__weakest = weakestInDeck;
    window.__botRand = botRand; window.__drain = drainFb; window.__rngState = seed * 7919;
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    RUN.setPendingSeed(seed); RUN.reset();
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    CONFIG.params.run.dayGoal = days;
    RUN.clearRarityFallbacks();
  }, [seed, DAYS, policy, PROXY]);

  const st = () => page.evaluate(() => { window.__drain(); return {
    show: document.getElementById('offer').classList.contains('show'),
    title: (document.querySelector('#offer .offer-title') || {}).textContent || '',
    active: RUN.state().runActive, days: RUN.state().daysSurvived, cls: document.getElementById('offer').className }; });
  const tap = () => page.evaluate(() => { const el = document.getElementById('tap');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });

  let guard = 0, ended = null, lastKey = '', rep = 0;
  while (guard++ < 4000) {
    const s = await st();
    if (!s.active) { ended = /cleared/.test(s.cls) ? 'cleared' : 'broke'; break; }
    const key = s.show + '|' + s.title + '|' + s.days;
    if (key === lastKey) rep++; else { rep = 0; lastKey = key; }
    if (rep > 40) { ended = 'stuck'; break; }
    if (!s.show) {
      for (let k = 0; k < 14; k++) { if (await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent))) break; await tap(); await page.waitForTimeout(20); }
      for (let k = 0; k < 14; k++) { if (!(await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(20); }
      continue;
    }
    await page.evaluate((policy) => {
      const M = window.__M3, title = (document.querySelector('#offer .offer-title') || {}).textContent || '';
      const day = RUN.state().daysSurvived + 1;
      const useAxis = policy !== 'noaxis';
      const rnd = arr => arr[Math.floor(window.__botRand() * arr.length)];
      if (/バンズを1枚入手/.test(title)) {
        const sub = (document.querySelector('#offer .offer-subtitle') || {}).textContent || '';
        const take = [...document.querySelectorAll('#offer .offer-buy')].find(x => /受け取る/.test(x.textContent));
        if (!/押し出す/.test(sub) && take) { take.click(); window.__drain(); return; }
        const rows = [...document.querySelectorAll('#offer .bunslots .remove-row:not(.off)')];
        const goma = rows.find(r => (r.querySelector('.nm') || {}).textContent === 'ゴマバンズ');
        if (goma) goma.click(); else if (rows[0]) rows[0].click(); else if (take) take.click();
        window.__drain(); return;
      }
      if (/家賃の支払い/.test(title)) {
        const x = [...document.querySelectorAll('#offer .offer-buy')].find(y => /支払う|前借り|結果/.test(y.textContent));
        if (x) x.click(); window.__drain(); return;
      }
      if (/店（/.test(title)) {
        const money = () => RUN.state().money;
        const keep = () => Math.round(300 * Math.pow(1.4, RUN.state().daysSurvived));
        const btn = re => [...document.querySelectorAll('#offer .shopbtn')].find(y => re.test(y.textContent));
        const price = el => +((el.querySelector('.price') || {}).textContent || '0').replace(/\D/g, '');
        if (policy === 'random') {
          for (let k = 0; k < 6; k++) {
            const cs = [...document.querySelectorAll('#offer .shopcard')].filter(x => !x.classList.contains('cant'));
            if (!cs.length) break; const c = rnd(cs);
            const nm = (c.querySelector('.nm') || {}).textContent; const isArt = c.classList.contains('artcard');
            c.click(); if (isArt) M.artBuys.push({ d: day, nm }); window.__drain();
          }
        } else {
          if (policy !== 'norem') {
            for (let k = 0; k < 3; k++) {
              const rb = btn(/取り除く/); if (!rb || /cant/.test(rb.className)) break;
              const cost = price(rb); if (money() - cost < keep()) break;
              rb.click();
              const rows = [...document.querySelectorAll('#offer .remove-row:not(.off)')];
              if (!rows.length) { const back = [...document.querySelectorAll('#offer .offer-skip')].find(y => /戻る/.test(y.textContent)); if (back) back.click(); break; }
              let lo = rows[0], lv = 1e9;
              for (const r of rows) { const v = window.__proxy((r.querySelector('.nm') || {}).textContent); if (v < lv) { lv = v; lo = r; } }
              lo.click(); window.__drain();
            }
          }
          for (let k = 0; k < 8; k++) {
            let cs = [...document.querySelectorAll('#offer .shopcard:not(.artcard)')].filter(x => !x.classList.contains('cant'));
            if (policy === 'nosauce') cs = cs.filter(x => (CONFIG.items[(x.querySelector('.nm') || {}).textContent] || {}).pile !== 'sauce');
            cs = cs.filter(x => money() - price(x) >= keep());
            if (!cs.length) break;
            const sauceSlots = Math.round(CONFIG.params.tiers.sauces);
            const haveSauce = RUN.deck().filter(y => CONFIG.items[y.name].pile === 'sauce').length;
            const wantSauce = policy !== 'nosauce' && haveSauce < sauceSlots;
            const pick = cs.map(x => ({ x, nm: (x.querySelector('.nm') || {}).textContent }))
              .map(o => ({ ...o, v: window.__proxyAxis(o.nm, useAxis) + ((wantSauce && CONFIG.items[o.nm].pile === 'sauce') ? 10000 : 0) }))
              .sort((a, b) => b.v - a.v)[0];
            pick.x.click(); window.__drain();
          }
          for (let k = 0; k < 3; k++) {
            const as = [...document.querySelectorAll('#offer .shopcard.artcard')].filter(x => !x.classList.contains('cant'))
              .filter(x => money() - price(x) >= keep());
            if (!as.length) break;
            const nm = (as[0].querySelector('.nm') || {}).textContent;
            as[0].click(); M.artBuys.push({ d: day, nm }); window.__drain();
          }
          for (let k = 0; k < 2; k++) {
            const ib = btn(/具材枠/); if (!ib || /cant/.test(ib.className)) break;
            const cost = price(ib); if (money() - cost < keep()) break;
            if (RUN.deck().length <= Math.round(CONFIG.params.tiers.ingredients) + 1) break;
            ib.click(); window.__drain();
          }
        }
        const out = [...document.querySelectorAll('#offer .offer-skip')].find(y => /店を出る/.test(y.textContent));
        if (out) out.click(); window.__drain(); return;
      }
      if (/押し出す|減らす|軸を選ぶ/.test(title)) {
        const r = document.querySelector('#offer .remove-row:not(.off)') || document.querySelector('#offer .offer-card')
          || [...document.querySelectorAll('#offer .offer-buy')][0];
        if (r) r.click(); window.__drain(); return;
      }
      const cs = [...document.querySelectorAll('#offer .offer-card')];
      M.nCh.push(cs.length);
      // この3択の画面を組むときに落ちた件数（直前の drain ぶん）と、実際に並んだ札を控える
      M.screens.push({ d: day, fb: window.__screenFb || 0, names: cs.map(c => (c.querySelector('.nm') || {}).textContent) });
      window.__screenFb = 0;
      if (!cs.length) { const s = document.querySelector('#offer .offer-skip'); if (s) s.click(); window.__drain(); return; }
      const names = cs.map(c => (c.querySelector('.nm') || {}).textContent);
      if (policy === 'random') { const k = Math.floor(window.__botRand() * cs.length); cs[k].click(); window.__drain(); return; }
      let cand = names.map((nm, k) => ({ nm, k, v: window.__proxyAxis(nm, useAxis) }));
      if (policy === 'nosauce') cand = cand.filter(o => CONFIG.items[o.nm].pile !== 'sauce');
      const weak = window.__weakest();
      cand = cand.filter(o => o.v > weak.v);
      if (!cand.length) { const s = document.querySelector('#offer .offer-skip'); if (s) s.click(); window.__drain(); return; }
      cand.sort((a, b) => b.v - a.v || a.k - b.k);
      cs[cand[0].k].click(); window.__drain();
    }, policy);
    await page.waitForTimeout(30);
  }
  const out = await page.evaluate(() => { window.__drain(); const M = window.__M3;
    return { fb: M.fb, artBuys: M.artBuys, nCh: M.nCh, screens: M.screens, arts: RUN.state().artifacts.slice(),
      warn: selfCheck(), main: RUN.mainCuisine() }; });
  return { seed, policy, ended, errs: errs.length, ...out };
}

const t0 = Date.now();
for (let s = FROM; s <= TO; s++) {
  const r = await runOne(s, POLICY);
  appendFileSync(OUT, JSON.stringify(r) + '\n');
  process.stderr.write(`  ${POLICY} ${s}: ${r.ended} fb=${r.fb.length} arts=${r.arts.join('/')}\n`);
}
await browser.close();
console.log(`${POLICY}: ${TO - FROM + 1}ラン / ${Math.round((Date.now() - t0) / 1000)}秒 → ${OUT}`);
