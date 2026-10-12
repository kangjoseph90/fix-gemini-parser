/* Editable userscript defaults. Run npm run build:userscript after changes. */
(function () {
    'use strict';
    const SETTINGS = { ...GeminiParser.DEFAULTS,
        enabled: GM_getValue('enabled', true),
        boldColor: null, italicColor: null, strikeColor: null,
        underlineColor: null, codeColor: null, mathColor: null
    };
    const cssURL = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
    const css = GM_getResourceText('KATEX_CSS').replace(/url\(([^)]+)\)/g, (_, url) =>
        `url("${new URL(url.trim().replace(/^['"]|['"]$/g, ''), cssURL).href}")`);
    const engine = GeminiParser.createEngine({ settings: SETTINGS, katex, katexCss: css });
    GM_registerMenuCommand('Fix Gemini Parser: Toggle', () => {
        SETTINGS.enabled = !SETTINGS.enabled;
        GM_setValue('enabled', SETTINGS.enabled);
        engine.updateSettings({ enabled: SETTINGS.enabled });
    });
})();
