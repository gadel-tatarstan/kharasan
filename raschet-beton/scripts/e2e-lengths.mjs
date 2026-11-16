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
const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(120); };
const vals = () => page.$$eval('.chip__value', (els) => els.map((e) => e.textContent));
const pinnedVals = () => page.$$eval('.chip--pinned .chip__value', (els) => els.map((e) => e.textContent));
const toast = () => page.$eval('.toast', (e) => e.textContent).catch(() => null);
const hud = () => page.$eval('.hud', (e) => e.textContent).catch(() => null);
const meta = () => page.$eval('.sheet__meta', (e) => e.textContent).catch(() => null);

const typeInto = async (selector, value) => {
  await page.click(selector);
  await sleep(180);
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await sleep(350);
};

const longPress = async (index) => {
  const chip = (await page.$$('.chip'))[index];
  const bb = await chip.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await sleep(680);
  await page.mouse.up();
  await sleep(320);
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(async () => {
  localStorage.clear();
  const regs = await window.navigator.serviceWorker?.getRegistrations?.() ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(350);

await openCalc();
await sleep(260);
await page.click('.typecard');
await sleep(420);
const box = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
// L-shaped slab: 6 edges, H/V alternating
await tap(box.x + 70, box.y + 150);
await tap(box.x + 320, box.y + 150);
await tap(box.x + 320, box.y + 320);
await tap(box.x + 190, box.y + 320);
await tap(box.x + 190, box.y + 470);
await tap(box.x + 70, box.y + 470);
await tap(box.x + 70, box.y + 150);
await sleep(500);
console.log('stage:', (await vals()).length, 'chips');

// 1. first typed number pins only itself and fixes the mm scale
await typeInto('.chip:nth-of-type(1) .chip__btn', 4000);
console.log('after 4000        :', await vals(), '| pinned:', await pinnedVals(), '| hud:', await hud());

// 2. a second, unrelated side — the first number must stay exactly 4000
await typeInto('.chip:nth-of-type(2) .chip__btn', 3000);
console.log('after vertical 3000:', await vals(), '| pinned:', await pinnedVals(), '| hud:', await hud());

// 3. a third hand-typed side: neither 4000 nor 3000 may drift
await typeInto('.chip:nth-of-type(5) .chip__btn', 800);
console.log('after edge5 800    :', await vals(), '| pinned:', await pinnedVals(), '| hud:', await hud());

await page.screenshot({ path: '/tmp/slab-pinned.png' });

// 4. a value the locked sides cannot satisfy is refused with a hint to unlock
const before = await vals();
await typeInto('.chip:nth-of-type(3) .chip__btn', 9000);
console.log('conflict toast     :', await toast());
console.log('values unchanged   :', JSON.stringify(before) === JSON.stringify(await vals()));
console.log('meta               :', await meta());

// 5. long press releases the lock, geometry stays untouched
const beforeUnlock = await vals();
await longPress(0);
console.log('after unlock       :', await pinnedVals(), '| values stable:',
  JSON.stringify(beforeUnlock) === JSON.stringify(await vals()));

// 6. now the freed side absorbs the edit that was refused before
await typeInto('.chip:nth-of-type(3) .chip__btn', 9000);
console.log('after freed edit   :', await vals(), '| pinned:', await pinnedVals(), '| hud:', await hud());

await page.screenshot({ path: '/tmp/slab-lengths.png' });
const beforeReload = await vals();
await page.reload({ waitUntil: 'networkidle0' });
await sleep(700);
const afterReload = await vals();
console.log('persisted lengths  :', JSON.stringify(beforeReload) === JSON.stringify(afterReload), afterReload);
console.log('persisted pins     :', await pinnedVals());
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
