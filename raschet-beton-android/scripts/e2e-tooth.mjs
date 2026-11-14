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
page.on('dialog', (d) => d.accept());
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(140); };
const hud = () => page.$eval('.hud', (e) => e.textContent?.replace(/\s+/g, ' ').trim()).catch(() => null);
const hints = () => page.$$eval('.sheet .hint', (els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()));
const box = () => page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const clickBtn = async (label) => {
  const hs = await page.$$('.sheet .btn');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t !== label) continue;
    await h.click();
    await sleep(220);
    return;
  }
  throw new Error('no button ' + label);
};
const sheetTab = async (label) => {
  const hs = await page.$$('.sheet .segmented__item');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) { await h.click(); await sleep(380); return; }
  }
  throw new Error('no tab ' + label);
};
const fieldInput = async (label) => {
  const hs = await page.$$('.sheet .field');
  for (const h of hs) {
    const l = await h.$eval('.field__label', (e) => e.textContent?.trim()).catch(() => null);
    if (l === label) return h.$('.field__input');
  }
  return null;
};
const fieldValue = async (label) => {
  const input = await fieldInput(label);
  return input ? input.evaluate((e) => e.value) : null;
};
const typeField = async (label, value) => {
  const input = await fieldInput(label);
  if (!input) throw new Error('no field ' + label);
  await input.click({ clickCount: 3 });
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await sleep(420);
};
const toothSwitch = async () => {
  const el = await page.$('.sheet .switch');
  if (!el) return null;
  return el.evaluate((e) => ({
    checked: e.getAttribute('aria-checked') === 'true',
    text: e.textContent?.replace(/\s+/g, ' ').trim(),
  }));
};
const toggleTooth = async () => {
  const el = await page.$('.sheet .switch');
  if (!el) throw new Error('no tooth switch');
  await el.click();
  await sleep(400);
};
const volumeFromHud = (text) => {
  const m = /Объём бетона\s*([\d\s.,]+)\s*м³/.exec(text ?? '');
  if (!m) return null;
  return Number(m[1].replace(/\s/g, '').replace(',', '.'));
};
const toothHint = (list) => {
  for (const text of list) {
    const m = /Площадь зуба\s*([\d\s.,]+)\s*м²\s*·\s*объём\s*([\d\s.,]+)\s*м³/.exec(text ?? '');
    if (!m) continue;
    return {
      area: Number(m[1].replace(/\s/g, '').replace(',', '.')),
      volume: Number(m[2].replace(/\s/g, '').replace(',', '.')),
    };
  }
  return null;
};
const currentToothHint = async () => toothHint(await hints());
const near = (a, b, tol = 0.006) => Math.abs(a - b) <= tol;

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(async () => {
  localStorage.clear();
  const regs = (await window.navigator.serviceWorker?.getRegistrations?.()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400);

await openCalc();
await sleep(280);
const cards = await page.$$('.typecard');
await cards[1].click();
await sleep(450);

// Closed ring.
const b = await box();
for (const [gx, gy] of [
  [0.2, 0.25],
  [0.8, 0.25],
  [0.8, 0.7],
  [0.2, 0.7],
  [0.2, 0.25],
]) {
  await tap(b.x + b.w * gx, b.y + b.h * gy);
}
await sleep(450);
await clickBtn('К размерам');
await sleep(450);

// Fix the scale with a known side.
const firstChip = await page.$('.chip:nth-of-type(1) .chip__btn');
await firstChip.click();
await sleep(200);
await page.keyboard.type('4000');
await page.keyboard.press('Enter');
await sleep(500);

await sheetTab('Глубина');
const hudBase = await hud();
const volBase = volumeFromHud(hudBase);
console.log('base            :', hudBase);
const sw0 = await toothSwitch();
console.log('switch off      :', JSON.stringify(sw0));
if (!sw0 || sw0.checked) throw new Error('the tooth switch must exist and start off');
if (await fieldInput('Ширина зуба')) throw new Error('tooth fields must be hidden until enabled');

await toggleTooth();
const sw1 = await toothSwitch();
const width0 = await fieldValue('Ширина зуба');
const depth0 = await fieldValue('Глубина зуба');
const hint0 = await currentToothHint();
const hud1 = await hud();
const vol1 = volumeFromHud(hud1);
console.log('switch on       :', JSON.stringify(sw1));
console.log('tooth defaults  :', width0, '×', depth0, '| hint:', JSON.stringify(hint0));
console.log('with tooth      :', hud1);
if (!sw1?.checked) throw new Error('the switch did not turn on');
if (!width0 || !depth0) throw new Error('tooth width/depth fields did not appear');
if (width0 !== '150' || depth0 !== '150') throw new Error(`unexpected defaults ${width0}×${depth0}`);
if (!hint0 || hint0.area <= 0 || hint0.volume <= 0) throw new Error('the tooth area/volume hint is missing');
if (!hud1?.includes('зуб')) throw new Error('the HUD must mention the tooth volume');
if (!near(vol1 - volBase, hint0.volume, 0.02)) {
  throw new Error(`tooth volume is not added to the HUD: +${(vol1 - volBase).toFixed(3)} vs ${hint0.volume}`);
}
if (!near(hint0.area * (Number(depth0) / 1000), hint0.volume, 0.02)) {
  throw new Error(`tooth volume must equal area × depth: ${JSON.stringify(hint0)}`);
}

await page.screenshot({ path: '/tmp/opencode/tooth-on.png' });

// Wider tooth -> larger footprint; deeper tooth -> proportionally larger volume.
await typeField('Ширина зуба', 200);
const hintWide = await currentToothHint();
console.log('width 200       :', JSON.stringify(hintWide));
if (!hintWide || hintWide.area <= hint0.area) throw new Error('a wider tooth must cover more area');

await typeField('Глубина зуба', 200);
const hintDeep = await currentToothHint();
const hudDeep = await hud();
console.log('depth 200       :', JSON.stringify(hintDeep), '|', hudDeep);
if (!hintDeep || !near(hintDeep.area * 0.2, hintDeep.volume, 0.03)) {
  throw new Error(`tooth volume must follow its depth: ${JSON.stringify(hintDeep)}`);
}
if (!near(hintDeep.area, hintWide.area, 0.006)) {
  throw new Error('changing the tooth depth must not change its footprint');
}
if (!near(volumeFromHud(hudDeep) - volBase, hintDeep.volume, 0.02)) {
  throw new Error('the HUD did not pick up the deeper tooth');
}

// Everything survives a reload.
const beforeReload = { hud: hudDeep, width: await fieldValue('Ширина зуба'), depth: await fieldValue('Глубина зуба') };
await page.reload({ waitUntil: 'networkidle0' });
await sleep(700);
await sheetTab('Глубина');
const sw2 = await toothSwitch();
const afterReload = { hud: await hud(), width: await fieldValue('Ширина зуба'), depth: await fieldValue('Глубина зуба') };
console.log('after reload    :', JSON.stringify(sw2), '|', JSON.stringify(afterReload));
if (!sw2?.checked) throw new Error('the tooth switch was not restored');
if (afterReload.width !== beforeReload.width || afterReload.depth !== beforeReload.depth) {
  throw new Error('tooth dimensions were not restored');
}
if (afterReload.hud !== beforeReload.hud) throw new Error('the tooth volume was not restored');

// Turning it off returns the original volume and hides the fields.
await toggleTooth();
const hudOff = await hud();
console.log('switch off      :', hudOff);
if ((await toothSwitch())?.checked) throw new Error('the switch did not turn off');
if (await fieldInput('Ширина зуба')) throw new Error('tooth fields must hide when disabled');
if (!near(volumeFromHud(hudOff), volBase, 0.02)) {
  throw new Error(`turning the tooth off must subtract its volume: ${volumeFromHud(hudOff)} vs ${volBase}`);
}
await page.screenshot({ path: '/tmp/opencode/tooth-off.png' });

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
