/* Chrome adapter. Register listeners even when the initial setting is disabled. */
(function () {
    'use strict';
    const keys = [...Object.keys(GeminiParser.DEFAULTS), ...GeminiParser.COLOR_KEYS];
    let engine = null;
    const pending = {};

    function apply(values) {
        if (engine) engine.updateSettings(values);
        else Object.assign(pending, values);
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message.type === 'settingsUpdated') apply(message.settings);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const values = {};
        keys.forEach(key => {
            if (Object.hasOwn(changes, key)) values[key] = changes[key].newValue ?? GeminiParser.DEFAULTS[key] ?? null;
        });
        apply(values);
    });

    chrome.storage.sync.get(keys, stored => {
        engine = GeminiParser.createEngine({ settings: { ...stored, ...pending }, katex });
        globalThis.geminiParserEngine = engine;
        const cssURL = chrome.runtime.getURL('lib/katex.min.css');
        fetch(cssURL).then(response => {
            if (!response.ok) throw new Error(`KaTeX stylesheet: ${response.status}`);
            return response.text();
        }).then(css => {
            const resolved = css.replace(/url\(([^)]+)\)/g, (_, url) => {
                const relative = url.trim().replace(/^['"]|['"]$/g, '');
                return `url("${new URL(relative, cssURL).href}")`;
            });
            engine.setKatexCss(resolved);
        }).catch(error => console.warn('[Gemini Parser] Math kept as source text; stylesheet unavailable:', error));
    });
})();
