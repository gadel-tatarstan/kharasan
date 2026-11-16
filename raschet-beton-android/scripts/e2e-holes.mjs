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
  await sleep(110);
};
const text = async (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => null);
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const parts = () => page.$$eval('.part', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()));
const box = async () =>
  page.$eval('.plan-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
const btn = async (label) => {
  const handles = await page.$$('.sheet .btn');
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error(`no button ${label}`);
};
/** Bounding box of the strong orange outline in canvas-local CSS px. */
const orangeBox = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.plan-canvas canvas');
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
        if (a > 200 && r > 230 && g > 100 && g < 170 && b > 40 && b < 120) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (!isFinite(x0)) return null;
    const sx = canvas.clientWidth / canvas.width;
    const sy = canvas.clientHeight / canvas.height;
    return { x0: x0 * sx, y0: y0 * sy, x1: x1 * sx, y1: y1 * sy };
  });
/** The unfinished contour, read straight from the saved project. */
const draftPoints = () =>
  page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      const v = JSON.parse(localStorage.getItem(k) ?? '{}');
      if (v.projects) {
        const draft = v.projects[0].slab.contours.find((c) => !c.base);
        return draft ? draft.raw.length : 0;
      }
    }
    return 0;
  });
const dismissToast = async () => {
  await page.click('.toast__close').catch(() => {});
  await sleep(400);
};
const rect = async (b, ax, ay, bx, by) => {
  await tap(b.x + ax, b.y + ay);
  await tap(b.x + bx, b.y + ay);
  await tap(b.x + bx, b.y + by);
  await tap(b.x + ax, b.y + by);
  await tap(b.x + ax, b.y + ay);
  await sleep(400);
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);

await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);

let b = await box();
await rect(b, 80, 140, 310, 380);
console.log('first contour:', await text('.ed-head__subtitle'), '| chips:', await count('.chip'));

await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('4000');
await page.keyboard.press('Enter');
await sleep(500);
console.log('after 4000 hud:', await text('.hud'));

// second contour, drawn inside the slab -> must become a void
await btn('Добавить контур');
await sleep(350);
console.log('draft subtitle:', await text('.ed-head__subtitle'));
b = await box();
await rect(b, b.w * 0.38, b.h * 0.36, b.w * 0.6, b.h * 0.58);
console.log('contours:', await parts());
console.log('hud with hole:', await text('.hud'), '| chips:', await count('.chip'));

// a contour straddling the void boundary is refused
await btn('Добавить контур');
await sleep(300);
b = await box();
const before = await count('.chip');
await tap(b.x + b.w * 0.5, b.y + b.h * 0.47);
await tap(b.x + b.w * 0.85, b.y + b.h * 0.47);
await tap(b.x + b.w * 0.85, b.y + b.h * 0.72);
await tap(b.x + b.w * 0.5, b.y + b.h * 0.72);
await tap(b.x + b.w * 0.5, b.y + b.h * 0.47);
await sleep(500);
console.log('crossing toast:', await text('.toast'), '| still drafting:', await text('.ed-head__subtitle'));
await page.screenshot({ path: '/tmp/slab-draft.png' });
await page.click('.toast__close').catch(() => {});
await sleep(200);
await btn('Сбросить');
await sleep(300);
console.log('after cancel chips:', await count('.chip'), '(was', before, ')');

// editing the void keeps it a void
const holeChips = await page.$$('.chip');
console.log('chip count before hole edit:', holeChips.length);
await page.screenshot({ path: '/tmp/slab-hole.png' });

// persistence of both contours (the project reopens on reload)
await page.reload({ waitUntil: 'networkidle0' });
await sleep(600);
console.log('after reload contours:', await parts(), '| hud:', await text('.hud'));

// deleting the void brings the volume back
const del = await page.$$('.part__del');
await del[1].click();
await sleep(400);
console.log('after delete contours:', await parts(), '| hud:', await text('.hud'));
await page.screenshot({ path: '/tmp/slab-hole-removed.png' });

// a contour drawn outside the slab adds its own volume
await btn('Добавить контур');
await sleep(350);
b = await box();
await rect(b, b.w * 0.78, b.h * 0.42, b.w * 0.94, b.h * 0.62);
console.log(
  'outside contour:',
  await parts(),
  '| subtitle:',
  await text('.ed-head__subtitle'),
  '| toast:',
  await text('.toast'),
  '| hud:',
  await text('.hud'),
);
await page.screenshot({ path: '/tmp/slab-outside.png' });

// ---------------- early contour crossing (fresh project) ----------------
// A new contour is checked while drawing: the first segment that cuts a closed
// neighbour is refused immediately, not only when the contour is closed.
await page.click('.ed-head .icon-btn');
await sleep(400);
await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);
b = await box();
await rect(b, 120, 170, 280, 360);
await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('3000');
await page.keyboard.press('Enter');
await sleep(500);

await btn('Добавить контур');
await sleep(450);
b = await box();
let ob = await orangeBox();
if (!ob) throw new Error('no slab outline on screen');
const midY = b.y + (ob.y0 + ob.y1) / 2;
await tap(b.x + ob.x0 - 22, midY);
const outStart = await draftPoints();
await tap(b.x + (ob.x0 + ob.x1) / 2, midY);
const outAfter = await draftPoints();
const outToast = await text('.toast');
console.log(
  'early cross outside->inside:',
  JSON.stringify({ outStart, outAfter }),
  '| toast:',
  outToast,
);
if (outStart !== 1 || outAfter !== 1) {
  throw new Error('a point inside a closed contour was accepted while drawing from outside');
}
if (!outToast || !outToast.includes('пересекаются')) {
  throw new Error('no early crossing alert for outside->inside: ' + outToast);
}
await dismissToast();
// a point that stays outside is still accepted
await tap(b.x + ob.x0 - 22, midY + (ob.y1 - ob.y0) * 0.3);
if ((await draftPoints()) !== 2) {
  throw new Error('a point outside the slab was refused');
}
await btn('Сбросить');
await sleep(350);

// the same from the inside: drawing that started in the slab must stay there
await btn('Добавить контур');
await sleep(450);
b = await box();
ob = await orangeBox();
const cx = b.x + (ob.x0 + ob.x1) / 2;
const cy = b.y + (ob.y0 + ob.y1) / 2;
await tap(cx, cy);
const inStart = await draftPoints();
await tap(b.x + ob.x1 + 24, cy);
const inAfter = await draftPoints();
const inToast = await text('.toast');
console.log(
  'early cross inside->outside:',
  JSON.stringify({ inStart, inAfter }),
  '| toast:',
  inToast,
);
if (inStart !== 1 || inAfter !== 1) {
  throw new Error('a point outside a closed contour was accepted while drawing from inside');
}
if (!inToast || !inToast.includes('пересекаются')) {
  throw new Error('no early crossing alert for inside->outside: ' + inToast);
}
await dismissToast();
// a point that stays inside is still accepted
await tap(cx, cy + (ob.y1 - ob.y0) * 0.2);
if ((await draftPoints()) !== 2) {
  throw new Error('a point inside the slab was refused');
}
await btn('Сбросить');
await sleep(350);
await page.screenshot({ path: '/tmp/slab-early-cross.png' });

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
