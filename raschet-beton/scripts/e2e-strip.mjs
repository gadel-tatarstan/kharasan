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
// Destructive actions use the styled in-app confirmation; the button helper accepts it.
page.on('dialog', (d) => d.accept());
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const tap = async (x, y) => { await page.mouse.click(x, y); await sleep(140); };
const vals = () => page.$$eval('.chip__value', (els) => els.map((e) => e.textContent));
const pinnedVals = () => page.$$eval('.chip--pinned .chip__value', (els) => els.map((e) => e.textContent));
const toast = () => page.$eval('.toast', (e) => e.textContent).catch(() => null);
const hud = () => page.$eval('.hud', (e) => e.textContent).catch(() => null);
const sceneSize = () => page.$eval('.scene-size', (e) => e.textContent?.trim()).catch(() => null);
const meta = () => page.$eval('.sheet__meta', (e) => e.textContent).catch(() => null);
/** Every meta line of the sheet: counts, hints and the pin counter. */
const allMeta = () =>
  page.$$eval('.sheet__meta', (els) => els.map((e) => e.textContent?.trim()).join(' | ')).catch(() => null);
const counts = (s) => {
  const m = /точек:\s*(\d+)\s*·\s*отрезков:\s*(\d+)/.exec(s ?? '');
  return m ? { nodes: Number(m[1]), segs: Number(m[2]) } : null;
};
/** The contour itself, read from the saved project (the dims tab has no counters). */
const geoCounts = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('beton.projects.v2');
    if (!raw) return null;
    const s = JSON.parse(raw);
    const p = s.projects?.find((x) => x.id === s.currentId);
    if (!p?.strip) return null;
    return { nodes: p.strip.nodes?.length ?? 0, segs: p.strip.segs?.length ?? 0 };
  });
const subtitle = () => page.$eval('.ed-head__subtitle', (e) => e.textContent).catch(() => null);
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
/** Same scan from the bottom, for a branch away from a pinned top edge. */
const bottomBandPoint = (ratio = 0.5) =>
  page.evaluate((r) => {
    const canvas = document.querySelector('.plan-canvas canvas');
    const ctx = canvas.getContext('2d');
    if (!canvas || !ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x = Math.round(canvas.width * r);
    for (let y = canvas.height - 1; y >= 0; y--) {
      const i = (y * canvas.width + x) * 4;
      const [red, green, blue, alpha] = [
        img.data[i],
        img.data[i + 1],
        img.data[i + 2],
        img.data[i + 3],
      ];
      if (alpha > 200 && red > 230 && green > 110 && green < 170 && blue > 50 && blue < 110) {
        return {
          x: (x / canvas.width) * canvas.clientWidth,
          y: (y / canvas.height) * canvas.clientHeight,
        };
      }
    }
    return null;
  }, ratio);

/** Same scan from the top, for the opposite side of a ring. */
const topBandPoint = (ratio = 0.5) =>
  page.evaluate((r) => {
    const canvas = document.querySelector('.plan-canvas canvas');
    const ctx = canvas.getContext('2d');
    if (!canvas || !ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x = Math.round(canvas.width * r);
    for (let y = 0; y < canvas.height; y++) {
      const i = (y * canvas.width + x) * 4;
      const [red, green, blue, alpha] = [
        img.data[i],
        img.data[i + 1],
        img.data[i + 2],
        img.data[i + 3],
      ];
      if (alpha > 200 && red > 230 && green > 110 && green < 170 && blue > 50 && blue < 110) {
        return {
          x: (x / canvas.width) * canvas.clientWidth,
          y: (y / canvas.height) * canvas.clientHeight,
        };
      }
    }
    return null;
  }, ratio);

/** Centres of the orange vertex dots, canvas-local CSS px. */
const nodeDots = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.plan-canvas canvas');
    if (!canvas) return [];
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const W = canvas.width;
    const H = canvas.height;
    const seen = new Uint8Array(W * H);
    const isDot = (i) =>
      img.data[i + 3] > 200 &&
      img.data[i] > 225 &&
      img.data[i + 1] > 140 &&
      img.data[i + 1] < 205 &&
      img.data[i + 2] > 85 &&
      img.data[i + 2] < 160;
    const out = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k0 = y * W + x;
        if (seen[k0] || !isDot(k0 * 4)) continue;
        const stack = [[x, y]];
        seen[k0] = 1;
        let n = 0;
        let sx = 0;
        let sy = 0;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          n++;
          sx += cx;
          sy += cy;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = ny * W + nx;
            if (seen[k]) continue;
            seen[k] = 1;
            if (isDot(k * 4)) stack.push([nx, ny]);
          }
        }
        if (n >= 12) out.push({ x: sx / n, y: sy / n });
      }
    }
    const sx = canvas.clientWidth / W;
    const sy = canvas.clientHeight / H;
    return out.map((d) => ({ x: d.x * sx, y: d.y * sy }));
  });

const typeInto = async (selector, value) => {
  await page.click(selector);
  await sleep(200);
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await sleep(420);
};
/**
 * Finds a face number by where it sits on the plan: inside/outside the band and
 * above/below the canvas centre. Chip order is not stable, positions are.
 */
