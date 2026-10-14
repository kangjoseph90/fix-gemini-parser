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
    await page.waitForFunction(expected => window.view()?.textContent === expected, text, { timeout: 3000 });
}

async function dragRendered(page, firstSelector, lastSelector = firstSelector) {
    const points = await page.evaluate(({ firstSelector, lastSelector }) => {
        const first = view().querySelector(firstSelector), last = view().querySelector(lastSelector);
        const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
        return { start: { x: a.left - 1, y: a.top + a.height / 2 }, end: { x: b.right + 1, y: b.top + b.height / 2 } };
    }, { firstSelector, lastSelector });
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 12 }); await page.mouse.up();
}

async function mockCopy(page) {
    return page.evaluate(() => {
        const data = {};
        const event = new Event('copy', { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { data[type] = value; } } });
        document.dispatchEvent(event);
        return { data, prevented: event.defaultPrevented };
    });
}

test('mixed nested citation wrappers repair both text levels without moving native widgets', async t => {
    const page = await fixture(t, { html: '**outside** <span data-path-to-node="0"><span>**inside** <sources-carousel-inline><button>PNG</button></sources-carousel-inline></span></span>' });
    assert.deepEqual(await page.evaluate(() => {
        window.chip = source.querySelector('button'); window.wrapper = chip.parentElement.parentElement;
        window.calls = 0; chip.addEventListener('click', () => calls++);
        return [view().querySelector('b').textContent, wrapper.shadowRoot.querySelector('b').textContent, source.innerHTML === originalMarkup];
    }), ['outside', 'inside', true]);
    await page.locator('#answer button').click();
    assert.equal(await page.evaluate(() => calls), 1);
    await page.evaluate(() => { wrapper.firstChild.data = '**updated** '; chip.focus(); });
    await page.waitForFunction(() => wrapper.shadowRoot.querySelector('b').textContent === 'updated');
    assert.equal(await page.evaluate(() => document.activeElement === chip && chip.parentElement.parentElement === wrapper), true);
    await page.evaluate(() => engine.updateSettings({ enabled: false }));
    assert.equal(await page.evaluate(() => !view() && !wrapper.shadowRoot.querySelector('.gp-view') && chip.getBoundingClientRect().height > 0), true);
    await page.evaluate(() => engine.updateSettings({ enabled: true }));
    await page.waitForFunction(() => view()?.querySelector('b') && wrapper.shadowRoot.querySelector('b'));
});

test('links and unknown live elements only exclude their own subtree from repair', async t => {
    const page = await fixture(t, { html: '**outside** <a href="#target">**link**</a> <button>**button**</button> <span data-href="native">**opaque**</span>' });
    assert.equal(await page.evaluate(() => view().querySelector('b').textContent), 'outside');
    await page.evaluate(() => {
        window.link = source.querySelector('a'); window.linkClicks = 0;
        link.addEventListener('click', event => { event.preventDefault(); linkClicks++; });
    });
    await page.locator('#answer a').click();
    assert.deepEqual(await page.evaluate(() => [linkClicks, link.textContent, source.innerHTML === originalMarkup, link.parentElement === source]), [1, '**link**', true, true]);
});

test('a widget arriving inside a previously flattened span mounts nested projections before paint', async t => {
    const page = await fixture(t, { html: '**outside** <span><span>**inside** </span></span>' });
    assert.equal(await page.evaluate(async () => {
        const wrapper = source.querySelector('span span');
        const chip = document.createElement('sources-carousel-inline'); chip.append(Object.assign(document.createElement('button'), { textContent: 'PNG' }));
        wrapper.append(chip);
        await new Promise(requestAnimationFrame);
        return !!view()?.querySelector('b') && wrapper.shadowRoot?.querySelector('b')?.textContent === 'inside' && chip.getBoundingClientRect().height > 0;
    }), true);
});

test('removing a nested widget preserves repair through subsequent text updates and off/on toggles', async t => {
    const page = await fixture(t, { html: '**outside** <span><span>**inside** <sources-carousel-inline><button>PNG</button></sources-carousel-inline></span></span>' });
    await page.evaluate(() => { window.inner = source.querySelector('span span'); source.querySelector('sources-carousel-inline').remove(); });
    await page.waitForFunction(() => view()?.querySelector('b')?.textContent === 'outside' && inner.shadowRoot?.querySelector('b')?.textContent === 'inside');
    await page.evaluate(() => { inner.firstChild.data = '**updated** '; });
    await page.waitForFunction(() => inner.shadowRoot?.querySelector('b')?.textContent === 'updated');
    await page.evaluate(() => engine.updateSettings({enabled:false}));
    assert.equal(await page.evaluate(() => !view() && !inner.shadowRoot.querySelector('.gp-view')), true);
    await page.evaluate(() => engine.updateSettings({enabled:true}));
    await page.waitForFunction(() => view()?.querySelector('b') && inner.shadowRoot.querySelector('b')?.textContent === 'updated');
    assert.equal(await page.evaluate(() => source.querySelector('span span') === inner), true);
});

test('an unrelated existing inline shadow component stays live beside repaired text', async t => {
    const page = await fixture(t, { settings: {enabled:false}, html: '**outside** <span id="foreign-component"></span>' });
    await page.evaluate(() => {
        const component = source.querySelector('span'); window.foreignRoot = component.attachShadow({mode:'open'});
        foreignRoot.append(Object.assign(document.createElement('button'), {textContent:'native'}));
        window.foreignCalls=0;foreignRoot.querySelector('button').addEventListener('click',()=>foreignCalls++);
        engine.updateSettings({enabled:true});
    });
    await page.waitForFunction(() => view()?.querySelector('b'));
    await page.locator('#foreign-component button').click();
    assert.deepEqual(await page.evaluate(() => [foreignCalls, source.querySelector('span').shadowRoot === foreignRoot, view().querySelector('b').textContent]), [1,true,'outside']);
});

