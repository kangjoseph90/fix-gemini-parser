const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

test('installed MV3 extension renders and toggles through the real popup and storage APIs', async t => {
    const results = path.join(root, 'test-results'); fs.mkdirSync(results, { recursive: true });
    const profile = fs.mkdtempSync(path.join(results, 'extension-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
        headless: true, executablePath: process.env.EXTENSION_CHROME_PATH || chromium.executablePath(),
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    t.after(async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); });
    await context.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' chrome-extension:; require-trusted-types-for 'script'; trusted-types 'none'" },
        body: '<!doctype html><style>body{font:20px/1.5 Arial;margin:32px}.chat-container{width:420px}</style><div class="chat-container"><p id="answer">**live answer** and $x^2$</p><table><tr><td><span data-path-to-node="1,0">**table answer** and $x^2$</span></td></tr></table><footer class="response-footer animated"></footer></div>'
    }));
    const page = await context.newPage();
    await page.goto('https://gemini.google.com/app');
    await page.waitForFunction(() => document.querySelector('#answer').shadowRoot?.querySelector('.katex'));
    await page.waitForFunction(() => document.querySelector('td > span').shadowRoot?.querySelector('.katex'));
    assert.deepEqual(await page.evaluate(() => {
        const p = document.querySelector('#answer'); window.nativeText = p.firstChild;
        return [p.textContent, p.shadowRoot.querySelector('b').textContent, p.innerText];
    }), ['**live answer** and $x^2$', 'live answer', '**live answer** and $x^2$']);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'KaTeX_Main' && font.status === 'loaded')), true);

    const extensions = await context.newPage(); await extensions.goto('chrome://extensions');
    await extensions.locator('extensions-item').waitFor();
    const id = await extensions.locator('extensions-item').first().getAttribute('id');
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator('.main-switch').waitFor();
    await popup.locator('.main-switch').click();
    await page.waitForFunction(() => document.querySelector('#answer').shadowRoot?.firstChild.tagName === 'SLOT');
    assert.equal(await page.evaluate(() => document.querySelector('td > span').shadowRoot.firstChild.tagName), 'SLOT');
    await page.evaluate(() => { nativeText.data = '**changed while off**'; });
    await popup.locator('.main-switch').click();
    await page.waitForFunction(() => document.querySelector('#answer').shadowRoot?.querySelector('b')?.textContent === 'changed while off');
    await page.waitForFunction(() => document.querySelector('td > span').shadowRoot?.querySelector('b')?.textContent === 'table answer');
    assert.equal(await page.evaluate(() => document.querySelector('#answer').firstChild === nativeText), true);

    // A newly opened Gemini tab also starts disabled, but its listener is alive.
    await popup.locator('.main-switch').click();
    const second = await context.newPage(); await second.goto('https://gemini.google.com/app');
    assert.equal(await second.evaluate(() => document.querySelector('#answer').shadowRoot), null);
    await popup.locator('.main-switch').click();
    await second.waitForFunction(() => document.querySelector('#answer').shadowRoot?.querySelector('.katex'));
    await page.waitForFunction(() => document.querySelector('#answer').shadowRoot?.querySelector('b')?.textContent === 'changed while off');
    await second.screenshot({ path: path.join(results, 'installed-extension.png') });
});