const faceChip = async ({ inner = false, top = false } = {}) => {
  const b = await page.$eval('.plan-canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { y: r.y, h: r.height };
  });
  const cs = await page.evaluate(() =>
    [...document.querySelectorAll('.chip')].map((c, i) => {
      const r = c.getBoundingClientRect();
      return {
        i,
        value: c.querySelector('.chip__value')?.textContent ?? '',
        muted: c.classList.contains('chip--muted'),
        pinned: c.classList.contains('chip--pinned'),
        y: r.y + r.height / 2,
      };
    }),
  );
  const cy = b.y + b.h / 2;
  const pool = cs.filter((c) => (inner ? c.muted : !c.muted));
  const half = pool.filter((c) => (top ? c.y < cy : c.y > cy));
  const pick = (half.length ? half : pool).sort((x, y) => (top ? x.y - y.y : y.y - x.y))[0];
  if (!pick) throw new Error('no face chip for ' + JSON.stringify({ inner, top }));
  return pick;
};
const typeFace = async (where, value) => {
  const chip = await faceChip(where);
  await typeInto(`.chip:nth-of-type(${chip.i + 1}) .chip__btn`, value);
  return chip;
};
const longPressFace = async (where) => {
  const chip = await faceChip(where);
  await longPress(chip.i);
  return chip;
};
/** Outer face chip at the far left/right of the plan: a perpendicular wall. */
const sideFaceChip = async (side) => {
  const cs = await page.evaluate(() =>
    [...document.querySelectorAll('.chip')].map((c, i) => {
      const r = c.getBoundingClientRect();
      return {
        i,
        muted: c.classList.contains('chip--muted'),
        x: r.x + r.width / 2,
        value: c.querySelector('.chip__value')?.textContent ?? '',
      };
    }),
  );
  const pool = cs.filter((c) => !c.muted);
  const pick = pool.sort((a, b) => (side === 'left' ? a.x - b.x : b.x - a.x))[0];
  if (!pick) throw new Error('no ' + side + ' face chip');
  return pick;
};
/** Left/right edges of the whole orange band, in CSS pixels. */
const bandSpan = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.plan-canvas canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let min = Infinity;
    let max = -1;
    for (let i = 0; i < img.data.length; i += 4) {
      const [red, green, blue, alpha] = [
        img.data[i],
        img.data[i + 1],
        img.data[i + 2],
        img.data[i + 3],
      ];
      if (alpha > 200 && red > 230 && green > 110 && green < 170 && blue > 50 && blue < 110) {
        const x = (i / 4) % canvas.width;
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    if (max < 0) return null;
    const k = canvas.clientWidth / canvas.width;
    return { left: min * k, right: max * k, width: (max - min) * k };
  });
const faceValue = async (where) => (await faceChip(where)).value;
const longPress = async (index) => {
  const chip = (await page.$$('.chip'))[index];
  const bb = await chip.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await sleep(680);
  await page.mouse.up();
  await sleep(360);
};
const btnLabels = () => page.$$eval('.sheet .btn', (els) => els.map((e) => e.textContent?.trim()));
const clickBtn = async (label) => {
  const hs = await page.$$('.sheet .btn');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t !== label) continue;
    await h.click();
    await sleep(180);
    // Destructive actions open the styled in-app confirmation.
    const yes = await page.$$('.confirm .btn');
    for (const b of yes) {
      const y = await b.evaluate((e) => e.textContent?.trim());
      if (['Очистить', 'Удалить'].includes(y)) {
        await b.click();
        await sleep(220);
        break;
      }
    }
    return;
  }
  throw new Error('no button ' + label);
};
const sheetTab = async (label) => {
  const hs = await page.$$('.sheet .segmented__item');
  for (const h of hs) {
    const t = await h.evaluate((e) => e.textContent?.trim());
    if (t === label) return h.click();
  }
  throw new Error('no tab ' + label);
};

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

// 1. no setup screen any more — the strip opens on the canvas
console.log('opens on canvas :', await subtitle(), '| buttons:', await btnLabels());

const box = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// closed ring: three sides are drawn, the fourth corner must be auto-added
// when the user taps the starting vertex that is not on the same line.
await tap(box.x + 100, box.y + 200);
await tap(box.x + 300, box.y + 205);
await tap(box.x + 300, box.y + 400);
await tap(box.x + 100, box.y + 200);
await sleep(450);
const ringMeta = await meta();
const ringToast = await toast();
console.log('ring meta       :', ringMeta, '| toast:', ringToast);
if (ringToast) throw new Error('auto-close must not warn: ' + ringToast);
if (!/отрезков:\s*4/.test(ringMeta ?? '')) {
  throw new Error('auto-close must add the missing corner: ' + ringMeta);
}

await clickBtn('К размерам');
await sleep(450);
console.log('contour tab     :', await subtitle(), '| chips:', await count('.chip'), '| buttons:', await btnLabels());
console.log('no Готово/Далее :', !(await btnLabels()).some((l) => /Готово|Далее/.test(l)));

