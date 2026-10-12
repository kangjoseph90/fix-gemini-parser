const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let browser, server, base;
let css;
const pages = new Set();

before(async () => {
    server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname.startsWith('/lib/') && !pathname.includes('..')) {
            const filename = path.join(root, pathname.slice(1));
            if (fs.existsSync(filename) && fs.statSync(filename).isFile()) {
                response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
                response.end(fs.readFileSync(filename)); return;
            }
        }
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head></head><body></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    css = fs.readFileSync(path.join(root, 'lib/katex.min.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, url) =>
        `url("${new URL(url.trim().replace(/^['"]|['"]$/g, ''), base + '/lib/katex.min.css').href}")`);
    const executable = process.env.CHROME_PATH || (fs.existsSync(chromium.executablePath()) ? chromium.executablePath()
        : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    browser = await chromium.launch({ headless: true, executablePath: executable });
});
after(async () => {
    await Promise.all([...pages].map(page => page.close()));
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
});

async function fixture(t, options = {}) {
    const page = await browser.newPage({ viewport: { width: 760, height: 700 } });
    pages.add(page);
    t.after(async () => { pages.delete(page); await page.close(); });
    await page.goto(base);
    await page.setContent(`<!doctype html><style>body{font:18px/1.5 Arial;margin:30px}.chat-container{width:420px}p{margin:0 0 12px}strong{color:rgb(100,0,0)}button{font:inherit}</style>
        <main class="chat-container"><section id="response"><p id="answer">**alpha**</p><footer class="response-footer animated"></footer></section></main>
        <p id="outside">**outside**</p><hallucination-disclaimer>native disclaimer</hallucination-disclaimer>`);
    if (options.html) await page.evaluate(html => { document.querySelector('#answer').innerHTML = html; }, options.html);
    if (options.text !== undefined) await page.evaluate(text => { document.querySelector('#answer').textContent = text; }, options.text);
    for (const name of ['lib/katex.min.js', 'lib/markdown-it.min.js', 'parser-engine.js']) await page.addScriptTag({ path: path.join(root, name) });
    await page.evaluate(({ settings, css }) => {
        window.source = document.querySelector('#answer'); window.originalText = source.firstChild;
        window.originalMarkup = source.innerHTML;
        window.engine = GeminiParser.createEngine({ settings, katex, katexCss: css, interval: 25 });
        window.view = () => source.shadowRoot?.querySelector('.gp-view');
    }, { settings: options.settings || {}, css: options.css === false ? '' : css });
    return page;
}

async function rendered(page, text) {
    await page.waitForFunction(expected => window.view()?.textContent === expected, text);
}

test('renders while the animated streaming footer remains, without replacing source children', async t => {
    const page = await fixture(t);
    assert.deepEqual(await page.evaluate(() => [view().textContent, source.firstChild === originalText,
        source.innerHTML === originalMarkup, originalText.isConnected, source.childNodes.length,
        document.querySelector('footer').classList.contains('animated')]), ['alpha', true, true, true, 1, true]);
});

test('native innerText remains available without duplicate accessible text', async t => {
    const page = await fixture(t);
    assert.equal(await page.evaluate(() => source.innerText), '**alpha**');
    const tree = await page.locator('#answer').ariaSnapshot();
    assert.match(tree, /alpha/); assert.doesNotMatch(tree, /\*\*alpha\*\*/);
    assert.equal((tree.match(/alpha/g) || []).length, 1);
});

test('native text-node updates replace the latest snapshot, never append cumulative text', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { originalText.data = '**alpha beta**'; });
    await rendered(page, 'alpha beta');
    assert.deepEqual(await page.evaluate(() => [source.textContent, source.firstChild === originalText,
        source.shadowRoot.querySelectorAll('.gp-view').length]), ['**alpha beta**', true, 1]);
});

test('an incomplete delimiter remains literal and is processed when completed', async t => {
    const page = await fixture(t, { text: 'start **open' });
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
    await page.evaluate(() => { originalText.data = 'start **closed**'; });
    await rendered(page, 'start closed');
    assert.equal(await page.evaluate(() => view().querySelector('b').textContent), 'closed');
});

test('streaming first ordinary text and then syntax is not blocked by a one-time marker', async t => {
    const page = await fixture(t, { text: 'plain' });
    await page.evaluate(() => { originalText.data = '**now complete**'; });
    await rendered(page, 'now complete');
    assert.equal(await page.evaluate(() => source.hasAttribute('data-rendered')), false);
});