test('sup/sub/mark and inert sanitizer metadata preserve presentation beside repaired text', async t => {
    const page = await fixture(t, { html: '<span data-sourcepos="1:1-1:12" data-fencelength="2" data-infolength="0">**outside**</span> H<sup>2</sup> O<sub>2</sub> <mark>highlight</mark>' });
    assert.equal(await page.evaluate(() => view().querySelector('b').textContent), 'outside');
    assert.deepEqual(await page.evaluate(() => ['sup', 'sub', 'mark'].map(tag => getComputedStyle(view().querySelector(tag)).verticalAlign)), ['super', 'sub', 'baseline']);
    assert.equal(await page.evaluate(() => getComputedStyle(view().querySelector('mark')).backgroundColor), 'rgb(255, 255, 0)');
    assert.equal(await page.evaluate(() => source.innerHTML === originalMarkup), true);
});

test('currency unit suffixes do not swallow later formatting or valid closed math', async t => {
    const page = await fixture(t, { text: 'Price $10/month **sale**; $9.99/월 *offer*; $10/x$' });
    assert.deepEqual(await page.evaluate(() => [view().querySelector('b').textContent, view().querySelector('i').textContent,
        view().querySelector('.gemini-parser-math').getAttribute('data-math')]), ['sale', 'offer', '10/x']);
    assert.match(await page.evaluate(() => view().textContent), /\$10\/month sale/);
});

test('tokens cross dir spans while native stylesheet presentation and theme updates survive', async t => {
    const page = await fixture(t, { html: '<span data-path-to-node="0" dir="auto">**bo</span><span data-path-to-node="1">ld**</span>' });
    await rendered(page, 'bold');
    assert.equal(await page.evaluate(() => view().querySelectorAll('b').length), 1);
    assert.equal(await page.evaluate(() => view().querySelector('[dir="auto"]').textContent), 'bo');
    await page.addStyleTag({ content: '#answer > span {color:rgb(10,20,30);font-size:28px}' });
    await page.waitForFunction(() => getComputedStyle(view().querySelector('b span')).fontSize === '28px');
    assert.equal(await page.evaluate(() => getComputedStyle(view().querySelector('b span')).color), 'rgb(10, 20, 30)');
    await page.evaluate(() => engine.updateSettings({ boldColor: { color: '#ffee00' } }));
    await page.waitForFunction(() => getComputedStyle(view().querySelector('b span')).color === 'rgb(255, 238, 0)');
    assert.equal(await page.evaluate(() => source.innerHTML === originalMarkup), true);
});

test('native display and custom math finalization retains projection and formula identity', async t => {
    for (const [tag, className, displayMode] of [['span', 'math-block', true], ['math-block', '', true], ['math-inline', '', false]]) {
        const page = await fixture(t, { text: displayMode ? '**title** $$x^2$$' : '**title** $x^2$' });
        await page.evaluate(({ tag, className, displayMode }) => {
            window.previousMath = view().querySelector('.gemini-parser-math');
            const bold = document.createElement('b'); bold.setAttribute('data-path-to-node', '0'); bold.textContent = 'title';
            const math = document.createElement(tag); if (className) math.className = className;
            math.setAttribute('data-math', 'x^2'); katex.render('x^2', math, { displayMode });
            source.replaceChildren(bold, document.createTextNode(' '), math);
        }, { tag, className, displayMode });
        await page.waitForFunction(() => view()?.querySelector('.gemini-parser-math')?.getAttribute('data-math') === 'x^2');
        await page.waitForTimeout(60);
        assert.equal(await page.evaluate(() => view().querySelector('.gemini-parser-math') === previousMath), true);
        assert.equal(await page.evaluate(() => !!view().querySelector('.katex-display')), displayMode);
    }
});

test('bare list items render through their existing list parent and restore unchanged native source', async t => {
    const page = await fixture(t, { text: '**paragraph**' });
    await page.evaluate(() => {
        window.list = document.createElement('ol'); list.setAttribute('start', '3');
        list.innerHTML = '<li id="bare">**item** $x$<ul><li>*nested*</li></ul></li>';
        source.parentElement.append(list); window.item = list.firstChild; window.listMarkup = list.outerHTML;
    });
    await page.waitForFunction(() => source.parentElement.shadowRoot?.querySelector('.gp-view ol li b'));
    assert.deepEqual(await page.evaluate(() => [source.parentElement.shadowRoot.querySelector('b').textContent,
        !!source.parentElement.shadowRoot.querySelector('.katex'), list.outerHTML === listMarkup, item.parentElement === list,
        view().querySelector('b').textContent]), ['item', true, true, true, 'paragraph']);
    await page.evaluate(() => { item.firstChild.data = '**updated** '; });
    await page.waitForFunction(() => source.parentElement.shadowRoot.querySelector('b').textContent === 'updated');
    await page.evaluate(() => engine.updateSettings({ enabled: false }));
    assert.equal(await page.evaluate(() => item.getBoundingClientRect().height > 0 && !source.parentElement.shadowRoot.querySelector('.gp-view')), true);
});

test('pointer selection copies projected text and rich HTML before Gemini can overwrite the clipboard', async t => {
    const page = await fixture(t, { text: '**alpha** unselected remainder' });
    await page.evaluate(() => {
        source.parentElement.classList.add('model-response-text'); window.nativeCopies = 0;
        document.addEventListener('copy', event => { nativeCopies++; event.clipboardData.setData('text/html', 'native empty range'); });
    });
    await dragRendered(page, 'b');
    assert.equal(await page.evaluate(() => getSelection().toString()), 'alpha');
    assert.equal(await page.evaluate(() => getSelection().getRangeAt(0).collapsed), true);
    const result = await mockCopy(page);
    assert.equal(result.prevented, true); assert.equal(result.data['text/plain'], 'alpha');
    assert.match(result.data['text/html'], /alpha/); assert.doesNotMatch(result.data['text/html'], /unselected|gp-original|\*\*/);
    assert.match(result.data['text/html'], /<b\b/);
    assert.equal(await page.evaluate(() => nativeCopies), 0);
});

