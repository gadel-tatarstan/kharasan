import puppeteer from 'puppeteer-core';

const URL = process.env.URL ?? 'http://127.0.0.1:4173/';
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
await page.setViewport({
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const tap = async (x, y) => {
  await page.mouse.click(x, y);
  await sleep(120);
};
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
const canvasBox = () =>
  page.$eval('.plan-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(300);

await openCalc();
await sleep(250);
await page.click('.typecard');
await sleep(400);

let box = await canvasBox();
// main slab 4000 x 3000
await tap(box.x + 60, box.y + 160);
await tap(box.x + 330, box.y + 170);
await tap(box.x + 325, box.y + 420);
await tap(box.x + 65, box.y + 415);
await tap(box.x + 60, box.y + 160);
await sleep(400);
await page.click('.chip .chip__btn');
await sleep(150);
await page.keyboard.type('4000');
await page.keyboard.press('Enter');
await sleep(600);

// a void inside the slab
await btn('Добавить контур');
await sleep(400);
box = await canvasBox();
await tap(box.x + 150, box.y + 230);
await tap(box.x + 230, box.y + 232);
await tap(box.x + 228, box.y + 330);
await tap(box.x + 152, box.y + 328);
await tap(box.x + 150, box.y + 230);
await sleep(600);

await tab('Отступы');
await sleep(500);
const rows = await page.$$eval('.place .field__input', (els) =>
  els.map((e) => ({ key: e.closest('.field')?.dataset.offsetField, label: e.closest('.field')?.querySelector('.field__label')?.textContent?.trim(), value: e.value })),
);
console.log('offset fields:', JSON.stringify(rows));

// Record every canvas text draw so the test can tap an exact offset label.
await page.evaluate(() => {
  const proto = CanvasRenderingContext2D.prototype;
  if (!proto.__betonPatched) {
    const orig = proto.fillText;
    proto.fillText = function (text, x, y, ...rest) {
      window.__texts = window.__texts || [];
      window.__texts.push({ text: String(text), x, y });
      return orig.call(this, text, x, y, ...rest);
    };
    proto.__betonPatched = true;
  }
  window.__texts = [];
});

// Force a paint in offset mode.
await tab('Контур');
await sleep(300);
await tab('Отступы');
await sleep(600);

const texts = await page.evaluate(() => window.__texts || []);
const fieldValues = rows.map((r) => r.value).filter((v) => v && v !== '0');
const labels = texts.filter((t) => fieldValues.includes(t.text.replace(/\u00a0/g, ' ')));
console.log('label candidates:', JSON.stringify(labels));
if (!labels.length) throw new Error('no offset labels were painted on the canvas');
const target = labels[0];

// The sheet must unfold from collapsed when a label is tapped.
await page.click('.sheet__toggle');
await sleep(400);
const collapsed = await page.$eval('.sheet', (el) => el.classList.contains('is-collapsed'));
if (!collapsed) throw new Error('sheet did not collapse');
console.log('collapsed:', collapsed);

box = await canvasBox();
await tap(box.x + target.x, box.y + target.y);
await sleep(350);

const afterTap = await page.evaluate(() => ({
  collapsed: document.querySelector('.sheet')?.classList.contains('is-collapsed'),
  flash: [...document.querySelectorAll('.field.is-flash')].map((el) => ({
    key: el.dataset.offsetField,
    label: el.querySelector('.field__label')?.textContent?.trim(),
    value: el.querySelector('.field__input')?.value,
  })),
}));
console.log('after label tap:', JSON.stringify(afterTap));
if (afterTap.collapsed) throw new Error('tapping a label did not unfold the sheet');
if (afterTap.flash.length !== 1) throw new Error('exactly one field must flash, got ' + afterTap.flash.length);
if (afterTap.flash[0].value !== target.text.replace(/\u00a0/g, ' ')) {
  throw new Error('the flashed field does not match the tapped number');
}
if (!/^.+:(gapX|gapY|left|right|top|bottom)$/.test(afterTap.flash[0].key ?? '')) {
  throw new Error('flashed field is not an offset field: ' + afterTap.flash[0].key);
}

// It must be scrolled into the visible part of the sheet, not just flagged.
await sleep(500);
const visible = await page.evaluate(() => {
  const el = document.querySelector('.field.is-flash');
  const sheet = document.querySelector('.sheet');
  if (!el || !sheet) return null;
  const r = el.getBoundingClientRect();
  const s = sheet.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, sheetTop: s.top, sheetBottom: s.bottom, h: window.innerHeight };
});
console.log('flash field in view:', JSON.stringify(visible));
if (!visible) throw new Error('flash field disappeared before the scroll finished');
if (visible.top < visible.sheetTop - 1 || visible.bottom > visible.sheetBottom + 1) {
  throw new Error('the offset field was not scrolled into the sheet viewport');
}
await page.screenshot({ path: '/tmp/offset-flash.png' });

// The flash is an animation, not a permanent state.
await sleep(1300);
const stillFlashing = await page.$$eval('.field.is-flash', (els) => els.length);
console.log('flash cleared:', stillFlashing === 0);
if (stillFlashing) throw new Error('the flash highlight did not fade out');

// Enter in an offset field folds the keyboard (blur) and keeps the value.
await page.click('.field.is-flash .field__input').catch(() => {});
const flashInput = await page.$('.place .field__input');
await flashInput.click();
await sleep(150);
await page.keyboard.down('Control');
await page.keyboard.press('A');
await page.keyboard.up('Control');
await page.keyboard.type('450');
await page.keyboard.press('Enter');
await sleep(400);
const entered = await page.evaluate(() => ({
  active: document.activeElement?.tagName,
  value: document.querySelector('.place .field__input')?.value,
}));
console.log('after Enter:', JSON.stringify(entered));
if (entered.active === 'INPUT') throw new Error('Enter did not blur the offset field');
if (entered.value !== '450') throw new Error('Enter did not keep the typed offset: ' + entered.value);

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