test('native subtree rewrite and source element replacement discard old output', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { source.innerHTML = '<strong>native</strong> **rewrite**'; });
    await rendered(page, 'native rewrite');
    assert.equal(await page.evaluate(() => source.querySelector('strong').textContent), 'native');
    await page.evaluate(() => {
        window.oldSource = source;
        source = document.createElement('p'); source.id = 'answer'; source.textContent = '**regenerated**';
        oldSource.replaceWith(source);
    });
    await rendered(page, 'regenerated');
    assert.deepEqual(await page.evaluate(() => [engine.diagnostics().activeProjections,
        oldSource.shadowRoot.children.length, oldSource.shadowRoot.firstChild.tagName]), [1, 1, 'SLOT']);
});

test('SPA chat-container replacement discovers the new source and releases the old view', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const next = document.createElement('main'); next.className = 'chat-container';
        source = document.createElement('p'); source.id = 'answer'; source.textContent = '**new chat**';
        next.append(source); document.querySelector('.chat-container').replaceWith(next);
    });
    await rendered(page, 'new chat');
    assert.equal(await page.evaluate(() => engine.diagnostics().activeProjections), 1);
});

test('disable cancels queued work, restores the native slot, and re-enable reads changes while off', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        originalText.data = '**queued**'; engine.updateSettings({ enabled: false });
        originalText.data = '**updated while off**';
    });
    await page.waitForTimeout(90);
    assert.deepEqual(await page.evaluate(() => [!!view(), source.innerText, source.firstChild === originalText,
        source.shadowRoot.firstChild.tagName, engine.diagnostics().activeProjections]), [false, '**updated while off**', true, 'SLOT', 0]);
    await page.evaluate(() => engine.updateSettings({ enabled: true }));
    await rendered(page, 'updated while off');
});

test('repeated rapid toggles never duplicate the view or lose source nodes', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        for (let i = 0; i < 30; i++) {
            engine.updateSettings({ enabled: false }); originalText.data = `**toggle ${i}**`;
            engine.updateSettings({ enabled: true });
        }
    });
    await rendered(page, 'toggle 29');
    assert.deepEqual(await page.evaluate(() => [source.firstChild === originalText,
        source.shadowRoot.querySelectorAll('.gp-view').length, source.shadowRoot.querySelectorAll('slot').length]), [true, 1, 1]);
});

test('feature and color toggles re-render from source and reset without leftover formatting', async t => {
    const page = await fixture(t);
    await page.evaluate(() => engine.updateSettings({ bold: false }));
    await page.waitForFunction(() => !view());
    assert.equal(await page.evaluate(() => source.innerText), '**alpha**');
    await page.evaluate(() => engine.updateSettings({ bold: true, boldColor: { color: '#0000ff', opacity: 75, customCss: 'letter-spacing:2px' } }));
    await rendered(page, 'alpha');
    assert.deepEqual(await page.evaluate(() => { const b = view().querySelector('b'); const c = getComputedStyle(b);
        return [c.color, c.opacity, c.letterSpacing]; }), ['rgb(0, 0, 255)', '0.75', '2px']);
    await page.evaluate(() => engine.updateSettings({ boldColor: null }));
    await page.waitForFunction(() => getComputedStyle(view().querySelector('b')).color !== 'rgb(0, 0, 255)');
    assert.equal(await page.evaluate(() => source.innerHTML), '**alpha**');
});

test('changing raw content back to plain text restores original display', async t => {
    const page = await fixture(t);
    await page.evaluate(() => { originalText.data = 'plain again'; });
    await page.waitForFunction(() => !view());
    assert.equal(await page.evaluate(() => source.innerText), 'plain again');
});

test('interactive content added during streaming restores live original buttons and handlers', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const button = document.createElement('button'); button.textContent = 'citation';
        window.clicked = 0; button.addEventListener('click', () => clicked++); source.append(button);
    });
    await page.waitForFunction(() => !view());
    await page.locator('#answer button').click();
    assert.equal(await page.evaluate(() => clicked), 1);
    assert.equal(await page.evaluate(() => source.firstChild === originalText), true);
});