// Labels must be readable on both sides of every segment: no pair may cover
// another, the value has to sit vertically in the middle, and a label near the
// border keeps its geometric spot instead of being clamped to the screen edge.
const chipBoxes = () => page.evaluate(() =>
  [...document.querySelectorAll('.chip')].map((c) => {
    const r = c.getBoundingClientRect();
    const v = c.querySelector('.chip__value');
    const vr = v ? v.getBoundingClientRect() : null;
    return {
      text: c.textContent?.trim(),
      left: parseFloat(c.style.left),
      top: parseFloat(c.style.top),
      w: r.width,
      h: r.height,
      vTop: vr ? vr.top - r.top : null,
      vBottom: vr ? r.bottom - vr.bottom : null,
    };
  }),
);
const chipOverlaps = (cs) => {
  let n = 0;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i];
      const b = cs[j];
      const ox = Math.min(a.left + a.w / 2, b.left + b.w / 2) - Math.max(a.left - a.w / 2, b.left - b.w / 2);
      const oy = Math.min(a.top + a.h / 2, b.top + b.h / 2) - Math.max(a.top - a.h / 2, b.top - b.h / 2);
      if (ox > 2 && oy > 2) n++;
    }
  }
  return n;
};
const assertLabels = async (when) => {
  const cs = await chipBoxes();
  const offCentre = cs.filter((c) => c.vTop !== null && Math.abs(c.vTop - c.vBottom) > 2);
  const overlaps = chipOverlaps(cs);
  console.log(`labels ${when}`.padEnd(16) + ':', JSON.stringify({ count: cs.length, overlaps, offCentre: offCentre.length, minLeft: Math.round(Math.min(...cs.map((c) => c.left))) }));
  if (cs.length !== 8) throw new Error(`${when}: every segment needs two labels, got ${cs.length}`);
  if (overlaps) throw new Error(`${when}: ${overlaps} label pair(s) overlap`);
  if (offCentre.length) throw new Error(`${when}: value is not vertically centred`);
  if (Math.min(...cs.map((c) => c.left)) >= 52) {
    throw new Error(`${when}: labels were clamped to the canvas edge`);
  }
};
await assertLabels('contour');

// 2. first typed length sets the millimetre scale and pins itself
await typeFace({ inner: false }, 4000);
console.log('after 4000      :', await vals(), '| pinned:', await pinnedVals(), '| hud:', await hud());
await assertLabels('after 4000');

// 2b. re-editing the same face leaves the opposite face free: it must absorb
// the difference without a false "pinned sides" alert.
await typeFace({ inner: false }, 4500);
const repeatToast = await toast();
console.log('same face 4500  : toast =', repeatToast, '| values:', await vals());
if (repeatToast) throw new Error('editing one face must not warn while another is free: ' + repeatToast);

// 3. long press releases the pin; the geometry must not move
const beforeUnpin = await vals();
await longPressFace({ inner: false });
console.log('after unpin     :', await pinnedVals(), '| values stable:',
  JSON.stringify(beforeUnpin) === JSON.stringify(await vals()));

// 4. editing the opposite face slides it — no alert, both sides equal
await typeFace({ inner: false, top: true }, 5000);
const topAfterSlide = await faceValue({ inner: false, top: true });
const bottomAfterSlide = await faceValue({ inner: false, top: false });
console.log('opposite 5000   : toast =', await toast(), '| top:', topAfterSlide,
  '| bottom:', bottomAfterSlide, '| pinned:', await pinnedVals());
console.log('hud after slide :', await hud());
if (await toast()) throw new Error('editing the opposite face must not warn: ' + (await toast()));
if (!/5\s*000/.test(topAfterSlide) || topAfterSlide !== bottomAfterSlide) {
  throw new Error('the ring must close with both faces at 5000: ' + topAfterSlide + ' / ' + bottomAfterSlide);
}

// 5. the top face is now fixed: a contradicting bottom value is refused and
//    asks the user to release a parallel green side
const locked = await vals();
await typeFace({ inner: false }, 6000);
const conflictToast = await toast();
console.log('conflict toast  :', conflictToast);
console.log('unchanged       :', JSON.stringify(locked) === JSON.stringify(await vals()));
if (!/Открепите/.test(conflictToast ?? '')) {
  throw new Error('a pinned opposite face must raise the conflict hint: ' + conflictToast);
}
if (JSON.stringify(locked) !== JSON.stringify(await vals())) {
  throw new Error('a refused edit must not move the plan');
}
await page.click('.toast').catch(() => {});
await sleep(300);
const pinsAfterConflict = await pinnedVals();
console.log('pins after conflict:', pinsAfterConflict);
if (pinsAfterConflict.length !== 1) {
  throw new Error('a refused edit must leave exactly one green face: ' + pinsAfterConflict);
}

// 5b. a pinned perpendicular wall keeps its position when the length grows
await longPressFace({ inner: false, top: true }); // release the only green face
// The plan was fitted before it grew, so the walls may sit outside the canvas.
// Pinch inward (zoom out) around the top of the plan, away from the sheet.
const pb = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cdp = await page.createCDPSession();
const touch = (id, x, y) => ({ x, y, id, radiusX: 6, radiusY: 6, force: 1 });
const zx = pb.x + pb.w / 2;
const zy = pb.y + pb.h * 0.3;
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [touch(1, zx - 150, zy), touch(2, zx + 150, zy)],
});
for (let i = 1; i <= 6; i += 1) {
  const spread = 150 - i * 20;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [touch(1, zx - spread, zy), touch(2, zx + spread, zy)],
  });
  await sleep(18);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
