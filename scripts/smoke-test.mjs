import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const browserPath = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
if (!browserPath) throw new Error('Set CHROME_PATH to a Chromium or Chrome executable.');
const browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const requests = [];
page.on('request', request => { if (/\/models\/.*\.glb$/i.test(request.url())) requests.push(request.url()); });
page.on('console', message => { if (message.type() === 'error') throw new Error(`Browser console error: ${message.text()}`); });
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('[data-auth-mode="signup"]').first().click();
  await page.locator('#auth-email').fill(`smoke-${Date.now()}@example.com`);
  await page.locator('#auth-password').fill('smoke123');
  await page.locator('#auth-submit').click();
  await page.waitForSelector('#hardware-form select[data-kind="case"]');
  const value = selector => page.locator(selector).inputValue();
  const text = selector => page.locator(selector).textContent();
  const selected = ['case', 'motherboard', 'cpu', 'cooler', 'ram', 'gpu', 'psu', 'ssd', 'fan'];

  assert.deepEqual(await Promise.all(selected.map(kind => value(`select[data-kind="${kind}"]`))), selected.map(() => ''));
  assert.deepEqual(await Promise.all(selected.map(kind => page.locator(`select[data-kind="${kind}"] option`).count())), selected.map(() => 1));
  assert.equal(await text('#watts'), '0');
  assert.equal(await page.locator('#stage').getAttribute('data-parts'), '0');
  assert.equal(requests.length, 0, 'unassigned users must request no GLBs');
  assert.match(await text('#compatibility-detail'), /No catalog compatibility restrictions/);

  // Reset returns the empty scene but preserves RGB input value.
  const rgb = await value('#rgb');
  await page.locator('#reset').evaluate(button => button.click());
  await page.waitForTimeout(120);
  assert.deepEqual(await Promise.all(selected.map(kind => value(`select[data-kind="${kind}"]`))), selected.map(() => ''));
  assert.equal(await text('#watts'), '0');
  assert.equal(await value('#rgb'), rgb);

  console.log(`UI smoke passed: ${requests.length} model requests`);
} finally {
  await browser.close();
}