test('attachments, native KaTeX, code blocks, user queries, editors, table cells and outside text stay native', async t => {
    const page = await fixture(t, { html: '<response-element>**attachment**</response-element>' });
    await page.evaluate(() => {
        const container = document.querySelector('.chat-container');
        container.insertAdjacentHTML('beforeend', '<p id="math"><span class="katex">$native$</span></p><pre><p id="pre">**code**</p></pre><user-query><p id="user">**query**</p></user-query><div contenteditable="true"><p id="editor">**edit**</p></div><table><tr><td id="cell">**table**</td></tr></table>');
    });
    await page.waitForTimeout(70);
    assert.deepEqual(await page.evaluate(() => ['answer', 'math', 'pre', 'user', 'editor', 'cell', 'outside'].map(id => !!document.getElementById(id).shadowRoot)), Array(7).fill(false));
});

test('another component shadow root is never overwritten', async t => {
    const page = await fixture(t, { text: 'plain' });
    await page.evaluate(() => {
        const shadow = source.attachShadow({ mode: 'open' }); const child = document.createElement('span');
        child.textContent = 'native component'; shadow.append(child); originalText.data = '**changed**';
    });
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => source.shadowRoot.textContent), 'native component');
});

test('class-only completion is observed and identical content does not rewrite the view', async t => {
    const page = await fixture(t);
    const before = await page.evaluate(() => engine.diagnostics());
    await page.evaluate(() => document.querySelector('footer').classList.remove('animated'));
    await page.waitForFunction(count => engine.diagnostics().flushes > count, before.flushes);
    assert.equal(await page.evaluate(() => engine.diagnostics().renderWrites), before.renderWrites);
});

test('500 synchronous updates coalesce and a sustained stream renders before its final token', async t => {
    const page = await fixture(t);
    const before = await page.evaluate(() => engine.diagnostics().renderWrites);
    await page.evaluate(() => { for (let i = 0; i < 500; i++) originalText.data = `**token ${i}**`; });
    await rendered(page, 'token 499');
    assert.equal(await page.evaluate(count => engine.diagnostics().renderWrites - count, before), 1);
    assert.equal(await page.evaluate(async () => {
        const before = engine.diagnostics().renderWrites; let mid = 0;
        for (let i = 0; i < 14; i++) {
            originalText.data = `**live ${i}**`; await new Promise(resolve => setTimeout(resolve, 12));
            if (i === 6) mid = engine.diagnostics().renderWrites - before;
        }
        return mid > 0;
    }), true);
    await rendered(page, 'live 13');
});

test('shadow writes do not retrigger the native observer and destroy cancels pending updates', async t => {
    const page = await fixture(t);
    await page.waitForTimeout(80);
    const before = await page.evaluate(() => engine.diagnostics().flushes);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => engine.diagnostics().flushes), before);
    await page.evaluate(() => { originalText.data = '**queued**'; engine.destroy(); });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => view()), null);
});

test('nested emphasis, strikethrough, literal underline and code remain correctly separated', async t => {
    const page = await fixture(t, { text: '**bold *italic*** ~~gone~~ <u>under</u> `**code** $x$`' });
    await rendered(page, 'bold italic gone under **code** $x$');
    assert.deepEqual(await page.evaluate(() => [view().querySelector('b i').textContent,
        view().querySelector('s').textContent, view().querySelector('u').textContent,
        view().querySelector('code').textContent, view().querySelectorAll('.katex').length]), ['italic', 'gone', 'under', '**code** $x$', 0]);
});

test('escaped delimiters and disabled code do not leak formatting into code contents', async t => {
    const page = await fixture(t, { text: '\\*literal\\* **yes** `**code** $x$`', settings: { code: false } });
    await rendered(page, '*literal* yes `**code** $x$`');
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('i').length, view().querySelectorAll('b').length,
        view().querySelectorAll('.katex').length]), [0, 1, 0]);
});

test('disabled math stays opaque to emphasis, and a long literal dollar run is not parsed as math', async t => {
    const page = await fixture(t, { text: '$a*b*c$ **yes**', settings: { latex: false } });
    await rendered(page, '$a*b*c$ yes');
    assert.equal(await page.evaluate(() => view().querySelectorAll('i,.katex').length), 0);
    await page.evaluate(() => { originalText.data = '$'.repeat(10000) + ' **after**'; });
    await rendered(page, '$'.repeat(10000) + ' after');
});