// Now that the whole plan fits, pin the far-left perpendicular wall.
const leftWall = await sideFaceChip('left');
await longPress(leftWall.i);
await sleep(200);
console.log('pinned wall     :', leftWall.value, '| green:', await pinnedVals());
if (!(await pinnedVals()).length) throw new Error('long press on the wall did not pin it');
const wallBefore = await bandSpan();
await typeFace({ inner: false }, 5600);
const wallAfter = await bandSpan();
console.log('pinned left wall:', 'before', wallBefore, '| after', wallAfter);
if (!wallBefore || !wallAfter) throw new Error('band edges were not found on the canvas');
if (Math.abs(wallAfter.left - wallBefore.left) > 2) {
  throw new Error('a pinned perpendicular wall must not move: ' + JSON.stringify({ wallBefore, wallAfter }));
}
if (Math.abs(wallAfter.width / wallBefore.width - 5600 / 5000) > 0.03) {
  throw new Error(
    'the free wall must take the whole change: ' + (wallAfter.width / wallBefore.width).toFixed(3),
  );
}

await page.screenshot({ path: '/tmp/strip-contour.png' });

// 6. per-segment width: a tap on the band opens the inspector for that segment
let picked = false;
for (let gy = 0.16; gy <= 0.94 && !picked; gy += 0.05) {
  for (let gx = 0.1; gx <= 0.92 && !picked; gx += 0.05) {
    await tap(box.x + box.w * gx, box.y + box.h * gy);
    if (await page.$('.chip__input')) {
      await page.keyboard.press('Escape');
      continue;
    }
    const title = await page.$eval('.sheet__title', (e) => e.textContent).catch(() => null);
    if (title === 'Ширина участка') picked = true;
  }
}
console.log('after scan      :', await hud(), '| values:', await vals());
console.log('width inspector :', await page.$eval('.sheet__title', (e) => e.textContent).catch(() => null));
const widthRow = await page.evaluate(() => {
  const field = document.querySelector('.row--wide-field .field');
  const btn = [...document.querySelectorAll('.row--wide-field .btn')].find(
    (b) => b.textContent?.trim() === 'Всем',
  );
  return {
    field: field ? field.getBoundingClientRect().width : 0,
    btn: btn ? btn.getBoundingClientRect().width : 0,
  };
});
console.log('width row       :', JSON.stringify(widthRow));
if (widthRow.field < widthRow.btn * 1.8) {
  throw new Error('the width number field must be about twice the button');
}
const widthStepper = (await page.$$('.field .stepper'))[1];
if (widthStepper) await widthStepper.click();
await sleep(320);
console.log('width stepper   : badges =', await count('.chip--width'), '| meta:', await meta());
await page.screenshot({ path: '/tmp/strip-width.png' });

// 6b. the inspector is a detour, not a dead end: a compact back link returns
// to contour editing without hunting for the active tab.
await page.click('.backlink');
await sleep(320);
const backButtons = await btnLabels();
console.log('back to contour :', JSON.stringify(backButtons));
if (!backButtons.includes('Добавить линию')) {
  throw new Error('back link did not restore contour editing: ' + backButtons);
}

// 7. the depth tab is a sibling tab, not a next step
const volumeBefore = await hud();
await sheetTab('Глубина');
await sleep(420);
console.log('depth tab       :', await subtitle(), '| chips:', await count('.chip'), '| buttons:', await btnLabels());
await typeInto('.chip:nth-of-type(1) .chip__btn', 300);
console.log('depth 300       :', await hud());
console.log('volume changed  :', volumeBefore !== (await hud()));
// A long press must no longer reset the segment depth to the common one.
const depthBeforeLongPress = await hud();
await longPress(0);
await page.keyboard.press('Escape');
await sleep(220);
console.log('depth long press:', depthBeforeLongPress === (await hud()) ? 'kept' : 'reset');
if (depthBeforeLongPress !== (await hud())) {
  throw new Error('long press must not reset the segment depth');
}
await page.screenshot({ path: '/tmp/strip-depth.png' });

await sheetTab('Контур');
await sleep(400);
console.log('back to contour :', await subtitle(), '| chips:', await count('.chip'), '| hud:', await hud());

// 8. everything is stored on every change
const beforeReload = { vals: await vals(), subtitle: await subtitle(), hud: await hud() };
await page.reload({ waitUntil: 'networkidle0' });
await sleep(800);
console.log('after reload    :', await subtitle(), '| same values:',
  JSON.stringify(beforeReload.vals) === JSON.stringify(await vals()), '| same hud:',
  beforeReload.hud === (await hud()));
console.log('persisted pins  :', await pinnedVals());

