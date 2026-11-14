import puppeteer from 'puppeteer-core';

// Pointer arbitration between the plan canvas and the value chips on top of it:
//  - a drag that starts on a number must pan the plan instead of being ignored;
//  - a pinch that starts on a number must zoom the plan;
//  - a plain tap on a number must still open the editor;
//  - a drag from a number must not open the editor nor pin the side.
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
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const text = (sel) => page.$eval(sel, (e) => e.textContent?.trim() ?? '').catch(() => null);
const center = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
const canvasRect = () =>
  page.$eval('.plan-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
const drag = async (from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(12);
  }
  await page.mouse.up();
  await sleep(260);
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);
await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);

// Draw a slab: three corners + a tap on the first one closes the rectangle.
const box = await canvasRect();
const pts = [
  [box.x + 90, box.y + 130],
  [box.x + 300, box.y + 140],
  [box.x + 292, box.y + 350],
];
for (const [x, y] of pts) await tap(x, y);
await tap(pts[0][0], pts[0][1]);
await sleep(500);
const chips = await count('.chip');
if (chips !== 4) throw new Error(`expected 4 edge chips, got ${chips}`);

// 1. Pan starting on a number: the plan follows the pointer, no editor opens.
const beforePan = await center('.chip');
const panFrom = { x: beforePan.x, y: beforePan.y + beforePan.h / 2 + 6 };
const panTo = { x: panFrom.x + 80, y: panFrom.y + 54 };
await drag(panFrom, panTo);
const afterPan = await center('.chip');
const panDx = afterPan.x - beforePan.x;
const panDy = afterPan.y - beforePan.y;
const editorAfterPan = await count('.chip__input');
console.log('pan from chip  :', { dx: panDx.toFixed(1), dy: panDy.toFixed(1), editors: editorAfterPan });
if (Math.abs(panDx - 80) > 18 || Math.abs(panDy - 54) > 18) {
  throw new Error(`drag from a chip did not pan the plan (moved ${panDx.toFixed(1)}, ${panDy.toFixed(1)})`);
}
if (editorAfterPan !== 0) throw new Error('drag from a chip opened the number editor');

// 2. The same drag from empty canvas moves the plan the same way.
const canvasChip = await center('.chip');
const canvasFrom = { x: box.x + 26, y: box.y + box.h * 0.42 };
await drag(canvasFrom, { x: canvasFrom.x + 80, y: canvasFrom.y + 54 });
const afterCanvasPan = await center('.chip');
const canvasDx = afterCanvasPan.x - canvasChip.x;
console.log('pan from canvas:', { dx: canvasDx.toFixed(1) });
if (Math.abs(canvasDx - panDx) > 4) {
  throw new Error('panning from a chip differs from panning the canvas');
}

// 3. Tap on a number still edits it.
const tapTarget = await center('.chip');
await page.mouse.click(tapTarget.x, tapTarget.y);
await sleep(300);
const editorAfterTap = await count('.chip__input');
console.log('tap on chip    :', { editors: editorAfterTap });
if (editorAfterTap !== 1) throw new Error('a plain tap on a chip no longer opens the editor');
await page.keyboard.press('Escape');
await sleep(200);

// 4. Pinch with one finger on a number: the plan zooms, nothing gets pinned.
const cdp = await page.createCDPSession();
const chipAt = await center('.chip');
const finger1 = { x: chipAt.x, y: chipAt.y };
const finger2 = { x: chipAt.x + 150, y: chipAt.y };
const mid = { x: (finger1.x + finger2.x) / 2, y: (finger1.y + finger2.y) / 2 };
const startDist = Math.abs(chipAt.x - mid.x);
const touch = (id, x, y) => ({ x, y, id, radiusX: 6, radiusY: 6, force: 1 });
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [touch(1, finger1.x, finger1.y), touch(2, finger2.x, finger2.y)],
});
for (let i = 1; i <= 6; i += 1) {
  const spread = i * 15;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      touch(1, finger1.x - spread, finger1.y),
      touch(2, finger2.x + spread, finger2.y),
    ],
  });
  await sleep(18);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
const chipAfterZoom = await center('.chip');
const endDist = Math.abs(chipAfterZoom.x - mid.x);
const zoomFactor = endDist / (startDist || 1);
const editorsAfterZoom = await count('.chip__input');
const pinnedAfterZoom = await count('.chip--pinned');
console.log('pinch from chip:', {
  start: startDist.toFixed(1),
  end: endDist.toFixed(1),
  factor: zoomFactor.toFixed(2),
  editors: editorsAfterZoom,
  pinned: pinnedAfterZoom,
});
if (zoomFactor < 1.25) throw new Error('pinch that starts on a chip did not zoom the plan');
if (editorsAfterZoom !== 0) throw new Error('pinch that starts on a chip opened the number editor');
if (pinnedAfterZoom !== 0) throw new Error('pinch that starts on a chip pinned a side');

// 4b. The reported case: the first finger already rests on empty canvas and the
// second one lands on a number. That number belongs to the pinch, so it must
// not arm its long press and toggle the green pin while the plan zooms.
const chipSecond = await center('.chip');
const emptyPoint = { x: box.x + 24, y: box.y + box.h - 30 };
const touchId = (id, x, y) => ({ x, y, id, radiusX: 6, radiusY: 6, force: 1 });
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [touchId(11, emptyPoint.x, emptyPoint.y)],
});
await sleep(90);
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [
    touchId(11, emptyPoint.x, emptyPoint.y),
    touchId(12, chipSecond.x, chipSecond.y),
  ],
});
for (let i = 1; i <= 6; i += 1) {
  const spread = i * 14;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      touchId(11, emptyPoint.x - spread, emptyPoint.y),
      touchId(12, chipSecond.x + spread, chipSecond.y),
    ],
  });
  await sleep(18);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const chipAfterSecond = await center('.chip');
const secondShift = Math.hypot(chipAfterSecond.x - chipSecond.x, chipAfterSecond.y - chipSecond.y);
const editorsAfterSecond = await count('.chip__input');
const pinnedAfterSecond = await count('.chip--pinned');
console.log('second finger on chip:', {
  shift: secondShift.toFixed(1),
  editors: editorsAfterSecond,
  pinned: pinnedAfterSecond,
});
if (secondShift < 15) throw new Error('pinch with a late finger on a chip did not zoom');
if (editorsAfterSecond !== 0) throw new Error('a late finger on a chip opened the number editor');
if (pinnedAfterSecond !== 0) throw new Error('a late finger on a chip toggled the pin during the pinch');

if (!(await text('.ed-head__subtitle'))?.endsWith('размеры сторон')) {
  throw new Error('canvas gestures left the slab editor');
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