test('adjacent code inside emphasis cannot close the outer emphasis', async t => {
    const page = await fixture(t, { text: '**before `**code**` after**' });
    await rendered(page, 'before **code** after');
    assert.equal(await page.evaluate(() => view().querySelector('b code').textContent), '**code**');
});

test('a token split across native text nodes and neutral spans is parsed once', async t => {
    const page = await fixture(t, { html: '<span>**bo</span><span>ld**</span>' });
    await rendered(page, 'bold');
    assert.equal(await page.evaluate(() => source.childNodes.length), 2);
    assert.equal(await page.evaluate(() => view().querySelectorAll('b').length), 1);
});

test('native formatting and opaque native inline code survive independent feature toggles', async t => {
    const page = await fixture(t, { html: '<strong>native</strong> **fixed** <code>**literal**</code>' });
    await rendered(page, 'native fixed **literal**');
    assert.equal(await page.evaluate(() => getComputedStyle(view().querySelector('strong')).color), 'rgb(100, 0, 0)');
    await page.evaluate(() => engine.updateSettings({ bold: false }));
    await rendered(page, 'native **fixed** **literal**');
    assert.equal(await page.evaluate(() => view().querySelector('strong').textContent), 'native');
    assert.equal(await page.evaluate(() => source.innerHTML), '<strong>native</strong> **fixed** <code>**literal**</code>');
});

test('completion class and identical snapshots retain displayed nodes', async t => {
    const page = await fixture(t, { text: '**steady** $x^2$' });
    await page.evaluate(() => {
        window.displayedBold = view().querySelector('b'); window.displayedMath = view().querySelector('.gemini-parser-math');
        document.querySelector('#response').classList.add('complete');
        document.querySelector('footer').classList.remove('animated');
        source.setAttribute('data-path-to-node', '0');
    });
    await page.waitForTimeout(70);
    assert.deepEqual(await page.evaluate(() => [view().querySelector('b') === displayedBold,
        view().querySelector('.gemini-parser-math') === displayedMath]), [true, true]);
});

test('native final formatting and math metadata keep the existing projection and math tree before paint', async t => {
    const page = await fixture(t, { text: '**steady** and $x^2$' });
    assert.deepEqual(await page.evaluate(async () => {
        const oldView = view(); const oldBold = oldView.querySelector('b'); const oldMath = oldView.querySelector('.gemini-parser-math');
        const bold = document.createElement('b'); bold.textContent = 'steady';
        bold.setAttribute('data-path-to-node', '0,0'); bold.setAttribute('data-index-in-node', '0');
        const math = document.createElement('span'); math.className = 'math-inline';
        math.setAttribute('data-math', 'x^2'); math.setAttribute('data-index-in-node', '2');
        katex.render('x^2', math, { output: 'html' });
        source.replaceChildren(bold, document.createTextNode(' and '), math);
        await new Promise(requestAnimationFrame);
        return [view() === oldView, view().querySelector('b') === oldBold,
            view().querySelector('.gemini-parser-math') === oldMath, source.firstChild === bold,
            view().querySelectorAll('.gemini-parser-math').length];
    }), [true, true, true, true, 1]);
});

test('replacement paragraph gets its projection before the first animation frame', async t => {
    const page = await fixture(t);
    assert.equal(await page.evaluate(async () => {
        const replacement = document.createElement('p'); replacement.id = 'answer'; replacement.textContent = '**finished**';
        source.replaceWith(replacement); source = replacement;
        await new Promise(requestAnimationFrame);
        return view()?.querySelector('b')?.textContent;
    }), 'finished');
});

test('completed metadata tokens retain streaming fonts, styles, and inline node identity', async t => {
    const page = await fixture(t, { text: '**steady** `code`' });
    assert.deepEqual(await page.evaluate(async () => {
        const style = document.createElement('style'); style.textContent = 'b{font-weight:500}code{font:30px serif;color:red}';
        document.head.appendChild(style);
        const bold = view().querySelector('b'); const code = view().querySelector('code');
        const before = [getComputedStyle(bold).fontWeight, getComputedStyle(code).fontFamily, getComputedStyle(code).fontSize];
        const nativeBold = document.createElement('b'); nativeBold.textContent = 'steady'; nativeBold.setAttribute('data-path-to-node', '0,0');
        const nativeCode = document.createElement('code'); nativeCode.textContent = 'code'; nativeCode.setAttribute('data-path-to-node', '0,2');
        source.replaceChildren(nativeBold, document.createTextNode(' '), nativeCode);
        await new Promise(requestAnimationFrame);
        const after = [getComputedStyle(view().querySelector('b')).fontWeight,
            getComputedStyle(view().querySelector('code')).fontFamily, getComputedStyle(view().querySelector('code')).fontSize];
        return [JSON.stringify(before) === JSON.stringify(after), view().querySelector('b') === bold, view().querySelector('code') === code];
    }), [true, true, true]);
});