// 9. the axis may cross itself: it becomes one interchange, not two separate
//    bands, and the union must not warn.
await clickBtn('Очистить холст');
await sleep(500);
const b3 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b3.x + 100, b3.y + 200);
await tap(b3.x + 300, b3.y + 200);
await tap(b3.x + 300, b3.y + 500);
await tap(b3.x + 100, b3.y + 500);
await tap(b3.x + 100, b3.y + 300);
await tap(b3.x + 350, b3.y + 300); // crosses the vertical side -> interchange
await sleep(500);
const crossMeta = await meta();
const crossToast = await toast();
console.log('self-crossing   :', crossMeta, '| toast:', crossToast);
if (crossToast) throw new Error('self-crossing must be allowed: ' + crossToast);
if (!/отрезков:\s*5/.test(crossMeta ?? '')) {
  throw new Error('self-crossing segment was not added: ' + crossMeta);
}
await clickBtn('К размерам');
await sleep(500);
console.log('cross volume    :', await hud());

// 10. a tap on an existing edge splits it and connects to the new node
await clickBtn('Очистить холст');
await sleep(500);
const b4 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b4.x + 100, b4.y + 200);
await tap(b4.x + 300, b4.y + 200);
await tap(b4.x + 300, b4.y + 400);
await tap(b4.x + 200, b4.y + 400);
await tap(b4.x + 200, b4.y + 200); // tap the first edge -> split + connect
await sleep(500);
const edgeMeta = await meta();
const edgeToast = await toast();
console.log('edge connection :', edgeMeta, '| toast:', edgeToast);
if (edgeToast) throw new Error('edge connection must not warn: ' + edgeToast);
if (!/отрезков:\s*5/.test(edgeMeta ?? '')) {
  throw new Error('edge tap did not split and connect: ' + edgeMeta);
}

// 11. after the dimensions are entered the strip can still grow: a new line
//     and a branch must both work, keep the typed length and update the size.
await clickBtn('К размерам');
await sleep(450);
await clickBtn('Очистить холст');
await sleep(450);
const b5 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b5.x + 100, b5.y + 150);
await tap(b5.x + 300, b5.y + 150);
await tap(b5.x + 300, b5.y + 350);
await tap(b5.x + 100, b5.y + 350);
await tap(b5.x + 100, b5.y + 150);
await sleep(450);
await clickBtn('К размерам');
await sleep(450);
await typeInto('.chip:nth-of-type(1) .chip__btn', 5000);
await sleep(450);
const sizeAt5 = await sceneSize();
if (!/5 × 5\s*м/.test(sizeAt5 ?? '')) {
  throw new Error('scene size badge must show 5 × 5 м: ' + sizeAt5);
}

await clickBtn('Добавить линию');
await sleep(350);
await tap(b5.x + 195, b5.y + 260);
await tap(b5.x + 195, b5.y + 340);
await sleep(450);
const addMeta = await meta();
const addToast = await toast();
console.log('add after dims  :', addMeta, '| size:', await sceneSize(), '| toast:', addToast);
if (addToast) throw new Error('adding a line after dims must not warn: ' + addToast);
if (!/отрезков:\s*5/.test(addMeta ?? '')) {
  throw new Error('new line after dims was not stored: ' + addMeta);
}
await clickBtn('Готово');
await sleep(450);
const keptPins = await pinnedVals();
if (!keptPins.some((v) => /5\s*000/.test(v ?? ''))) {
  throw new Error('typed dimension was lost after adding a line: ' + keptPins);
}

await clickBtn('Добавить линию');
await sleep(450);
const b6 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bottom = await bottomBandPoint(0.65);
if (!bottom) throw new Error('no band edge found for the branch test');
await tap(b6.x + bottom.x, b6.y + bottom.y - 2);
await sleep(450);
const edgeSplit = await meta();
const edgeSplitToast = await toast();
if (edgeSplitToast) throw new Error('branch edge tap after dims must not warn: ' + edgeSplitToast);
if (!/отрезков:\s*6/.test(edgeSplit ?? '')) {
  throw new Error('branch edge was not split after dims: ' + edgeSplit);
}
const b7 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bottom2 = await bottomBandPoint(0.65);
if (!bottom2) throw new Error('no band edge found after the split');
await tap(b7.x + bottom2.x, b7.y + bottom2.y - 70);
await sleep(450);
const branchMeta = await meta();
const branchToast = await toast();
console.log('branch after dims:', branchMeta, '| size:', await sceneSize(), '| toast:', branchToast);
if (branchToast) throw new Error('branch after dims must not warn: ' + branchToast);
if (!/отрезков:\s*7/.test(branchMeta ?? '')) {
  throw new Error('branch after dims was not stored: ' + branchMeta);
}
await clickBtn('Готово');
await sleep(450);
const branchPins = await pinnedVals();
if (!branchPins.some((v) => /5\s*000/.test(v ?? ''))) {
  throw new Error('typed dimension was lost after the branch: ' + branchPins);
}
await sleep(350);