test('pointer-selected math appears once in plain and HTML copies with accessible MathML retained', async t => {
    const page = await fixture(t, { text: '**before** $x^2$ **after**' });
    await dragRendered(page, 'b:first-child', 'b:last-child');
    const selection = await page.evaluate(() => getSelection().toString());
    assert.equal((selection.match(/x/g) || []).length, 1); assert.doesNotMatch(selection, /𝑥/);
    const result = await mockCopy(page);
    assert.equal(result.prevented, true); assert.match(result.data['text/plain'], /before[\s\S]*x[\s\S]*after/); assert.equal((result.data['text/plain'].match(/x/g) || []).length, 1);
    assert.doesNotMatch(result.data['text/html'], /katex-mathml|gp-original/); assert.match(result.data['text/html'], /katex-html/);
    assert.equal(await page.evaluate(() => !!view().querySelector('.katex-mathml math')), true);
});

test('copy of ordinary native text, inputs and disabled projections stays on the native path', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#outside'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    assert.deepEqual(await mockCopy(page), { data: {}, prevented: false });
    await page.evaluate(() => {
        const button = Object.assign(document.createElement('button'), {textContent: 'native widget'}); source.append(button);
    });
    await page.waitForFunction(() => view()?.querySelector('slot[data-gp-native]'));
    await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(source.querySelector('button'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    assert.deepEqual(await mockCopy(page), { data: {}, prevented: false });
    await page.evaluate(() => engine.updateSettings({ enabled: false }));
    await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(source);
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    assert.deepEqual(await mockCopy(page), { data: {}, prevented: false });
});

test('bare lists directly in a chat container render without taking over slotted native selections', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const list = document.createElement('ul'); list.innerHTML = '<li>**direct item**</li>';
        document.querySelector('.chat-container').append(list);
    });
    await page.waitForFunction(() => document.querySelector('.chat-container').shadowRoot?.querySelector('li b'));
    assert.equal(await page.evaluate(() => document.querySelector('.chat-container').shadowRoot.querySelector('li b').textContent), 'direct item');
});

test('rich copy joins separate shadow paragraphs without hidden source or unselected tails', async t => {
    const page = await fixture(t, { text: '**alpha**' });
    await page.evaluate(() => {
        const next = document.createElement('p'); next.id = 'next'; next.textContent = '**beta** trailing'; source.after(next);
    });
    await page.waitForFunction(() => document.querySelector('#next').shadowRoot?.querySelector('b'));
    const points = await page.evaluate(() => {
        const first = view().querySelector('b').getBoundingClientRect();
        const last = document.querySelector('#next').shadowRoot.querySelector('b').getBoundingClientRect();
        return [first.left - 1, first.top + first.height / 2, last.right + 1, last.top + last.height / 2];
    });
    await page.mouse.move(points[0], points[1]); await page.mouse.down();
    await page.mouse.move(points[2], points[3], { steps: 20 }); await page.mouse.up();
    const result = await mockCopy(page);
    assert.equal(result.prevented, true);
    assert.match(result.data['text/plain'], /alpha[\s\S]*beta/); assert.doesNotMatch(result.data['text/plain'], /\*\*|trailing/);
    assert.equal((result.data['text/html'].match(/alpha/g) || []).length, 1);
    assert.equal((result.data['text/html'].match(/beta/g) || []).length, 1);
    assert.doesNotMatch(result.data['text/html'], /gp-original|\*\*|trailing/);
});

test('copy crossing native endpoints and projected paragraphs preserves the selected interval', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        source.before(Object.assign(document.createElement('p'), { id: 'native-first', textContent: 'native first' }));
        source.after(Object.assign(document.createElement('p'), { id: 'native-last', textContent: 'native last' }));
    });
    const a = await page.locator('#native-first').boundingBox(), b = await page.locator('#native-last').boundingBox();
    // Paragraphs occupy the full block width; finish after the last text glyph.
    const lastRight = await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#native-last')); return range.getBoundingClientRect().right; });
    await page.mouse.move(a.x - 1, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(lastRight + 1, b.y + b.height / 2, { steps: 20 }); await page.mouse.up();
    const result = await mockCopy(page);
    assert.equal(result.prevented, true); assert.match(result.data['text/html'], /native first[\s\S]*<b\b[\s\S]*alpha[\s\S]*native last/);
    assert.doesNotMatch(result.data['text/html'], /gp-original|\*\*/);
});

test('nested projection copy includes a live citation once and preserves partial text formatting', async t => {
    const page = await fixture(t, { html: '**first** <span><span>**inner** <sources-carousel-inline><button>PNG</button></sources-carousel-inline></span></span> **last**' });
    await dragRendered(page, 'b:first-child', 'b:last-child');
    const result = await mockCopy(page);
    assert.equal(result.prevented, true);
    assert.equal((result.data['text/html'].match(/PNG/g) || []).length, 1);
    assert.match(result.data['text/html'], /first[\s\S]*inner[\s\S]*PNG[\s\S]*last/);
    assert.doesNotMatch(result.data['text/html'], /gp-original|\*\*/);
});

test('presentation runs retain atom direction, visibility and distinct styles without bleeding into adjacent text', async t => {
    const page = await fixture(t, { html: '<span style="color:rgb(10,20,30)" dir="rtl">**bright** $x$</span> **ordinary** <span style="display:none">$y$</span>' });
    assert.equal(await page.evaluate(() => getComputedStyle(view().querySelector('b span')).color), 'rgb(10, 20, 30)');
    assert.equal(await page.evaluate(() => getComputedStyle(view().querySelectorAll('b')[1]).color), 'rgb(0, 0, 0)');
    assert.deepEqual(await page.evaluate(() => [...view().querySelectorAll('.gemini-parser-math')].map(math => [math.closest('[dir]')?.getAttribute('dir') || null,
        math.parentElement.style.display])), [['rtl', ''], [null, 'none']]);
    assert.equal(await page.evaluate(() => source.innerHTML === originalMarkup), true);
});