test('appended streaming text retains the equal formula prefix and its text node', async t => {
    const page = await fixture(t, { text: '$x^2$ tail' });
    await page.evaluate(() => {
        window.oldFormula = view().querySelector('.gemini-parser-math');
        window.oldTail = view().lastChild;
        originalText.data = '$x^2$ tail grows';
    });
    await page.waitForFunction(() => view().lastChild.textContent === ' tail grows');
    assert.deepEqual(await page.evaluate(() => [view().querySelector('.gemini-parser-math') === oldFormula,
        view().lastChild === oldTail, source.firstChild === originalText]), [true, true, true]);
});

test('inline code keeps its visible themed chip during streaming, completion, and toggles', async t => {
    const page = await fixture(t, { text: 'inline `const x = "$math$ **literal**";`' });
    assert.deepEqual(await page.evaluate(async () => {
        source.style.setProperty('--lumi-sys-color--code-background', '#171717');
        source.style.setProperty('--lumi-sys-color--on-surface-variant', 'rgba(255,255,255,.55)');
        const code = view().querySelector('code');
        const box = node => {
            const style = getComputedStyle(node);
            return ['backgroundColor', 'color', 'display', 'padding', 'borderRadius', 'fontFamily', 'fontSize'].map(key => style[key]);
        };
        const before = box(code);
        const native = document.createElement('code'); native.textContent = code.textContent;
        native.setAttribute('data-path-to-node', '0,1');
        source.replaceChildren(document.createTextNode('inline '), native);
        await new Promise(requestAnimationFrame);
        const stable = view().querySelector('code') === code && JSON.stringify(box(code)) === JSON.stringify(before);
        engine.updateSettings({ enabled: false });
        const restored = source.shadowRoot.firstChild.tagName === 'SLOT' && source.lastChild === native;
        engine.updateSettings({ enabled: true });
        return [before, stable, restored, JSON.stringify(box(view().querySelector('code'))) === JSON.stringify(before),
            view().querySelector('code').textContent, view().querySelectorAll('.katex,b').length];
    }), [['rgb(23, 23, 23)', 'rgba(255, 255, 255, 0.55)', 'inline-block', '4px 6px', '9999px',
        '"Google Sans Code", monospace', '15px'], true, true, true, 'const x = "$math$ **literal**";', 0]);
});

test('code theme changes and user overrides apply without replacing the code node', async t => {
    const page = await fixture(t, { text: '`code`' });
    const themes = await page.evaluate(() => {
        const code = view().querySelector('code');
        window.originalCode = code;
        const background = () => getComputedStyle(code).backgroundColor;
        const fallback = background();
        source.style.setProperty('--lumi-sys-color--code-background', '#eeeeee');
        const light = background();
        source.style.setProperty('--lumi-sys-color--code-background', '#171717');
        const dark = background();
        engine.updateSettings({ codeColor: { color: '#ff0000', opacity: 75, customCss: 'border-radius: 4px; padding: 2px;' } });
        return [fallback !== 'rgba(0, 0, 0, 0)', light, dark];
    });
    assert.deepEqual(themes, [true, 'rgb(238, 238, 238)', 'rgb(23, 23, 23)']);
    await page.waitForFunction(() => getComputedStyle(view().querySelector('code')).color === 'rgb(255, 0, 0)');
    assert.deepEqual(await page.evaluate(() => {
        const code = view().querySelector('code'); const style = getComputedStyle(code);
        return [code === originalCode, style.opacity, style.borderRadius, style.padding];
    }), [true, '0.75', '4px', '2px']);
});

