// 最终验收：在全新重建的画册上，确认渲染、翻页、图片加载全部正常。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BOOK = process.argv[2];
const OUT = process.argv[3];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('requestfailed', (r) => failed.push(r.url()));

  await page.goto('file:///' + BOOK.replace(/\\/g, '/') + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll('.book-page img')].map((im) => ({
      src: im.getAttribute('src'),
      natural: im.naturalWidth + 'x' + im.naturalHeight,
      loaded: im.complete && im.naturalWidth > 0,
    })),
  );

  // 翻页走到底，记录状态变化
  const trail = [];
  for (let i = 0; i < 20; i++) {
    const st = await page.evaluate(() => (document.querySelector('#page-status') || {}).textContent);
    if (trail[trail.length - 1] !== st) trail.push(st);
    if (st === 'Back cover') break;
    await page.click('#next').catch(() => {});
    await page.waitForTimeout(820);
  }

  // 跨页渲染快照
  await page.goto('file:///' + BOOK.replace(/\\/g, '/') + '/index.html?page=6', { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(OUT, 'final-spread.png') });

  const report = {
    totalLeaves: await page.evaluate(() => document.querySelectorAll('.stf__item').length),
    pageElements: await page.evaluate(() => document.querySelectorAll('.book-page').length),
    images: imgs,
    allImagesLoaded: imgs.every((i) => i.loaded),
    pageTrail: trail,
    consoleErrors: errors,
    failedRequests: failed.length,
  };

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