test('boxed native spans retain one box instead of splitting backgrounds, padding or block layout per token', async t => {
    const page = await fixture(t, { html: '<span style="display:block;padding:6px;background:rgb(20,30,40)">**bold** `code` $x$ tail</span>' });
    assert.equal(await page.evaluate(() => view().childNodes.length), 1);
    assert.deepEqual(await page.evaluate(() => [view().firstChild.style.display, view().firstChild.style.padding,
        view().firstChild.style.backgroundColor, !!view().firstChild.querySelector('b'), !!view().firstChild.querySelector('code'),
        !!view().firstChild.querySelector('.katex'), source.innerHTML === originalMarkup]), ['block', '6px', 'rgb(20, 30, 40)', true, true, true, true]);
});

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

test('interactive content added during streaming stays live beside repaired text', async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const button = document.createElement('button'); button.textContent = 'citation';
        window.clicked = 0; button.addEventListener('click', () => clicked++); source.append(button);
    });
    await page.waitForFunction(() => view()?.querySelector('slot[data-gp-native]'));
    await page.locator('#answer button').click();
    assert.equal(await page.evaluate(() => clicked), 1);
    assert.equal(await page.evaluate(() => source.firstChild === originalText), true);
});

test('attachments, native KaTeX, code blocks, user queries, editors, bare table cells and outside text stay native', async t => {
    const page = await fixture(t, { html: '<response-element>**attachment**</response-element>' });
    await page.evaluate(() => {
        const container = document.querySelector('.chat-container');
        container.insertAdjacentHTML('beforeend', '<p id="math"><span class="katex">$native$</span></p><pre><p id="pre">**code**</p></pre><user-query><p id="user">**query**</p></user-query><div contenteditable="true"><p id="editor">**edit**</p></div><table><tr><td id="cell">**table**</td></tr></table>');
    });
    await page.waitForTimeout(70);
    assert.deepEqual(await page.evaluate(() => ['answer', 'math', 'pre', 'user', 'editor', 'cell', 'outside'].map(id => !!document.getElementById(id).shadowRoot)), Array(7).fill(false));
});

async function tableFixture(t, cells, options = {}) {
    const page = await fixture(t, { text: 'plain', ...options });
    await page.evaluate(cells => {
        document.querySelector('#response').insertAdjacentHTML('afterbegin',
            '<div class="table-content"><table><thead><tr><th scope="col"><span data-path-to-node="0,0">**수식**</span></th>' +
            '<th scope="col"><span data-path-to-node="0,1">설명</span></th></tr></thead><tbody>' + cells + '</tbody></table></div>' +
            '<button id="table-copy">Copy table</button>');
        window.table = document.querySelector('table');
        window.tableMarkup = table.outerHTML;
        window.tableNodes = [...table.querySelectorAll('*')];
        window.cell = table.querySelector('td > span');
        window.cellText = cell.firstChild;
        window.cellView = () => cell.shadowRoot?.querySelector('.gp-view');
        document.querySelector('#table-copy').addEventListener('click', () => {
            window.copiedTable = { text: table.innerText, html: table.outerHTML };
        });
    }, cells);
    await page.waitForFunction(() => document.querySelector('th > span').shadowRoot?.querySelector('b'));
    return page;
}

test('Gemini cell spans render the reported formulas and native bold without changing table source or copy data', async t => {
    const page = await tableFixture(t, String.raw`<tr><td><span data-path-to-node="1,0">$\alpha + \beta = -\frac{b}{a}$를 근과 계수의 관계라 부릅니다.</span></td>
        <td><span data-path-to-node="1,1"><b data-path-to-node="1,1" data-index-in-node="0">근과 계수</b>를 활용한 풀이입니다.</span></td></tr>
        <tr><td><span data-path-to-node="2,0">$\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$라는 공식입니다.</span></td>
        <td><span data-path-to-node="2,1"><code data-path-to-node="2,1">$literal$ **code**</code></span></td></tr>`,
    { settings: { boldColor: { color: '#ffcc66' } } });
    assert.deepEqual(await page.evaluate(() => {
        const hosts = [...table.querySelectorAll('td > span')];
        return [hosts.slice(0, 3).filter(host => host.shadowRoot?.querySelector('.katex')).length,
            getComputedStyle(hosts[1].shadowRoot.querySelector('b')).color,
            hosts[3].shadowRoot.querySelector('code').textContent,
            table.outerHTML === tableMarkup, tableNodes.every((node, i) => table.querySelectorAll('*')[i] === node),
            cell.firstChild === cellText, table.querySelectorAll('td').length];
    }), [2, 'rgb(255, 204, 102)', '$literal$ **code**', true, true, true, 4]);
    await page.locator('#table-copy').click();
    assert.deepEqual(await page.evaluate(() => [copiedTable.html === tableMarkup,
        copiedTable.text.includes('$\\alpha + \\beta = -\\frac{b}{a}$'),
        copiedTable.text.includes('$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$')]), [true, true, true]);
    const tree = await page.locator('table').ariaSnapshot();
    assert.match(tree, /columnheader "수식"/);
    assert.doesNotMatch(tree, /\$\\alpha|\$\\sum|\*\*수식\*\*/);
});