test('disabling code repair preserves the native code box inside other repaired formatting', async t => {
    const page = await fixture(t, { html: '**bold** <code data-path-to-node="0,1" style="display:inline-block;background:#171717;padding:4px 6px;border-radius:9999px">native</code>', settings: { code: false } });
    assert.deepEqual(await page.evaluate(() => {
        const native = source.querySelector('code'); const code = view().querySelector('code');
        const box = node => { const style = getComputedStyle(node); return ['backgroundColor', 'display', 'padding', 'borderRadius'].map(key => style[key]); };
        return [JSON.stringify(box(native)) === JSON.stringify(box(code)), code.textContent,
            code.classList.contains('gemini-parser-code'), view().querySelector('b').textContent];
    }), [true, 'native', false, 'bold']);
});

test('new interactive content is shown natively before the next animation frame', async t => {
    const page = await fixture(t);
    assert.equal(await page.evaluate(async () => {
        const button = document.createElement('button'); button.textContent = 'source'; source.append(button);
        await new Promise(requestAnimationFrame);
        return !view() && button.getBoundingClientRect().height > 0;
    }), true);
});

test('native formulas with interactive descendants stay native', async t => {
    const page = await fixture(t, { html: '<span class="math-inline" data-math="x"><a href="#citation">source</a></span>' });
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
});

test('a malformed final native formula does not restore the entire paragraph', async t => {
    const page = await fixture(t, { text: '**steady** and $x$' });
    assert.deepEqual(await page.evaluate(async () => {
        const oldView = view(); const oldBold = view().querySelector('b');
        const bold = document.createElement('b'); bold.textContent = 'steady'; bold.setAttribute('data-path-to-node', '0');
        const invalid = document.createElement('span'); invalid.className = 'math-inline';
        invalid.setAttribute('data-math', 'a$$b'); invalid.textContent = 'a$$b';
        source.replaceChildren(bold, document.createTextNode(' and '), invalid);
        await new Promise(requestAnimationFrame);
        return [view() === oldView, view().querySelector('b') === oldBold, view().textContent, source.lastChild === invalid];
    }), [true, true, 'steady and a$$b', true]);
});

test('unfinished math stays literal; inline and display math render when complete, with MathML accessibility', async t => {
    const page = await fixture(t, { text: '$x^' });
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
    await page.evaluate(() => { originalText.data = '$x^2$ and $$\\frac{a}{b}$$'; });
    await page.waitForFunction(() => view()?.querySelectorAll('.katex').length === 2);
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('.katex-display').length,
        view().querySelectorAll('math').length, source.textContent]), [1, 2, '$x^2$ and $$\\frac{a}{b}$$']);
});

test('invalid math and hostile literal HTML remain source text, without injected attributes or elements', async t => {
    const page = await fixture(t, { text: '**safe** <img src=x onerror=alert(1)> $\\invalidcommand$' });
    await rendered(page, 'safe <img src=x onerror=alert(1)> $\\invalidcommand$');
    assert.equal(await page.evaluate(() => view().querySelectorAll('img,[onerror]').length), 0);
    await page.evaluate(() => { originalText.data = '$\\text{\" onmouseover=\"bad}$'; });
    await page.waitForFunction(() => !!view()?.querySelector('.katex'));
    assert.equal(await page.evaluate(() => view().querySelectorAll('[onmouseover]').length), 0);
});

test('a page requiring Trusted Types still renders math without an HTML policy', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy';
        meta.content = "require-trusted-types-for 'script'; trusted-types 'none'"; document.head.append(meta);
        originalText.data = '**secure** $x^2$';
    });
    await page.waitForFunction(() => !!view()?.querySelector('.katex'));
    assert.equal(await page.evaluate(() => view().querySelector('b').textContent), 'secure');
});

test('rendered text can be selected independently of the clipped original slot', async t => {
    const page = await fixture(t);
    assert.equal(await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(view());
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
    }), 'alpha');
});

test('natural layout follows the rendered height, survives width changes, and restores on disable', async t => {
    const page = await fixture(t, { text: '**' + 'long content '.repeat(20) + '**' });
    const first = await page.evaluate(() => ({ height: source.getBoundingClientRect().height,
        next: document.querySelector('footer').getBoundingClientRect().top, top: source.getBoundingClientRect().top }));
    assert.ok(first.next >= first.top + first.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.evaluate(() => { document.querySelector('.chat-container').style.width = '220px'; });
    await page.waitForFunction(height => source.getBoundingClientRect().height > height, first.height);
    await page.evaluate(() => engine.updateSettings({ enabled: false }));
    assert.equal(await page.evaluate(() => source.innerHTML === originalMarkup), true);
    assert.equal(await page.evaluate(() => source.hasAttribute('style')), false);
});

test('bundled KaTeX font faces are registered and load successfully', async t => {
    const page = await fixture(t, { text: '$x^2 + \\frac{a}{b}$' });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'KaTeX_Main' && font.status === 'loaded')), true);
    assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.status === 'error')), false);
});

