import puppeteer from 'puppeteer-core';

// Folder-first home: a calculation can only be created inside a folder. This
// covers creating folders and calculations, moving a calculation between
// folders, renaming, deleting a folder with its contents, and migrating an old
// save that kept calculations at the root.
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
page.on('dialog', (d) => d.accept());
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const text = (sel) => page.$eval(sel, (e) => e.textContent?.trim()).catch(() => null);
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent?.trim()));
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const wait = (sel) => page.waitForSelector(sel, { timeout: 3000 });

const clickText = async (selector, label) => {
  const hs = await page.$$(selector);
  for (const h of hs) {
    if ((await h.evaluate((e) => e.textContent?.trim())) === label) {
      await h.click();
      await sleep(220);
      return;
    }
  }
  throw new Error(`no ${selector} labelled ${label}`);
};

const cardAction = async (title) => {
  const cards = await page.$$('.card');
  for (const card of cards) {
    const t = await card.$eval('.card__title', (e) => e.textContent?.trim()).catch(() => null);
    if (t !== title) continue;
    await (await card.$('.card__act')).click();
    await sleep(220);
    return;
  }
  throw new Error('card not found: ' + title);
};

const nameDialog = async (value) => {
  await wait('.modal__input');
  await page.click('.modal__input');
  await page.evaluate(() => {
    const input = document.querySelector('.modal__input');
    if (input) input.select();
  });
  await page.keyboard.type(value);
  const buttons = await page.$$('.confirm .btn');
  await buttons[1].click();
  await sleep(340);
};

const openFolder = async (name) => {
  const cards = await page.$$('.folder-card');
  for (const card of cards) {
    const t = await card.$eval('.card__title', (e) => e.textContent?.trim()).catch(() => null);
    if (t !== name) continue;
    await (await card.$('.card__main')).click();
    await sleep(300);
    return;
  }
  throw new Error('folder card not found: ' + name);
};

const backToFolders = async () => {
  await page.click('.fview__head [aria-label="Назад к папкам"]');
  await sleep(300);
};

const addCalculation = async (which) => {
  await page.click('.addcalc');
  await sleep(280);
  const cards = await page.$$('.typecard');
  await cards[which].click();
  await sleep(420);
  await page.click('.ed-head [aria-label="Назад"]');
  await sleep(340);
};

const folderState = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('beton.projects.v2');
    const s = raw ? JSON.parse(raw) : null;
    return s
      ? {
          folders: s.folders?.map((f) => ({ id: f.id, name: f.name })) ?? [],
          projects: s.projects?.map((p) => ({ name: p.name, folder: p.folderId })) ?? [],
        }
      : null;
  });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await sleep(340);

// 1. A fresh install offers a folder, not a loose calculation.
console.log('empty home     :', await text('.empty'));
if (!/папках/.test((await text('.empty')) ?? '')) throw new Error('the empty home must explain folders');
if ((await count('.addcalc')) !== 0) throw new Error('a calculation cannot be created outside a folder');

