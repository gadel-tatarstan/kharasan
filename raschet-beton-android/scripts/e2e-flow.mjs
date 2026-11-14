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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const tap = async (x, y) => {
  await page.mouse.click(x, y);
  await sleep(90);
};
const text = async (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => null);
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const chipValues = () => page.$$eval('.chip__value', (els) => els.map((e) => e.textContent));
/** First orange band stroke hit by a vertical scan, in canvas-local CSS px. */
const topBandPoint = (ratio = 0.5) =>
  page.evaluate((r) => {
    const canvas = document.querySelector('.plan-canvas canvas');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x = Math.round(canvas.width * r);
    for (let y = 0; y < canvas.height; y++) {
      const i = (y * canvas.width + x) * 4;
      if (
        img.data[i + 3] > 200 &&
        img.data[i] > 230 &&
        img.data[i + 1] > 110 &&
        img.data[i + 1] < 170 &&
        img.data[i + 2] > 50 &&
        img.data[i + 2] < 110
      ) {
        return {
          x: (x / canvas.width) * canvas.clientWidth,
          y: (y / canvas.height) * canvas.clientHeight,
        };
      }
    }
    return null;
  }, ratio);

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);
console.log('home:', await text('.brand__title'));

// ---------------- SLAB ----------------
await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);
const box = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const slabPts = [
  [box.x + 90, box.y + 150],
  [box.x + 300, box.y + 158],
  [box.x + 292, box.y + 380],
  [box.x + 98, box.y + 372],
];
for (const [x, y] of slabPts) await tap(x, y);
await tap(slabPts[0][0], slabPts[0][1]);
await sleep(400);
console.log('slab closed:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'));

await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('3000');
await page.keyboard.press('Enter');
await sleep(350);
console.log('slab values:', await chipValues());
console.log('slab hud:', await text('.hud'));
await page.screenshot({ path: '/tmp/slab-dims.png' });

// reference switch via long press on chip 2 (scroll zoom first to check chips move)
await page.mouse.move(box.x + 200, box.y + 250);
await page.mouse.wheel({ deltaY: -240 });
await sleep(250);
console.log('after wheel zoom chips:', await count('.chip'));
await page.screenshot({ path: '/tmp/slab-zoom.png' });

const btn = async (label) => {
  const handles = await page.$$('.sheet .btn');
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error(`no button ${label}`);
};
const sheetTab = async (label) => {
  const hs = await page.$$('.sheet .segmented__item');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error('no tab ' + label);
};
await sheetTab('Толщина');
await sleep(400);
console.log('depth:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'));
await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('450');
await page.keyboard.press('Enter');
await sleep(350);
console.log('slab hud after slope:', await text('.hud'));
await page.screenshot({ path: '/tmp/slab-depth.png' });
await page.click('.ed-head .icon-btn');
await sleep(300);
console.log('home card:', await text('.card__meta'));

// ---------------- STRIP ----------------
await openCalc();
await sleep(250);
const cards = await page.$$('.typecard');
await cards[1].click();
await sleep(350);
// no setup screen any more: the strip opens straight on the canvas
console.log('strip opens:', await text('.ed-head__title'), '|', await text('.ed-head__subtitle'));
const box2 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log('strip canvas scale test, w/h', box2.w, box2.h);

await tap(box2.x + 90, box2.y + 200);
await tap(box2.x + 300, box2.y + 205);
// impossible: only one segment so far, cannot close a ring
await tap(box2.x + 90, box2.y + 200);
await sleep(250);
console.log('ring alert:', await text('.toast'));
await sleep(4800);

await tap(box2.x + 300, box2.y + 360);
await btn('К размерам');
await sleep(500);
// Drawing and branching are one tool now: tap the band to start a branch
// instead of pressing a separate button.
await btn('Добавить линию');
await sleep(300);
const branchBox = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bandTop = await topBandPoint(0.5);
if (!bandTop) throw new Error('no band found for the branch');
await tap(branchBox.x + bandTop.x, branchBox.y + bandTop.y + 2);
await sleep(300);
await tap(branchBox.x + bandTop.x, branchBox.y + bandTop.y - 70);
await sleep(300);
console.log('after branch chips:', await count('.chip'));
await page.screenshot({ path: '/tmp/strip-branch.png' });
await btn('Готово');
await sleep(400);
console.log('strip dims:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'));
console.log('strip hud (not entered):', await text('.hud'));
await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('4000');
await page.keyboard.press('Enter');
await sleep(400);
console.log('strip chips:', await chipValues());
console.log('strip hud:', await text('.hud'));
await page.screenshot({ path: '/tmp/strip-dims.png' });

// per-segment width: tapping the band opens the inspector for that segment
let picked = false;
for (let gy = 0.18; gy <= 0.92 && !picked; gy += 0.06) {
  for (let gx = 0.15; gx <= 0.9 && !picked; gx += 0.06) {
    await tap(box2.x + box2.w * gx, box2.y + box2.h * gy);
    const input = await page.$('.chip__input');
    if (input) {
      await page.keyboard.press('Escape');
      continue;
    }
    const title = await page.$eval('.sheet__title', (e) => e.textContent).catch(() => null);
    if (title === 'Ширина участка') picked = true;
  }
}
console.log('inspector title:', await text('.sheet__title'));
await (await page.$$('.field .stepper'))[1].click();
await sleep(250);
console.log('strip hud after width:', await text('.hud'), '| width badges:', await count('.chip--width'));
await page.screenshot({ path: '/tmp/strip-inspector.png' });

// switching tabs keeps the project and never asks for “Готово”
await sheetTab('Глубина');
await sleep(350);
console.log('strip depth:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'));
await page.click('.chip .chip__btn');
await sleep(200);
await page.keyboard.type('300');
await page.keyboard.press('Enter');
await sleep(350);
console.log('strip hud after node depth:', await text('.hud'));
await page.screenshot({ path: '/tmp/strip-depth.png' });
await sheetTab('Контур');
await sleep(350);
console.log('back on contour:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'), '| hud:', await text('.hud'));
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