test('table streaming and finalization retain source identity and stable formula nodes before paint', async t => {
    const page = await tableFixture(t, '<tr><td><span data-path-to-node="1,0">start **open</span></td><td>native</td></tr>');
    assert.equal(await page.evaluate(() => cell.shadowRoot), null);
    await page.evaluate(() => { cellText.data = '**steady** and $x^2$'; });
    await page.waitForFunction(() => cellView()?.querySelector('.katex'));
    assert.deepEqual(await page.evaluate(async () => {
        const oldView = cellView(), oldBold = oldView.querySelector('b'), oldMath = oldView.querySelector('.gemini-parser-math');
        const bold = document.createElement('b'); bold.setAttribute('data-path-to-node', '1,0'); bold.textContent = 'steady';
        const math = document.createElement('span'); math.className = 'math-inline'; math.setAttribute('data-math', 'x^2');
        katex.render('x^2', math, { output: 'html' });
        cell.replaceChildren(bold, document.createTextNode(' and '), math);
        document.querySelector('footer').classList.remove('animated');
        await new Promise(requestAnimationFrame);
        return [cellView() === oldView, cellView().querySelector('b') === oldBold,
            cellView().querySelector('.gemini-parser-math') === oldMath, cell.firstChild === bold];
    }), [true, true, true, true]);
    assert.equal(await page.evaluate(async () => {
        const oldCell = cell;
        cell = document.createElement('span'); cell.setAttribute('data-path-to-node', '1,0'); cell.textContent = '**replaced**';
        oldCell.replaceWith(cell);
        await new Promise(requestAnimationFrame);
        return cellView()?.querySelector('b')?.textContent;
    }), 'replaced');
});

test('table toggles, selection, off-stream updates and colors use one visible copy', async t => {
    const page = await tableFixture(t, '<tr><td><span data-path-to-node="1,0">**cell value**</span></td><td>native</td></tr>');
    assert.equal(await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(cellView());
        getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString();
    }), 'cell value');
    const tree = await page.locator('tbody td').first().ariaSnapshot();
    assert.doesNotMatch(tree, /\*\*/);
    assert.equal((tree.match(/cell value/g) || []).length, 1, tree);
    await page.evaluate(() => {
        engine.updateSettings({ enabled: false }); cellText.data = '**changed while off**';
    });
    assert.deepEqual(await page.evaluate(() => [cell.firstChild === cellText, cell.shadowRoot.firstChild.tagName,
        cell.innerText, cell.hasAttribute('style')]), [true, 'SLOT', '**changed while off**', false]);
    await page.evaluate(() => {
        for (let i = 0; i < 15; i++) { engine.updateSettings({ enabled: true }); engine.updateSettings({ enabled: false }); }
        engine.updateSettings({ enabled: true, boldColor: { color: '#ffcc66' } });
    });
    await page.waitForFunction(() => cellView()?.querySelector('b')?.textContent === 'changed while off');
    assert.deepEqual(await page.evaluate(() => [cell.shadowRoot.querySelectorAll('.gp-view').length,
        getComputedStyle(cellView().querySelector('b')).color, cell.firstChild === cellText]), [1, 'rgb(255, 204, 102)', true]);
});

test('table geometry, spanning cells and horizontal scrolling remain native and respond to width changes', async t => {
    const page = await tableFixture(t, '<tr><td rowspan="2"><span data-path-to-node="1,0">**' + 'long value '.repeat(12) +
        '**</span></td><td><span data-path-to-node="1,1">**other**</span></td></tr><tr><td>last</td></tr>' +
        '<tr><td colspan="2">spanning</td></tr>');
    await page.addStyleTag({ content: '.table-content{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid gray;vertical-align:top}' });
    const height = await page.locator('table').evaluate(table => table.getBoundingClientRect().height);
    await page.evaluate(() => { document.querySelector('.chat-container').style.width = '240px'; });
    await page.waitForFunction(height => table.getBoundingClientRect().height > height, height);
    assert.deepEqual(await page.evaluate(() => [table.querySelector('td').rowSpan,
        table.querySelector('tr:last-child td').colSpan, table.outerHTML === tableMarkup,
        document.querySelector('#table-copy').getBoundingClientRect().top >= table.getBoundingClientRect().bottom,
        getComputedStyle(table).display, getComputedStyle(table.querySelector('td')).display]), [2, 2, true, true, 'table', 'table-cell']);
    await page.evaluate(() => { table.style.minWidth = '600px'; });
    assert.equal(await page.evaluate(() => {
        const wrapper = table.parentElement; wrapper.scrollLeft = 50;
        return wrapper.scrollWidth > wrapper.clientWidth && wrapper.scrollLeft === 50;
    }), true);
});

test('cell widgets, native formula hosts and unsupported attributes stay native, including late-arriving controls', async t => {
    const page = await tableFixture(t, '<tr><td><span data-path-to-node="1,0">**safe**</span></td><td>' +
        '<span role="button">**widget**</span><span tabindex="0">**focus**</span><span title="tooltip">**tip**</span>' +
        '<span class="math-inline" data-math="x">x</span><span class="citation">**cite**</span>' +
        '<span><button>**button**</button></span></td></tr>');
    assert.equal(await page.evaluate(() => [...table.querySelectorAll('td:nth-child(2) > span')].every(span => !span.shadowRoot)), true);
    assert.equal(await page.evaluate(async () => {
        const button = document.createElement('button'); button.textContent = 'native action';
        window.cellClicks = 0; button.addEventListener('click', () => cellClicks++); cell.append(button);
        await new Promise(requestAnimationFrame); return cellView()?.querySelector('b')?.textContent === 'safe' && button.getBoundingClientRect().height > 0;
    }), true);
    await page.locator('td button').filter({ hasText: 'native action' }).click();
    assert.equal(await page.evaluate(() => cellClicks), 1);
    await page.evaluate(() => { cell.querySelector('button').remove(); });
    await page.waitForFunction(() => cellView()?.querySelector('b'));
    await page.evaluate(() => { cell.setAttribute('role', 'button'); });
    await page.waitForFunction(() => !cellView());
});