// 2. An old save with a root calculation moves into a folder on upgrade.
await page.evaluate(() => {
  localStorage.setItem(
    'beton.projects.v2',
    JSON.stringify({
      folders: [],
      projects: [
        {
          id: 'p_legacy',
          kind: 'slab',
          stage: 'outline',
          name: 'Старый расчёт',
          folderId: null,
          createdAt: 1,
          updatedAt: 1,
          slab: { contours: [], thickness: 200, entered: false },
        },
      ],
      currentId: null,
    }),
  );
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(420);
console.log('migrated       :', await texts('.folder-card .card__title'), '|', await text('.folder-card .card__meta'));
if (JSON.stringify(await texts('.folder-card .card__title')) !== JSON.stringify(['Мои расчёты'])) {
  throw new Error('a root calculation must land in a folder: ' + (await texts('.folder-card .card__title')));
}
await openFolder('Мои расчёты');
if (!(await texts('.card__title')).includes('Старый расчёт')) {
  throw new Error('the migrated calculation must be visible inside its folder');
}
await backToFolders();

// 3. A named folder opens empty and holds the new-calculation action.
await page.click('.section-head__add');
await nameDialog('Дом');
console.log('folder created :', await text('.fview__name'), '|', await text('.fview__meta'));
if ((await text('.fview__name')) !== 'Дом') throw new Error('folder name was not saved');
if ((await text('.fview__meta')) !== 'Пока пусто') throw new Error('a new folder must be empty');

// 4. Both kinds are created inside the open folder.
await addCalculation(0);
await addCalculation(1);
console.log('folder titles  :', await texts('.card__title'));
if (JSON.stringify(await texts('.card__title')) !== JSON.stringify(['Лента', 'Плита'])) {
  throw new Error('new calculations must be named Плита and Лента: ' + (await texts('.card__title')));
}
await backToFolders();
if (JSON.stringify(await texts('.folder-card .card__title')) !== JSON.stringify(['Дом', 'Мои расчёты'])) {
  throw new Error('the folder list must show both folders: ' + (await texts('.folder-card .card__title')));
}
if ((await texts('.card__meta'))[0] !== '2 расчёта') {
  throw new Error('the folder card must count its calculations: ' + (await texts('.card__meta')));
}

// 5. A second folder, then a move from one folder to the other from the card menu.
await page.click('.section-head__add');
await nameDialog('Участок');
await backToFolders();
await openFolder('Дом');
await cardAction('Плита');
await clickText('.actions .action', 'Переместить в другую папку');
if ((await count('.pickrow')) !== 2) throw new Error('every other folder must be offered as a destination');
await clickText('.pickrow', 'Участок');
await sleep(340);
let st = await folderState();
const slab = st.projects.find((p) => p.name === 'Плита');
const plotId = st.folders.find((f) => f.name === 'Участок')?.id;
if (!slab?.folder || slab.folder !== plotId) throw new Error('the calculation did not move into Участок');
if (!(await texts('.card__title')).includes('Лента')) throw new Error('the other calculation left Дом');
if ((await texts('.card__title')).includes('Плита')) throw new Error('the moved calculation is still in Дом');
await backToFolders();
await openFolder('Участок');
if (!(await texts('.card__title')).includes('Плита')) throw new Error('Плита must be inside Участок');

// 6. Rename the calculation and the folder from the folder header.
await cardAction('Плита');
await clickText('.actions .action', 'Переименовать');
await nameDialog('Фундамент');
if (!(await texts('.card__title')).includes('Фундамент')) throw new Error('card title did not follow the rename');
await page.click('.fview__head [aria-label^="Действия: папка"]');
await sleep(220);
await clickText('.actions .action', 'Переименовать папку');
await nameDialog('Площадка');
if ((await text('.fview__name')) !== 'Площадка') throw new Error('folder rename was not applied');

// 7. Everything survives a reload, including folder membership.
await page.reload({ waitUntil: 'networkidle0' });
await sleep(460);
console.log('after reload   :', await texts('.folder-card .card__title'));
if (!(await texts('.folder-card .card__title')).includes('Площадка')) {
  throw new Error('folder name was not persisted');
}
await openFolder('Площадка');
if (!(await texts('.card__title')).includes('Фундамент')) throw new Error('project name was not persisted');

// 8. Deleting a folder deletes all calculations inside it, with its own confirm.
await page.click('.fview__head [aria-label^="Действия: папка"]');
await sleep(220);
await clickText('.actions .action', 'Удалить папку');
await wait('.confirm');
const folderConfirm = await text('.confirm__text');
console.log('folder confirm :', folderConfirm);
if (!/все расчёты внутри/.test(folderConfirm ?? '')) {
  throw new Error('the folder confirmation must warn about its calculations: ' + folderConfirm);
}
await clickText('.confirm .btn', 'Удалить всё');
await sleep(420);
console.log('after delete   : folders', await texts('.folder-card .card__title'));
if ((await text('.fview__name')) !== null) throw new Error('deleting the open folder must return to the folder list');
if ((await texts('.folder-card .card__title')).includes('Площадка')) throw new Error('the folder must be gone');
st = await folderState();
if (st.folders.some((f) => f.name === 'Площадка')) throw new Error('the folder is still in storage');
if (st.projects.some((p) => p.name === 'Фундамент')) throw new Error('its calculation is still in storage');

// 9. A single calculation is still deleted with its own confirmation.
await openFolder('Дом');
await cardAction('Лента');
await clickText('.actions .action', 'Удалить расчёт');
await wait('.confirm');
if ((await text('.confirm .modal__title')) !== 'Удалить расчёт?') {
  throw new Error('deleting a calculation needs its own confirmation');
}
await clickText('.confirm .btn', 'Удалить');
await sleep(380);
if ((await count('.card')) !== 0) throw new Error('only the chosen calculation must be deleted');
if (!/появятся расчёты/.test((await text('.fview__empty')) ?? '')) {
  throw new Error('an empty folder needs a calm hint');
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
