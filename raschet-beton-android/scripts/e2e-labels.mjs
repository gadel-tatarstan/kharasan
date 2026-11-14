import puppeteer from 'puppeteer-core';

// Labels on the plan must not turn into a pile when the drawing is zoomed out:
// numbers shrink with the available room and the ones that still cannot fit are
// dropped. Whatever is left never overlaps, and zooming back in restores them.
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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const tap = async (x, y) => {
  await page.mouse.click(x, y);
  await sleep(140);
};
const clickBtn = async (label) => {
  const hs = await page.$$('.sheet .btn');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) {
      await h.click();
      return;
    }
  }
  throw new Error(`no button ${label}`);
};
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const subtitle = () => page.$eval('.ed-head__subtitle', (e) => e.textContent).catch(() => null);
const labels = () =>
  page.$$eval('.chip', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      const m = /matrix\(([^,]+)/.exec(getComputedStyle(e).transform);
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        w: r.width,
        h: r.height,
        scale: m ? Number(m[1]) : 1,
        text: e.textContent?.trim(),
      };
    }),
  );
const overlaps = (cs) => {
  let n = 0;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i];
      const b = cs[j];
      const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
      if (ox > 2 && oy > 2) n++;
    }
  }
  return n;
};
const inspect = async (when) => {
  const cs = await labels();
  const hits = overlaps(cs);
  const scale = cs.length ? Math.min(...cs.map((c) => c.scale)) : 1;
  console.log(
    `${when}`.padEnd(16) + ':',
    JSON.stringify({ count: cs.length, overlaps: hits, scale: +scale.toFixed(2) }),
  );
  if (hits) throw new Error(`${when}: ${hits} label pair(s) overlap`);
  return { count: cs.length, scale };
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);
await openCalc();
await sleep(250);
const cards = await page.$$('.typecard');
await cards[1].click();
await sleep(450);

const box = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
// A closed ring gives eight labels: outer and inner number of every side.
await tap(box.x + 100, box.y + 200);
await tap(box.x + 300, box.y + 205);
await tap(box.x + 300, box.y + 400);
await tap(box.x + 100, box.y + 200);
await sleep(450);
await clickBtn('К размерам');
await sleep(450);
if (!(await subtitle())?.endsWith('размеры сторон и ширина')) throw new Error('strip ring was not created');
const start = await inspect('fit');
if (start.count !== 8) throw new Error(`expected 8 labels at fit zoom, got ${start.count}`);

const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 3; i += 1) {
  await page.mouse.wheel({ deltaY: 500 });
  await sleep(120);
}
const zoomedOut = await inspect('zoomed out');
if (zoomedOut.scale >= 0.95) throw new Error('labels did not shrink when the plan got smaller');
if (zoomedOut.count < 1) throw new Error('zooming out removed every label');

for (let i = 0; i < 7; i += 1) {
  await page.mouse.wheel({ deltaY: 500 });
  await sleep(90);
}
const tiny = await inspect('far out');
if (tiny.count > zoomedOut.count) throw new Error('labels came back while zooming out');

for (let i = 0; i < 12; i += 1) {
  await page.mouse.wheel({ deltaY: -500 });
  await sleep(90);
}
const restored = await inspect('zoomed back in');
if (restored.count !== 8) throw new Error(`zoom-in did not restore all labels: ${restored.count}`);
if (restored.scale < 0.95) throw new Error('labels stayed shrunk after zooming back in');

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