test('cell hosts moved outside a cell release their projection and regain it when moved back', async t => {
    const page = await tableFixture(t, '<tr><td><span data-path-to-node="1,0">**moving**</span></td><td>native</td></tr>');
    await page.evaluate(() => document.querySelector('#response').append(cell));
    await page.waitForFunction(() => !cellView());
    await page.evaluate(() => table.querySelector('td').append(cell));
    await page.waitForFunction(() => cellView()?.querySelector('b')?.textContent === 'moving');
    assert.equal(await page.evaluate(() => cell.firstChild === cellText), true);
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

test('citation components stay live while adjacent broken Markdown, math and native bold receive repair', async t => {
    const page = await fixture(t, { html: String.raw`<span data-path-to-node="0,0">**fixed** $x^2$ </span><sources-carousel-inline id="citation"><source-inline-chip><button id="chip" aria-haspopup="dialog">PNG</button></source-inline-chip></sources-carousel-inline><span data-path-to-node="0,1"> <b data-path-to-node="0,1">native bold</b> \(y^2\)</span>`,
        settings: { boldColor: { color: '#ffcc66' } } });
    await page.evaluate(() => { source.lastChild.lastChild.textContent = ' \\(y^2\\)'; });
    await page.waitForFunction(() => view()?.querySelectorAll('.katex').length === 2);
    assert.deepEqual(await page.evaluate(() => {
        const island = source.querySelector('sources-carousel-inline'); window.citation = island;
        window.chip = source.querySelector('#chip'); window.chipClicks = 0;
        chip.addEventListener('click', () => chipClicks++);
        return [source.firstChild === originalText, island.parentElement === source, island.hasAttribute('slot'),
            view().querySelector('sources-carousel-inline') === null,
            view().querySelector('slot[data-gp-native]').assignedNodes()[0] === island,
            [...view().querySelectorAll('b')].map(b => getComputedStyle(b).color)];
    }), [true, true, false, true, true, ['rgb(255, 204, 102)', 'rgb(255, 204, 102)']]);
    await page.locator('#chip').click();
    assert.equal(await page.evaluate(() => chipClicks), 1);
    const tree = await page.locator('#answer').ariaSnapshot();
    assert.match(tree, /button "PNG"/); assert.equal((tree.match(/button "PNG"/g) || []).length, 1);
    assert.doesNotMatch(tree, /\*\*fixed\*\*/);
    assert.equal(await page.evaluate(() => source.innerText.includes('**fixed**') &&
        (source.innerText.match(/PNG/g) || []).length === 1), true);
});

test('late citations mount before paint without dropping previously repaired text or formula nodes', async t => {
    const page = await fixture(t, { text: '**steady** $x^2$ ' });
    assert.deepEqual(await page.evaluate(async () => {
        const oldView = view(), bold = oldView.querySelector('b'), math = oldView.querySelector('.gemini-parser-math');
        window.citation = document.createElement('sources-carousel-inline');
        const button = document.createElement('button'); button.textContent = 'PNG'; citation.append(button); source.append(citation);
        await new Promise(requestAnimationFrame);
        return [view() === oldView, view().querySelector('b') === bold,
            view().querySelector('.gemini-parser-math') === math, citation.parentElement === source,
            view().querySelector('slot[data-gp-native]').assignedNodes()[0] === citation,
            button.getBoundingClientRect().height > 0];
    }), [true, true, true, true, true, true]);
});

test('citation focus, popup handlers and component lifecycle survive streaming and rapid toggles', async t => {
    const page = await fixture(t, { html: '**fixed** <sources-carousel-inline><button id="chip">PNG</button><div id="popup" hidden><p>**native popup**</p></div></sources-carousel-inline> tail' });
    await page.evaluate(() => {
        window.connections = 0; window.disconnections = 0;
        customElements.define('sources-carousel-inline', class extends HTMLElement {
            connectedCallback() { connections++; } disconnectedCallback() { disconnections++; }
        });
        window.citation = source.querySelector('sources-carousel-inline'); window.chip = document.getElementById('chip');
        chip.addEventListener('click', () => document.getElementById('popup').hidden = !document.getElementById('popup').hidden);
        chip.focus(); source.lastChild.textContent = ' **streamed tail**';
    });
    await page.waitForFunction(() => view()?.querySelectorAll('b').length === 2);
    assert.equal(await page.evaluate(() => document.activeElement === chip), true);
    await page.locator('#chip').click();
    await page.waitForFunction(() => !document.getElementById('popup').hidden);
    assert.deepEqual(await page.evaluate(() => [!!view(), document.querySelector('#popup p').shadowRoot,
        citation.parentElement === source, connections, disconnections]), [true, null, true, 1, 0]);
    await page.evaluate(() => {
        for (let i = 0; i < 15; i++) { engine.updateSettings({ enabled: false }); engine.updateSettings({ enabled: true }); }
    });
    await page.locator('#chip').click();
    assert.deepEqual(await page.evaluate(() => [document.getElementById('popup').hidden,
        connections, disconnections, view().querySelectorAll('slot[data-gp-native]').length]), [true, 1, 0, 1]);
});

test('replaced, reordered and removed citation components get the current native slot without stale text', async t => {
    const page = await fixture(t, { html: '**left** <sources-carousel-inline><button>PNG A</button></sources-carousel-inline> **middle** <source-inline-chip><button>PNG B</button></source-inline-chip> **right**' });
    assert.equal(await page.locator('#answer').getByRole('button').count(), 2);
    await page.evaluate(() => {
        window.oldCitation = source.querySelector('sources-carousel-inline');
        window.nextCitation = document.createElement('sources-carousel-inline');
        const button = document.createElement('button'); button.textContent = 'PNG C'; nextCitation.append(button); oldCitation.replaceWith(nextCitation);
        source.prepend(source.querySelector('source-inline-chip'));
    });
    await page.waitForFunction(() => view()?.querySelectorAll('slot[data-gp-native]').length === 2 &&
        view().querySelectorAll('slot[data-gp-native]')[1].assignedNodes()[0] === nextCitation);
    assert.deepEqual(await page.locator('#answer').getByRole('button').allTextContents(), ['PNG B', 'PNG C']);
    await page.evaluate(() => { source.querySelector('source-inline-chip').remove(); nextCitation.remove(); });
    await page.waitForFunction(() => view()?.querySelectorAll('slot[data-gp-native]').length === 0);
    assert.equal(await page.locator('#answer').getByRole('button').count(), 0);
    assert.equal(await page.evaluate(() => view().querySelectorAll('b').length), 3);
});

test('manual native passthrough displays new source children while disabled, after fallback and after destroy', async t => {
    const page = await fixture(t);
    for (const mode of ['disabled', 'fallback', 'destroyed']) {
        await page.evaluate(mode => {
            if (mode === 'disabled') engine.updateSettings({ enabled: false });
            else if (mode === 'fallback') {
                engine.updateSettings({ enabled: true });
                source.setAttribute('contenteditable', 'true');
            } else engine.destroy();
        }, mode);
        await page.waitForFunction(() => !view());
        await page.evaluate(mode => {
            const span = document.createElement('span'); span.textContent = mode;
            const chip = document.createElement('sources-carousel-inline'); chip.textContent = 'PNG';
            source.replaceChildren(span, chip);
        }, mode);
        await page.waitForFunction(() => source.shadowRoot.firstChild.assignedNodes().length === 2);
        assert.deepEqual(await page.evaluate(() => [source.innerText, source.firstChild.getBoundingClientRect().height > 0]), [mode + 'PNG', true]);
        if (mode === 'disabled') await page.evaluate(() => { source.textContent = '**alpha**'; });
    }
});

test('native citation attributes, text and shadow contents are opaque to parser colors and syntax', async t => {
    const page = await fixture(t, { html: '**fixed** <sources-carousel-inline style="color:rgb(1,2,3)"><button>**literal** $x$</button></sources-carousel-inline>', settings: { boldColor: { color: '#ffcc66' } } });
    assert.equal(await page.locator('#answer').getByRole('button', { name: '**literal** $x$', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('b').length, view().querySelectorAll('.katex').length,
        getComputedStyle(source.querySelector('sources-carousel-inline')).color, source.innerHTML === originalMarkup]), [1, 0, 'rgb(1, 2, 3)', true]);
    await page.evaluate(() => {
        const root = source.querySelector('sources-carousel-inline').attachShadow({ mode: 'open' });
        const slot = document.createElement('slot'); root.append(slot); window.nativeChipRoot = root;
        source.firstChild.textContent = '**updated** ';
    });
    await page.waitForFunction(() => view()?.querySelector('b')?.textContent === 'updated');
    assert.equal(await page.evaluate(() => nativeChipRoot.childNodes.length === 1 && nativeChipRoot.firstChild.tagName === 'SLOT'), true);
});

test('citation slots preserve text wrapping and keep following blocks below the actual height', async t => {
    const page = await fixture(t, { html: '**' + 'long text '.repeat(10) + '** <sources-carousel-inline><button>PNG + 2</button></sources-carousel-inline> **' + 'more text '.repeat(10) + '**' });
    const height = await page.locator('#answer').evaluate(p => p.getBoundingClientRect().height);
    await page.evaluate(() => { document.querySelector('.chat-container').style.width = '220px'; });
    await page.waitForFunction(height => source.getBoundingClientRect().height > height, height);
    assert.deepEqual(await page.evaluate(() => [document.querySelector('footer').getBoundingClientRect().top >= source.getBoundingClientRect().bottom,
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        source.innerHTML === originalMarkup]), [true, true, true]);
});

test('Gemini metadata-wrapped response widgets remain live beside repaired text and citation chips', async t => {
    const page = await fixture(t, { html: '<span data-path-to-node="0,0">**fixed** $x^2$</span>' +
        '<span data-path-to-node="0,1"><span><response-element><a id="widget" href="#source">**widget text**</a><p>**popup content**</p></response-element></span></span>' +
        '<span data-path-to-node="0,2"> **tail**</span><sources-carousel-inline><button>PNG</button></sources-carousel-inline>' });
    await page.waitForFunction(() => view()?.querySelector('.katex'));
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('b').length, view().querySelectorAll('slot[data-gp-native]').length,
        source.innerHTML === originalMarkup, source.querySelector('response-element p').shadowRoot,
        view().querySelector('slot[data-gp-native]').assignedNodes()[0] === source.children[1]]), [2, 2, true, null, true]);
    await page.locator('#widget').click();
    assert.equal(new URL(page.url()).hash, '#source');
    assert.equal(await page.locator('#answer').getByRole('button', { name: 'PNG', exact: true }).count(), 1);
    const tree = await page.locator('#answer').ariaSnapshot();
    assert.match(tree, /link "\*\*widget text\*\*"/); assert.doesNotMatch(tree, /\*\*fixed\*\*/);
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

test('quoted Korean emphasis and strike repair without loosening identifier underscores', async t => {
    const page = await fixture(t, { text: '**"중요"**입니다 **(괄호)**도 *"기울임"*은 ~~"취소"~~입니다 변수__이름__입니다' });
    await rendered(page, '"중요"입니다 (괄호)도 "기울임"은 "취소"입니다 변수__이름__입니다');
    assert.deepEqual(await page.evaluate(() => [Array.from(view().querySelectorAll('b')).map(b => b.textContent),
        view().querySelector('i').textContent, view().querySelector('s').textContent]), [['"중요"', '(괄호)'], '"기울임"', '"취소"']);
});

test('inline code backslashes are literal and closing ticks still end the code', async t => {
    const page = await fixture(t, { text: '`C:\\` **after**' });
    await rendered(page, 'C:\\ after');
    assert.deepEqual(await page.evaluate(() => [view().querySelector('code').textContent,
        view().querySelector('b').textContent]), ['C:\\', 'after']);
});

test('code whitespace normalization matches finalized native tokens', async t => {
    const page = await fixture(t, { text: '`` code ` x `` and `a\nb` and `   `' });
    assert.deepEqual(await page.evaluate(() => Array.from(view().querySelectorAll('code')).map(c => c.textContent)), ['code ` x', 'a b', '   ']);
    assert.equal(await page.evaluate(async () => {
        const codes = Array.from(view().querySelectorAll('code'));
        source.replaceChildren(...Array.from(view().childNodes).map(node => {
            if (node.nodeType === 3) return node.cloneNode();
            const code = document.createElement('code'); code.textContent = node.textContent; code.setAttribute('data-path-to-node', '0'); return code;
        }));
        await new Promise(requestAnimationFrame);
        return codes.every((code, i) => view().querySelectorAll('code')[i] === code);
    }), true);
});

test('literal HTML entity spellings are not decoded a second time from native text', async t => {
    const page = await fixture(t, { text: '&copy; &amp; &#42; **yes**' });
    await rendered(page, '&copy; &amp; &#42; yes');
    assert.equal(await page.evaluate(() => source.textContent), '&copy; &amp; &#42; **yes**');
});

test('bracket LaTeX delimiters stay opaque and render instead of losing backslashes', async t => {
    const page = await fixture(t, { text: '\\(x^2\\) **bold** \\[\\frac{a}{b}\\]' });
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('.katex').length,
        view().querySelectorAll('.katex-display').length, view().querySelector('b').textContent]), [2, 1, 'bold']);
    await page.evaluate(() => engine.updateSettings({ latex: false }));
    await rendered(page, '\\(x^2\\) bold \\[\\frac{a}{b}\\]');
});

