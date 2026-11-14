import puppeteer from 'puppeteer-core';

// Covers two reported issues:
//  1. several pinned sides + editing a protrusion must move the opposite free side
//     instead of collapsing it (old code answered with a "0 мм" alert);
//  2. contour and thickness are parallel tabs, both always reachable, no
//     Далее / Назад / Готово, and every change is stored immediately.
const URL = process.env.URL ?? 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const text = async (s) => page.$eval(s, (e) => e.textContent?.trim() ?? '').catch(() => null);
const vals = () => page.$$eval('.chip__value', (els) => els.map((e) => e.textContent));
const pinnedVals = () => page.$$eval('.chip--pinned .chip__value', (els) => els.map((e) => e.textContent));
const toast = () => page.$eval('.toast', (e) => e.textContent).catch(() => null);
const hud = () => page.$eval('.hud', (e) => e.textContent).catch(() => null);
const tab = async (label) => {
  const hs = await page.$$('.sheet .segmented__item');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error('no tab ' + label);
};
const typeInto = async (selector, value) => {
  await page.click(selector);
  await sleep(180);
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await sleep(420);
};

const C = [
  [0, 0],
  [2000, 0],
  [2000, 1000],
  [500, 1000],
  [500, 3000],
  [2000, 3000],
  [2000, 4000],
  [0, 4000],
];
const lens = [2000, 1000, 1500, 2000, 1500, 1000, 2000, 4000];
const now = Date.now();
const project = {
  id: 'pseed',
  kind: 'slab',
  stage: 'dims',
  createdAt: now,
  updatedAt: now,
  slab: {
    raw: C.map(([x, y]) => ({ x, y })),
    base: C.map(([x, y]) => ({ x, y })),
    pivot: { x: 1000, y: 2000 },
    sx: 1,
    sy: 1,
    lens,
    pinned: [0, 2, 4],
    entered: true,
    thickness: 200,
    vThickness: C.map(() => null),
  },
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(async (p) => {
  localStorage.clear();
  localStorage.setItem('beton.projects.v2', JSON.stringify({ projects: [p], currentId: p.id }));
}, project);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(600);

console.log('subtitle        :', await text('.ed-head__subtitle'));
console.log('tabs            :', await page.$$eval('.sheet .segmented__item', (els) => els.map((e) => e.textContent?.trim())));
console.log('old step buttons:', await page.$$eval('.sheet .btn', (els) => els.map((e) => e.textContent?.trim())));
console.log('values          :', await vals(), '| pinned:', await pinnedVals());

// edit a protrusion side while three horizontal sides are locked
await typeInto('.chip:nth-of-type(1) .chip__btn', 2500);
console.log('after 2500      :', await vals(), '| pinned:', await pinnedVals());
console.log('toast           :', await toast());
console.log('hud             :', await hud());

// tabs are parallel: thickness is reachable without any "next" step
await tab('Толщина');
await sleep(350);
console.log('depth subtitle  :', await text('.ed-head__subtitle'), '| chips:', (await vals()).length);
await typeInto('.chip:nth-of-type(1) .chip__btn', 300);
console.log('sloped hud      :', await hud());
await page.screenshot({ path: '/tmp/slab-tabs-depth.png' });

await tab('Контур');
await sleep(350);
console.log('back to dims    :', await text('.ed-head__subtitle'), '| values:', await vals());

// leaving with "<" keeps everything; reopening resumes the same tab
await page.click('.ed-head .icon-btn');
await sleep(350);
// The home now lists folders first, so step into the calculation's folder.
await page.click('.folder-card .card__main');
await sleep(300);
const cards = await page.$$('.card__main');
await cards[0].click();
await sleep(500);
console.log('reopened        :', await text('.ed-head__subtitle'), '| chips:', (await vals()).length);
await tab('Контур');
await sleep(300);
console.log('after reopen    :', await vals(), '| pinned:', await pinnedVals());

await page.screenshot({ path: '/tmp/slab-tabs.png' });

await page.reload({ waitUntil: 'networkidle0' });
await sleep(700);
console.log('after reload    :', await text('.ed-head__subtitle'));
await tab('Контур');
await sleep(300);
console.log('persisted       :', await vals(), '| pinned:', await pinnedVals());
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
