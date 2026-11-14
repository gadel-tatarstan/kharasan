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
const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(110); };
const text = async (s) => page.$eval(s, (e) => e.textContent?.trim() ?? '').catch(() => null);
const tab = async (label) => {
  const hs = await page.$$('.sheet .segmented__item');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error('no tab ' + label);
};
const btn = async (label) => {
  const hs = await page.$$('.sheet .btn');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error('no ' + label);
};
const fields = () =>
  page.$$eval('.place', (ps) =>
    ps.map((p) => ({
      head: p.querySelector('.place__head')?.textContent?.replace(/\s+/g, ' ').trim(),
      labels: [...p.querySelectorAll('.field__label')].map((e) => e.textContent?.trim()),
      values: [...p.querySelectorAll('.field__input')].map((i) => i.value),
    })),
  );

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);

await openCalc(); await sleep(250);
await page.click('.typecard'); await sleep(400);
let box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// main slab 4000 x 3000
await tap(box.x + 60, box.y + 160);
await tap(box.x + 330, box.y + 170);
await tap(box.x + 325, box.y + 420);
await tap(box.x + 65, box.y + 415);
await tap(box.x + 60, box.y + 160);
await sleep(400);

// Without a real length there is no millimetre scale, so another contour cannot
// be added yet — otherwise it would show meaningless sizes.
const addBeforeScale = await page.$$eval('.sheet .btn', (bs) => {
  const b = bs.find((x) => x.textContent?.trim() === 'Добавить контур');
  return b ? b.disabled : null;
});
console.log('add before scale disabled:', addBeforeScale);
if (addBeforeScale !== true) throw new Error('add contour must be disabled before the scale is set');

await page.click('.chip .chip__btn'); await sleep(150);
await page.keyboard.type('4000'); await page.keyboard.press('Enter'); await sleep(500);
console.log('slab:', await text('.hud'));

// a void inside
await btn('Добавить контур'); await sleep(400);
box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + 150, box.y + 230);
await tap(box.x + 230, box.y + 232);
await tap(box.x + 228, box.y + 330);
await tap(box.x + 152, box.y + 328);
await tap(box.x + 150, box.y + 230);
await sleep(500);
console.log('tabs:', await page.$$eval('.sheet .segmented__item', (els) => els.map((e) => e.textContent?.trim())));
console.log('rows on dims tab:', await fields());

// a contour outside the slab: it must be edited by two non-negative gaps,
// not by four sides like a void
await btn('Добавить контур'); await sleep(400);
box = await page.$eval('.plan-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await tap(box.x + box.w * 0.78, box.y + box.h * 0.42);
await tap(box.x + box.w * 0.94, box.y + box.h * 0.42);
await tap(box.x + box.w * 0.94, box.y + box.h * 0.62);
await tap(box.x + box.w * 0.78, box.y + box.h * 0.62);
await tap(box.x + box.w * 0.78, box.y + box.h * 0.42);
await sleep(500);

await tab('Отступы'); await sleep(500);
console.log('rows:', JSON.stringify(await fields()));
console.log('hud before:', await text('.hud'));

// move the void 600 mm to the right
await page.click('.place .field__input'); await sleep(120);
await page.keyboard.type('600'); await page.keyboard.press('Enter'); await sleep(500);
console.log('rows after 600:', JSON.stringify(await fields()));
await page.$eval('.places', (el) => el.scrollIntoView({ block: 'end' }));
await sleep(250);
await page.screenshot({ path: '/tmp/slab-offsets.png' });

// a zero offset means "flush with the edge" and is valid for both kinds of contour
let placeEls = await page.$$('.place');
await (await placeEls[0].$('.field__input')).click(); await sleep(120);
await page.keyboard.type('0'); await page.keyboard.press('Enter'); await sleep(500);
console.log('void zero toast:', await text('.toast'));
const zeroVoid = (await fields())[0];
console.log('void at zero:', JSON.stringify(zeroVoid));
if (zeroVoid.values[0] !== '0') throw new Error('void zero offset was not accepted');

placeEls = await page.$$('.place');
await (await placeEls[1].$('.field__input')).click(); await sleep(120);
await page.keyboard.type('0'); await page.keyboard.press('Enter'); await sleep(500);
console.log('external zero toast:', await text('.toast'));
const zeroExternal = (await fields())[1];
console.log('external at zero:', JSON.stringify(zeroExternal));
if (zeroExternal.values[0] !== '0') throw new Error('external zero offset was not accepted');

// an impossible offset must be refused with an alert
await page.click('.place .field__input'); await sleep(120);
await page.keyboard.type('9000'); await page.keyboard.press('Enter'); await sleep(500);
console.log('toast:', await text('.toast'));
console.log('rows after 9000:', JSON.stringify(await fields()));

// survives a reload
await page.click('.toast').catch(() => {});
await page.keyboard.press('Escape').catch(() => {});
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(500);
await page.click('.card').catch(() => {});
await sleep(500);
console.log('after reopen:', await text('.ed-head__subtitle'));
await tab('Отступы'); await sleep(500);
console.log('rows after reload:', JSON.stringify(await fields()));
await page.evaluate(() => {
  const raw = localStorage.getItem('beton.projects.v2');
  const s = JSON.parse(raw);
  const c = s.projects[0].slab.contours[1];
  return { pivot: c.pivot, base0: c.base?.[0] };
});
console.log('stored:', await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('beton.projects.v2'));
  const c = s.projects[0].slab.contours[1];
  return { pivot: c.pivot, base0: c.base?.[0], lens: c.lens };
}));

const finalRows = await fields();
const external = finalRows[finalRows.length - 1];
console.log('external placement:', JSON.stringify(external));
// Side by side: gap + top/bottom edge-plane distances. Diagonally it would be
// just the two gaps; anything else is a broken layout.
const externalLabels = external.labels.join('|');
if (
  externalLabels !== 'Зазор X|Сверху|Снизу' &&
  externalLabels !== 'Зазор Y|Слева|Справа' &&
  externalLabels !== 'Зазор X|Зазор Y'
) {
  throw new Error('external contour must show two or three real distances');
}
if (external.values.some((v) => v.startsWith('-'))) {
  throw new Error('external distances must not be negative');
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