test('hidden and translucent native inline content keeps its presentation in the shadow view', async t => {
    const page = await fixture(t, { html: '**fixed** <span style="display:none">hidden</span><span style="opacity:.2;visibility:hidden">faint</span><b data-path-to-node="0" style="display:none">hidden bold</b>' });
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(view().querySelector('span')).display,
        getComputedStyle(view().querySelectorAll('span')[1]).opacity, getComputedStyle(view().querySelectorAll('span')[1]).visibility,
        getComputedStyle(view().querySelectorAll('b')[1]).display]), ['none', '0.2', 'hidden', 'none']);
});

test('class changes on ancestors inside the chat refresh copied inline styles', async t => {
    const page = await fixture(t, { html: '<span class="native">native</span> **fixed**' });
    await page.evaluate(() => {
        const style = document.createElement('style');style.textContent = '.theme .native{color:rgb(0,80,120)}';document.head.append(style);
        document.querySelector('#response').classList.add('theme');
    });
    await page.waitForFunction(() => view().querySelector('span') && getComputedStyle(view().querySelector('span')).color === 'rgb(0, 80, 120)', null, { timeout: 1000 });
});

test('prices do not become formulas or swallow following emphasis', async t => {
    const page = await fixture(t, { text: '가격 $20이고 **중요**합니다. cost $20 and $30; **bold**. 수식 $20$과 $2+x$' });
    assert.deepEqual(await page.evaluate(() => [Array.from(view().querySelectorAll('b')).map(b => b.textContent),
        Array.from(view().querySelectorAll('.gemini-parser-math')).map(m => m.getAttribute('data-math'))]), [['중요', 'bold'], ['20', '2+x']]);
    assert.ok(await page.evaluate(() => view().textContent.includes('cost $20 and $30;')));
});