// 12. finishing a line by tapping the band stretches the last segment to its
//     centreline instead of adding an L-shaped corner.
await clickBtn('Добавить линию');
await sleep(400);
const b8 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bottom3 = await bottomBandPoint(0.3);
if (!bottom3) throw new Error('no band edge found for the join test');
const penX = b8.x + b8.w * 0.4;
await tap(penX, b8.y + bottom3.y - 130);
await tap(penX, b8.y + bottom3.y - 60);
await sleep(400);
const beforeJoin = counts(await meta());
await tap(b8.x + bottom3.x, b8.y + bottom3.y - 2);
await sleep(500);
const afterJoin = counts(await meta());
const joinToast = await toast();
console.log('join on band   :', JSON.stringify({ beforeJoin, afterJoin }), '| toast:', joinToast);
if (joinToast) throw new Error('finishing on the band must not warn: ' + joinToast);
if (!beforeJoin || !afterJoin) throw new Error('could not read the join counts');
if (afterJoin.nodes !== beforeJoin.nodes) {
  throw new Error('finishing on the band added corner points: ' + JSON.stringify({ beforeJoin, afterJoin }));
}
if (afterJoin.segs !== beforeJoin.segs + 1) {
  throw new Error('finishing on the band must only split the target edge: ' + JSON.stringify({ beforeJoin, afterJoin }));
}
await clickBtn('Готово');
await sleep(400);

// 13. a branch started on one side of a ring and finished on the opposite
//     side must become one straight perpendicular segment (regression: the
//     connector used to run back along the band and warn about overlap).
await clickBtn('Очистить холст');
await sleep(500);
const b9 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b9.x + 100, b9.y + 150);
await tap(b9.x + 300, b9.y + 150);
await tap(b9.x + 300, b9.y + 350);
await tap(b9.x + 100, b9.y + 350);
await tap(b9.x + 100, b9.y + 150);
await sleep(450);
await clickBtn('К размерам');
await sleep(450);
await typeInto('.chip:nth-of-type(1) .chip__btn', 5000);
await sleep(450);
await clickBtn('Добавить линию');
await sleep(400);
const b10 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bottom4 = await bottomBandPoint(0.4);
const top4 = await topBandPoint(0.55);
if (!bottom4 || !top4) throw new Error('no opposite bands found');
await tap(b10.x + bottom4.x, b10.y + bottom4.y - 2);
await sleep(450);
const afterStart = counts(await meta());
await tap(b10.x + top4.x, b10.y + top4.y + 2);
await sleep(500);
const afterOpposite = counts(await meta());
const oppositeToast = await toast();
console.log('opposite sides :', JSON.stringify({ afterStart, afterOpposite }), '| toast:', oppositeToast);
if (oppositeToast) throw new Error('joining opposite sides must not warn: ' + oppositeToast);
if (!afterStart || !afterOpposite) throw new Error('could not read the opposite-side counts');
if (afterStart.segs !== afterOpposite.segs - 2 || afterOpposite.nodes !== afterStart.nodes + 1) {
  throw new Error(
    'opposite sides must join with one perpendicular segment: ' +
      JSON.stringify({ afterStart, afterOpposite }),
  );
}
await clickBtn('Готово');
await sleep(400);

// 14. «Отменить точку» must protect corners and merge a collinear split point.
await clickBtn('Очистить холст');
await sleep(550);
const b11 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b11.x + 100, b11.y + 150);
await tap(b11.x + 300, b11.y + 150);
await tap(b11.x + 300, b11.y + 350);
await sleep(450);
await clickBtn('К размерам');
await sleep(450);
await typeInto('.chip:nth-of-type(1) .chip__btn', 4000);
await sleep(400);
await clickBtn('Добавить линию');
await sleep(450);

const b12 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const dots = await nodeDots();
const topY = Math.min(...dots.map((d) => d.y));
const topDots = dots.filter((d) => Math.abs(d.y - topY) < 3);
const corner = topDots.reduce((m, d) => (d.x > m.x ? d : m), topDots[0]);
await tap(b12.x + corner.x, b12.y + corner.y);
await sleep(350);
const cornerState = counts(await meta());
const undoDisabled = () =>
  page.$$eval('.sheet .btn', (els) => {
    const b = els.find((e) => e.textContent?.trim() === 'Отменить точку');
    return b ? b.disabled : null;
  });
const cornerUndo = await undoDisabled();
console.log('undo corner    :', JSON.stringify({ state: cornerState, disabled: cornerUndo }));
if (cornerUndo !== true) throw new Error('undo must be disabled on a corner vertex');
if (!cornerState || cornerState.nodes !== 3 || cornerState.segs !== 2) {
  throw new Error('tapping a corner must not add a point: ' + JSON.stringify(cornerState));
}

await clickBtn('Готово');
await sleep(400);
await clickBtn('Добавить линию');
await sleep(400);
const b13 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const dots2 = await nodeDots();
const left = dots2.reduce((m, d) => (d.x < m.x ? d : m), dots2[0]);
const right = dots2.reduce((m, d) => (d.x > m.x ? d : m), dots2[0]);
const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 + 1 };
await tap(b13.x + mid.x, b13.y + mid.y);
await sleep(400);
const splitState = counts(await meta());
const splitUndo = await undoDisabled();
console.log('undo split     :', JSON.stringify({ state: splitState, disabled: splitUndo }));
if (splitUndo !== false) throw new Error('undo must be enabled on a collinear split point');
if (!splitState || splitState.nodes !== 4 || splitState.segs !== 3) {
  throw new Error('band tap must split the edge: ' + JSON.stringify(splitState));
}
await clickBtn('Отменить точку');
await sleep(450);
const mergedState = counts(await meta());
const mergeToast = await toast();
console.log('undo merged    :', JSON.stringify({ state: mergedState, toast: mergeToast }));
if (mergeToast) throw new Error('merging a split point must not warn: ' + mergeToast);
if (!mergedState || mergedState.nodes !== 3 || mergedState.segs !== 2) {
  throw new Error('undo must merge the split halves: ' + JSON.stringify(mergedState));
}
await clickBtn('Готово');
await sleep(400);

