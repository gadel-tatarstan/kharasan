import puppeteer from 'puppeteer-core';

// Mobile sheet and slab flow:
//  - the bottom sheet takes at most a third of the phone screen, scrolls on
//    its own and collapses down to the mode tabs;
//  - «Замкнуть контур» is gone — tapping the first point after three corners
//    completes the fourth one automatically;
//  - destructive actions use the styled in-app confirmation, not a native one.
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
let nativeDialog = false;
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('dialog', async (d) => {
  nativeDialog = true;
  await d.accept();
});

const tap = async (x, y) => {
  await page.mouse.click(x, y);
  await sleep(140);
};
const text = (sel) => page.$eval(sel, (e) => e.textContent?.trim() ?? '').catch(() => null);
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const sheet = () =>
  page.$eval('.sheet', (el) => {
    const r = el.getBoundingClientRect();
    return { h: r.height, scroll: el.scrollHeight, client: el.clientHeight };
  });
const canvas = () =>
  page.$eval('.plan-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
const buttonLabels = () => page.$$eval('.sheet .btn', (els) => els.map((e) => e.textContent?.trim()));

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);
await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);

const viewport = page.viewport().height;
const opened = await sheet();
const canvasOpened = await canvas();
console.log('sheet expanded :', opened.h.toFixed(1), 'px | canvas:', canvasOpened.h.toFixed(1));
if (opened.h > viewport / 3 + 4) {
  throw new Error(`sheet is taller than a third of the screen: ${opened.h} of ${viewport}`);
}

await page.click('.sheet__toggle');
await sleep(300);
const collapsed = await sheet();
const canvasCollapsed = await canvas();
console.log('sheet collapsed:', collapsed.h.toFixed(1), 'px | canvas:', canvasCollapsed.h.toFixed(1));
if (collapsed.h >= opened.h) throw new Error('collapse did not shrink the sheet');
if (canvasCollapsed.h <= canvasOpened.h) throw new Error('canvas did not get the freed space');
if ((await count('.sheet .segmented__item')) === 0) throw new Error('mode tabs must stay reachable');
await page.click('.sheet__toggle');
await sleep(300);

const box = await canvas();
const points = [
  [box.x + 90, box.y + 120],
  [box.x + 300, box.y + 128],
  [box.x + 292, box.y + 330],
];
for (const [x, y] of points) await tap(x, y);
const draftButtons = await buttonLabels();
console.log('draft buttons  :', draftButtons);
if (draftButtons.includes('Замкнуть контур')) {
  throw new Error('the old close button is still in the draft sheet');
}
if (!draftButtons.includes('Сбросить')) {
  throw new Error('draft did not start');
}

// Tapping the first point after three corners completes the rectangle.
await tap(points[0][0], points[0][1]);
await sleep(500);
const chips = await count('.chip');
console.log('three corners  : chips:', chips);
if (chips !== 4) {
  throw new Error('three-point contour did not close with a calculated fourth corner');
}

// «Очистить холст» must ask through the styled dialog.
const clearIndex = (await buttonLabels()).indexOf('Очистить холст');
if (clearIndex < 0) throw new Error('no «Очистить холст» button');
const clearButtons = await page.$$('.sheet .btn');
await clearButtons[clearIndex].click();
await sleep(250);
const dialogTitle = await text('.confirm .modal__title');
const dialogButtons = await page.$$eval('.confirm .btn', (els) => els.map((e) => e.textContent?.trim()));
console.log('confirm        :', { dialogTitle, dialogButtons, nativeDialog });
if (dialogTitle !== 'Очистить плиту?') throw new Error('styled confirmation did not open');
if (nativeDialog) throw new Error('native confirm must not be used');
await page.screenshot({ path: '/tmp/opencode/mobile-confirm.png' });

const yes = (await page.$$('.confirm .btn'))[1];
await yes.click();
await sleep(450);
const after = { chips: await count('.chip'), dialog: await count('.confirm') };
console.log('after confirm  :', after);
if (after.chips !== 0 || after.dialog !== 0) {
  throw new Error('clearing the slab did not reset it: ' + JSON.stringify(after));
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