test('theme changes update copied native inline styles, and new interactive attributes restore native content', async t => {
    const page = await fixture(t, { html: '<span style="font-weight:bold">native</span> **fixed**' });
    await page.evaluate(() => { document.body.style.color = 'rgb(0, 80, 120)'; });
    await page.waitForFunction(() => getComputedStyle(view().firstChild).color === 'rgb(0, 80, 120)');
    await page.evaluate(() => { source.firstChild.setAttribute('data-citation-id', 'new-source'); });
    await page.waitForFunction(() => !view());
    assert.equal(await page.evaluate(() => source.firstChild.getAttribute('data-citation-id')), 'new-source');
});

test('disclaimer hiding is reversible and never deletes its contents', async t => {
    const page = await fixture(t);
    assert.equal(await page.locator('hallucination-disclaimer').textContent(), 'native disclaimer');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('hallucination-disclaimer')).visibility), 'hidden');
    await page.evaluate(() => engine.updateSettings({ enabled: false }));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('hallucination-disclaimer')).visibility), 'visible');
});

test('late stylesheet arrival while disabled cannot resurrect output, and enabling renders math', async t => {
    const page = await fixture(t, { text: '$x^2$', css: false, settings: { enabled: false } });
    await page.evaluate(css => engine.setKatexCss(css), css);
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
    await page.evaluate(() => engine.updateSettings({ enabled: true }));
    await page.waitForFunction(() => !!view()?.querySelector('.katex'));
});

test('existing native formulas stay native until the math stylesheet is ready', async t => {
    const page = await fixture(t, { html: '<span class="math-inline" data-math="x">native formula</span>', css: false });
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
    await page.evaluate(css => engine.setKatexCss(css), css);
    await page.waitForFunction(() => !!view()?.querySelector('.katex'));
    assert.equal(await page.evaluate(() => source.innerHTML === originalMarkup), true);
});

test('extension adapter listens when initially disabled and accepts cross-tab storage updates', async t => {
    const page = await fixture(t, { settings: { enabled: false } });
    await page.evaluate(css => {
        engine.destroy();
        window.messages = []; window.storageListeners = [];
        window.chrome = { runtime: { onMessage: { addListener: listener => messages.push(listener) }, getURL: () => location.origin + '/lib/katex.min.css' },
            storage: { sync: { get: (keys, callback) => callback({ enabled: false }) },
                onChanged: { addListener: listener => storageListeners.push(listener) } } };
        window.fetch = async () => ({ ok: true, text: async () => css });
    }, css);
    await page.addScriptTag({ path: path.join(root, 'content.js') });
    assert.equal(await page.evaluate(() => messages.length), 1);
    await page.evaluate(() => messages[0]({ type: 'settingsUpdated', settings: { enabled: true } }));
    await rendered(page, 'alpha');
    await page.evaluate(() => storageListeners[0]({ enabled: { newValue: false } }, 'sync'));
    await page.waitForFunction(() => !view());
});

test('generated userscript uses the same engine and its menu can enable an initially disabled session', async t => {
    const page = await fixture(t, { settings: { enabled: false } });
    await page.evaluate(css => {
        engine.destroy(); window.menu = null; window.saved = null;
        window.GM_getValue = () => false; window.GM_setValue = (key, value) => { saved = value; };
        window.GM_getResourceText = () => css;
        window.GM_registerMenuCommand = (label, callback) => { menu = callback; };
    }, css);
    await page.addScriptTag({ path: path.join(root, 'user-script.js') });
    assert.equal(await page.evaluate(() => source.shadowRoot), null);
    await page.evaluate(() => menu());
    await rendered(page, 'alpha');
    assert.equal(await page.evaluate(() => saved), true);
    await page.evaluate(() => menu());
    await page.waitForFunction(() => !view());
});