// 15. undo during a polyline removes the point with its edge, and a line drawn
//     back over an existing one merges into a single centreline (one dash).
await clickBtn('Очистить холст');
await sleep(550);
const b14 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b14.x + 100, b14.y + 150);
await tap(b14.x + 300, b14.y + 150);
await tap(b14.x + 300, b14.y + 350);
await sleep(450);
const drawnState = counts(await meta());
await clickBtn('Отменить точку');
await sleep(450);
const undoState = counts(await meta());
console.log('undo open chain:', JSON.stringify({ drawn: drawnState, after: undoState }));
if (!drawnState || drawnState.nodes !== 3 || drawnState.segs !== 2) {
  throw new Error('polyline must start with three points: ' + JSON.stringify(drawnState));
}
if (!undoState || undoState.nodes !== 2 || undoState.segs !== 1) {
  throw new Error('undo must remove the point with its edge: ' + JSON.stringify(undoState));
}

await clickBtn('К размерам');
await sleep(450);
await typeInto('.chip:nth-of-type(1) .chip__btn', 4000);
await sleep(400);
const hudBeforeMerge = await hud();
await clickBtn('Добавить линию');
await sleep(450);
const b15 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const dots3 = await nodeDots();
const right2 = dots3.reduce((m, d) => (d.x > m.x ? d : m), dots3[0]);
const left2 = dots3.reduce((m, d) => (d.x < m.x ? d : m), dots3[0]);
await tap(b15.x + right2.x, b15.y + right2.y);
await tap(b15.x + (left2.x + right2.x) / 2, b15.y + left2.y + 1);
await sleep(550);
const mergedOverlap = counts(await meta());
const overlapToast = await toast();
const hudAfterMerge = await hud();
console.log('overlap merge  :', JSON.stringify({ state: mergedOverlap, toast: overlapToast, sameHud: hudBeforeMerge === hudAfterMerge }));
if (overlapToast) throw new Error('drawing over a line must not warn: ' + overlapToast);
if (!mergedOverlap || mergedOverlap.nodes !== 3 || mergedOverlap.segs !== 2) {
  throw new Error('overlap must merge into two halves: ' + JSON.stringify(mergedOverlap));
}
if (hudBeforeMerge !== hudAfterMerge) {
  throw new Error('merge must not change the volume: ' + hudBeforeMerge + ' -> ' + hudAfterMerge);
}
await clickBtn('Отменить точку');
await sleep(500);
const restoreState = counts(await meta());
console.log('overlap undo   :', JSON.stringify(restoreState));
if (!restoreState || restoreState.nodes !== 2 || restoreState.segs !== 1) {
  throw new Error('undo after a merge must restore the single edge: ' + JSON.stringify(restoreState));
}
await clickBtn('Готово');
await sleep(400);

// 16. deleting segments and vertices from the contour tab
await clickBtn('Очистить холст');
await sleep(550);
const b16 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await tap(b16.x + 100, b16.y + 170);
await tap(b16.x + 300, b16.y + 170);
await tap(b16.x + 300, b16.y + 370);
await tap(b16.x + 100, b16.y + 370);
await tap(b16.x + 100, b16.y + 170);
await sleep(450);
await clickBtn('К размерам');
await sleep(450);
const sheetTitle = () =>
  page.$eval('.sheet__title', (e) => e.textContent?.trim()).catch(() => null);
