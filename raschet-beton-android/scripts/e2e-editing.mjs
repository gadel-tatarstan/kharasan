import puppeteer from 'puppeteer-core';
const URL = process.env.URL ?? 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calculations are created inside a folder. This opens one (creating a test
// folder on a fresh install) and taps the in-folder "new calculation" action.
const openCalc = async () => {
  if (await page.$('.addcalc')) {
    await page.click('.addcalc');
    return;
  }
  if (!(await page.$('.folder-card'))) {
    await page.click('.empty .btn');
    await page.waitForSelector('.modal__input');
    await page.type('.modal__input', 'Тест');
    const ok = await page.$$('.confirm .btn');
    await ok[1].click();
    await sleep(340);
  }
  if (!(await page.$('.addcalc'))) {
    await page.click('.folder-card .card__main');
    await sleep(280);
  }
  await page.click('.addcalc');
};
const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Destructive actions use the styled in-app confirmation; the button helper accepts it.
page.on('dialog', (d) => d.accept());
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(110); };
const text = async (s) => page.$eval(s, (e) => e.textContent?.trim() ?? '').catch(() => null);
const vals = () => page.$$eval('.chip__value', (els) => els.map((e) => e.textContent));
const btn = async (label) => {
  const hs = await page.$$('.sheet .btn');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t !== label) continue;
    await h.click();
    await sleep(180);
    // Destructive actions open the styled in-app confirmation instead of a native alert.
    const yes = await page.$$('.confirm .btn');
    for (const b of yes) {
      const y = await b.evaluate((e) => e.textContent?.trim());
      if (['Очистить', 'Удалить'].includes(y)) {
        await b.click();
        await sleep(220);
        break;
      }
    }
    return;
  }
  throw new Error('no ' + label);
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);

// ---- slab: long press reference switch ----
await openCalc(); await sleep(250);
await page.click('.typecard'); await sleep(400);
let box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + 90, box.y + 180);
await tap(box.x + 300, box.y + 190);
await tap(box.x + 290, box.y + 380);
await tap(box.x + 95, box.y + 375);
await tap(box.x + 90, box.y + 180);
await sleep(400);
console.log('slab closed:', await text('.ed-head__subtitle'), '| toast:', await text('.toast'));
const sizeBefore = await text('.scene-size');
await page.click('.chip .chip__btn'); await sleep(150);
await page.keyboard.type('2000'); await page.keyboard.press('Enter'); await sleep(400);
const sizeAfter = await text('.scene-size');
console.log('slab after 2000:', await vals(), await text('.hud'), '| size:', sizeBefore, '->', sizeAfter);
if (sizeBefore !== null) throw new Error('scene size must stay hidden before the scale is known');
if (!/^\d+([.,]\d+)? × \d+([.,]\d+)? м$/.test(sizeAfter ?? '')) {
  throw new Error('scene size badge is missing for the slab: ' + sizeAfter);
}
// long-press the 3rd chip -> it gets locked too
const chips = await page.$$('.chip');
const third = chips[2];
const bb = await third.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await sleep(650);
await page.mouse.up();
await sleep(300);
console.log('pinned chips:', await page.$$eval('.chip--pinned .chip__value', (els) => els.map((e) => e.textContent)));
await page.click('.chip:nth-of-type(3) .chip__btn'); await sleep(150);
await page.keyboard.type('1500'); await page.keyboard.press('Enter'); await sleep(400);
console.log('slab after pinned edit:', await vals(), await text('.hud'));
// the edit is refused: dismiss the alert before touching the sheet
await page.click('.toast__close').catch(() => {}); await sleep(250);
await page.screenshot({ path: '/tmp/slab-ref.png' });
const sheetTab = async (label) => { const hs = await page.$$('.sheet .segmented__item'); for (const h of hs) { const t = await h.evaluate((e) => e.textContent?.trim()); if (t === label) return h.click(); } throw new Error('no tab ' + label); };
await sheetTab('Толщина'); await sleep(400);
await page.click('.chip .chip__btn'); await sleep(150);
await page.keyboard.type('300'); await page.keyboard.press('Enter'); await sleep(300);
console.log('slab slope hud:', await text('.hud'));
await page.click('.ed-head .icon-btn'); await sleep(400);

// persistence: reload and read the saved card
await page.reload({ waitUntil: 'networkidle0' });
await sleep(600);
console.log('after reload card:', await text('.card__meta'));

// ---- strip: closed ring ----
await openCalc(); await sleep(250);
const cards = await page.$$('.typecard'); await cards[1].click(); await sleep(350);
box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + 100, box.y + 200);
await tap(box.x + 300, box.y + 200);
await tap(box.x + 300, box.y + 400);
await tap(box.x + 100, box.y + 400);
await tap(box.x + 100, box.y + 200);
await sleep(400);
console.log('ring segments:', await page.$eval('.sheet__meta', (e) => e.textContent).catch(() => null));
await btn('К размерам'); await sleep(400);
console.log('ring chips:', (await vals()).length, await text('.hud'));
await page.click('.chip .chip__btn'); await sleep(150);
await page.keyboard.type('3000'); await page.keyboard.press('Enter'); await sleep(400);
console.log('ring after 3000:', await vals(), await text('.hud'));
await page.screenshot({ path: '/tmp/strip-ring.png' });

// ---- strip: a segment that doubles back over itself ----
await btn('Очистить холст'); await sleep(400);
box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + 80, box.y + 150);
await tap(box.x + 320, box.y + 150);
await tap(box.x + 320, box.y + 400);
await tap(box.x + 200, box.y + 400);
await tap(box.x + 330, box.y + 400); // back along the same line: overlap is allowed now
await sleep(300);
const foldToast = await text('.toast');
// Overlapping centrelines are legal: the band covers that area once, so the
// editor must not warn. Only a genuine zero-length segment still does.
if (foldToast) throw new Error('an overlapping line must not warn: ' + foldToast);
console.log('strip overlap toast:', foldToast);
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
