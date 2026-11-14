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
const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(110); };
const text = async (s) => page.$eval(s, (e) => e.textContent?.trim() ?? '').catch(() => null);
const btn = async (label) => { const hs = await page.$$('.sheet .btn'); for (const h of hs) { const t = await h.evaluate((e) => e.textContent?.trim()); if (t === label) return h.click(); } throw new Error('no ' + label); };

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400);

// service worker + manifest
console.log('sw:', await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? (reg.active ? 'active' : 'installing') : 'none';
}));
console.log('manifest:', await page.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('href')));

// slab: three points cannot be rectilinear -> alert, stays on the outline stage
await openCalc(); await sleep(250);
await page.click('.typecard'); await sleep(400);
const box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + 80, box.y + 200);
await tap(box.x + 300, box.y + 200);
await tap(box.x + 300, box.y + 400);
await tap(box.x + 80, box.y + 200);
await sleep(300);
console.log('triangle alert:', await text('.toast'), '| stage:', await text('.ed-head__subtitle'));

// strip: a segment that doubles back on itself
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400);
await openCalc(); await sleep(250);
const cards = await page.$$('.typecard'); await cards[1].click(); await sleep(350);
const b2 = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(b2.x + 100, b2.y + 200);
await tap(b2.x + 300, b2.y + 200);
await tap(b2.x + 200, b2.y + 205); // back along the same line: overlap is allowed now
await sleep(300);
const overlapAlert = await text('.toast');
if (overlapAlert) throw new Error('an overlapping line must not warn: ' + overlapAlert);
console.log('overlap alert:', overlapAlert);

// offline: reload without network
await page.setOfflineMode(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1500);
const bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
console.log('offline body len:', bodyLen, '| editor:', await text('.ed-head__title'), '| canvas:', await page.$$eval('canvas', (els) => els.length), '| heading:', await text('.brand__title'));
console.log('offline text:', (await page.evaluate(() => document.body.innerText)).replace(/\n/g, ' | ').slice(0, 160));
await page.screenshot({ path: '/tmp/offline.png' });
await page.setOfflineMode(false);
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