const dotsBounds = (dots) => {
  const xs = dots.map((d) => d.x);
  const ys = dots.map((d) => d.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    midX: (Math.min(...xs) + Math.max(...xs)) / 2,
    midY: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
};

// A ring loses one side but keeps all four vertices: the two ends stay as
// open ends of the remaining polyline.
const ringBefore = await geoCounts();
let dots16 = await nodeDots();
let db = dotsBounds(dots16);
await tap(b16.x + db.midX, b16.y + db.minY + 1);
await sleep(300);
const segTitle = await sheetTitle();
const segDelete = (await btnLabels()).includes('Удалить отрезок');
await page.screenshot({ path: '/tmp/strip-segment-selected.png' });
await clickBtn('Удалить отрезок');
await sleep(450);
const ringAfter = await geoCounts();
console.log('segment delete :', JSON.stringify({ before: ringBefore, title: segTitle, button: segDelete, after: ringAfter, toast: await toast() }));
if (segTitle !== 'Ширина участка' || !segDelete) {
  throw new Error('selected segment needs its width sheet and a delete button');
}
if (!ringAfter || ringAfter.nodes !== 4 || ringAfter.segs !== 3) {
  throw new Error('deleting a ring side must open the ring and keep its points: ' + JSON.stringify(ringAfter));
}

// A corner takes its own edges with it; the vertex on the far side of an edge
// that lost every segment must not stay behind.
dots16 = await nodeDots();
db = dotsBounds(dots16);
const leftDots = dots16.filter((d) => Math.abs(d.x - db.minX) < 3);
const bottomLeft = leftDots.reduce((m, d) => (d.y > m.y ? d : m), leftDots[0]);
await tap(b16.x + bottomLeft.x, b16.y + bottomLeft.y);
await sleep(300);
const cornerTitle = await sheetTitle();
const cornerKind = await page.$eval('.sheet__meta', (e) => e.textContent?.trim()).catch(() => null);
const pointDelete = (await btnLabels()).includes('Удалить точку');
await page.screenshot({ path: '/tmp/strip-vertex-selected.png' });
await clickBtn('Удалить точку');
await sleep(450);
const cornerAfter = await geoCounts();
console.log('corner delete  :', JSON.stringify({ title: cornerTitle, kind: cornerKind, button: pointDelete, after: cornerAfter }));
if (cornerTitle !== 'Вершина' || !pointDelete) {
  throw new Error('tapping a vertex must open the vertex sheet with a delete button');
}
if (!cornerAfter || cornerAfter.nodes !== 2 || cornerAfter.segs !== 1) {
  throw new Error('corner deletion must remove its edges and isolated points: ' + JSON.stringify(cornerAfter));
}

// A collinear split point disappears without a trace: the two halves fuse back
// into one segment.
await clickBtn('Добавить линию');
await sleep(400);
const b17 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
dots16 = await nodeDots();
db = dotsBounds(dots16);
await tap(b17.x + db.midX, b17.y + db.midY);
await sleep(400);
await clickBtn('Готово');
await sleep(450);
const splitBefore = await geoCounts();
dots16 = await nodeDots();
db = dotsBounds(dots16);
const midDot = dots16.reduce(
  (m, d) => (Math.hypot(d.x - db.midX, d.y - db.midY) < Math.hypot(m.x - db.midX, m.y - db.midY) ? d : m),
  dots16[0],
);
await tap(b17.x + midDot.x, b17.y + midDot.y);
await sleep(300);
await clickBtn('Удалить точку');
await sleep(450);
const splitAfter = await geoCounts();
console.log('midpoint delete:', JSON.stringify({ before: splitBefore, after: splitAfter }));
if (!splitBefore || splitBefore.nodes !== 3 || splitBefore.segs !== 2) {
  throw new Error('band tap must create a split point: ' + JSON.stringify(splitBefore));
}
if (!splitAfter || splitAfter.nodes !== 2 || splitAfter.segs !== 1) {
  throw new Error('a point on a straight run must fuse its halves: ' + JSON.stringify(splitAfter));
}

// A branch point is removed together with its branch, while the through line
// stays in one piece. The loose branch end disappears too.
await clickBtn('Добавить линию');
await sleep(400);
const b18 = await page.$eval('.plan-canvas', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
dots16 = await nodeDots();
db = dotsBounds(dots16);
const junction = { x: db.midX, y: db.midY };
await tap(b18.x + junction.x, b18.y + junction.y);
await sleep(350);
await tap(b18.x + junction.x - 100, b18.y + junction.y);
await sleep(450);
await clickBtn('Готово');
await sleep(450);
const branchBefore = await geoCounts();
dots16 = await nodeDots();
const junctionDot = dots16.reduce(
  (m, d) => (Math.hypot(d.x - junction.x, d.y - junction.y) < Math.hypot(m.x - junction.x, m.y - junction.y) ? d : m),
  dots16[0],
);
await tap(b18.x + junctionDot.x, b18.y + junctionDot.y);
await sleep(300);
await clickBtn('Удалить точку');
await sleep(450);
const branchAfter = await geoCounts();
console.log('branch delete  :', JSON.stringify({ before: branchBefore, after: branchAfter }));
if (!branchBefore || branchBefore.nodes !== 4 || branchBefore.segs !== 3) {
  throw new Error('branch must add one junction and one edge: ' + JSON.stringify(branchBefore));
}
if (!branchAfter || branchAfter.nodes !== 2 || branchAfter.segs !== 1) {
  throw new Error('branch deletion must keep the through line and drop the branch: ' + JSON.stringify(branchAfter));
}

// Removing the last segment returns to an empty outline.
dots16 = await nodeDots();
db = dotsBounds(dots16);
await tap(b18.x + db.midX, b18.y + db.midY);
await sleep(300);
await clickBtn('Удалить отрезок');
await sleep(500);
const emptyState = counts(await meta());
console.log('last delete    :', JSON.stringify({ state: emptyState, subtitle: await subtitle() }));
if (!emptyState || emptyState.nodes !== 0 || emptyState.segs !== 0) {
  throw new Error('deleting the last segment must clear the network: ' + JSON.stringify(emptyState));
}
if (!/рисование/.test(await subtitle())) {
  throw new Error('deleting the last segment must return to the outline tab');
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