test('metadata-only spans can split inline delimiters without blocking repair', async t => {
    const page = await fixture(t, { html: '<span data-path-to-node="0">**bo</span><span data-index-in-node="1" _ngcontent-test="">ld**</span>' });
    await rendered(page, 'bold');
    assert.deepEqual(await page.evaluate(() => [view().querySelectorAll('b').length, source.innerHTML === originalMarkup]), [1, true]);
});

test('nested underline pairs ignore tag spellings inside opaque code and math', async t => {
    const page = await fixture(t, { text: '<u>outer <u>inner</u> `</u>` $\\text{</u>}$ tail</u>' });
    assert.deepEqual(await page.evaluate(() => [view().querySelector('u u')?.textContent,
        view().querySelector('u code')?.textContent, view().querySelector('u .gemini-parser-math')?.getAttribute('data-math'),
        view().lastChild.tagName, view().lastChild.lastChild.textContent]), ['inner', '</u>', '\\text{</u>}', 'U', ' tail']);
});

test('native math visibility and opacity survive projection', async t => {
    const page = await fixture(t, { html: '**fixed** <span class="math-inline" data-math="x" style="display:none">x</span><span class="math-inline" data-math="y" style="opacity:.2;visibility:hidden">y</span>' });
    assert.deepEqual(await page.evaluate(() => { const maths = view().querySelectorAll('.gemini-parser-math');return [
        getComputedStyle(maths[0]).display, getComputedStyle(maths[1]).opacity, getComputedStyle(maths[1]).visibility];
    }), ['none', '0.2', 'hidden']);
});

test('new interactive content is shown natively before the next animation frame', async t => {
    const page = await fixture(t);
    assert.equal(await page.evaluate(async () => {
        const button = document.createElement('button'); button.textContent = 'source'; source.append(button);
        await new Promise(requestAnimationFrame);
        return view()?.querySelector('b')?.textContent === 'alpha' && button.getBoundingClientRect().height > 0;
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

test('theme changes update copied native inline styles, and new interactive attributes preserve the live element', async t => {
    const page = await fixture(t, { html: '<span style="font-weight:bold">native</span> **fixed**' });
    await page.evaluate(() => { document.body.style.color = 'rgb(0, 80, 120)'; });
    await page.waitForFunction(() => view().querySelector('span') && getComputedStyle(view().querySelector('span')).color === 'rgb(0, 80, 120)', null, {timeout:1000});
    await page.evaluate(() => { source.firstChild.setAttribute('data-citation-id', 'new-source'); });
    await page.waitForFunction(() => view()?.querySelector('slot[data-gp-native]'));
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
