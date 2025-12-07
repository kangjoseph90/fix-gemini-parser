// ==UserScript==
// @name         Fix Gemini Parser
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Gemini에서 깨지는 수식($...$)과 마크다운을 고쳐줍니다.
// @author       kangjoseph90
// @match        https://gemini.google.com/*
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @resource     KATEX_CSS https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css
// ==/UserScript==

(function() {
    'use strict';

    // ==================================
    // 🔧 사용자 설정
    // ==================================
    const SETTINGS = {
        enabled: true,
        latex: true,
        bold: true,
        italic: true,
        strike: true,
        underline: true,
        code: true
    };

    // ==================================
    // 🎨 색상/스타일 설정
    // ==================================
    // 각 항목은 null이거나 다음 형식의 객체:
    // { color: '#ff0000', opacity: 100, customCss: 'font-weight: bold' }
    const COLOR_SETTINGS = {
        boldColor: null,
        italicColor: null,
        strikeColor: null,
        underlineColor: null,
        codeColor: null,
        mathColor: null
    };

    if (!SETTINGS.enabled) return;

    // ==================================
    // 스타일 주입
    // ==================================
    GM_addStyle(GM_getResourceText("KATEX_CSS"));
    GM_addStyle(`
        .katex { font-size: 1.1em; }
        .math-inline-wrapper { display: inline-block; }
    `);

    // Trusted Types 정책
    let htmlPolicy = { createHTML: (s) => s };
    if (window.trustedTypes?.createPolicy) {
        try {
            htmlPolicy = window.trustedTypes.createPolicy('gemini-parser', {
                createHTML: (s) => s
            });
        } catch (e) { console.warn(e); }
    }

    // 플레이스홀더 패턴 (충돌 방지용 null 문자 사용)
    const PH = {
        PREFIX: '\x00\x01GP_',
        SUFFIX: '_\x01\x00',
        CODE: (i) => `\x00\x01GP_CODE_${i}_\x01\x00`,
        MATH: (i) => `\x00\x01GP_MATH_${i}_\x01\x00`,
        ELEM: (i) => `\x00\x01GP_ELEM_${i}_\x01\x00`,
        REGEX: {
            CODE: /\x00\x01GP_CODE_(\d+)_\x01\x00/g,
            MATH: /\x00\x01GP_MATH_(\d+)_\x01\x00/g,
            ELEM: /\x00\x01GP_ELEM_(\d+)_\x01\x00/g
        }
    };

    // ==================================
    // 커스텀 스타일 주입
    // ==================================
    function injectCustomStyles() {
        let css = '';

        // 헬퍼 함수: 각 스타일 항목 CSS 생성
        function buildStyleRule(selector, colorData) {
            if (!colorData) return '';
            
            let rule = `${selector} { `;
            
            // 기본 색상과 투명도
            if (colorData.color) {
                rule += `color: ${colorData.color} !important; `;
            }
            if (colorData.opacity !== undefined && colorData.opacity !== 100) {
                rule += `opacity: ${colorData.opacity / 100} !important; `;
            }
            
            // 커스텀 CSS 추가
            if (colorData.customCss) {
                // 각 속성에 !important 추가 (없는 경우)
                const customRules = colorData.customCss
                    .split(';')
                    .map(r => r.trim())
                    .filter(r => r)
                    .map(r => r.includes('!important') ? r : r + ' !important')
                    .join('; ');
                if (customRules) {
                    rule += customRules + '; ';
                }
            }
            
            rule += '}\n';
            return rule;
        }

        css += buildStyleRule('.gemini-parser-bold', COLOR_SETTINGS.boldColor);
        css += buildStyleRule('.gemini-parser-italic', COLOR_SETTINGS.italicColor);
        css += buildStyleRule('.gemini-parser-strike', COLOR_SETTINGS.strikeColor);
        css += buildStyleRule('.gemini-parser-underline', COLOR_SETTINGS.underlineColor);
        css += buildStyleRule('.gemini-parser-code', COLOR_SETTINGS.codeColor);
        css += buildStyleRule('.gemini-parser-math', COLOR_SETTINGS.mathColor);

        if (css) {
            GM_addStyle(css);
        }
    }

    // ==================================
    // DOM → Markdown 변환
    // ==================================
    function serialize(node, ctx = { preserved: [] }) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        // 보존해야 할 요소 (화이트리스트)
        if (node.tagName === 'RESPONSE-ELEMENT' ||
            node.classList.contains('attachment-container')
        ) {
            const index = ctx.preserved.push(node.outerHTML) - 1;
            return PH.ELEM(index);
        }

        const tag = node.tagName;
        const children = Array.from(node.childNodes).map(c => serialize(c, ctx)).join('');

        switch (tag) {
            case 'I':
            case 'EM':
                return `*${children}*`;
            case 'B':
            case 'STRONG':
                return `**${children}**`;
            case 'S':
            case 'DEL':
                return `~~${children}~~`;
            case 'U':
                return `<u>${children}</u>`;
            case 'CODE':
                return `\`${children}\``;
            case 'BR':
                return '\n';
            default:
                if (node.classList.contains('math-inline')) {
                    const math = node.getAttribute('data-math');
                    if (math) return `$${math}$`;
                }
                return children;
        }
    }

    // ==================================
    // Markdown → HTML 변환
    // ==================================
    function render(text, preserved = []) {
        // HTML 이스케이프
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 1. 인라인 코드 보호
        const codes = [];
        if (SETTINGS.code) {
            html = html.replace(/(`+)(.*?)\1/g, (_, tick, content) => {
                codes.push(`<code class="gemini-parser-code">${content}</code>`);
                return PH.CODE(codes.length - 1);
            });
        }

        // 2. LaTeX 수식
        const maths = [];
        if (SETTINGS.latex && typeof katex !== 'undefined') {
            html = html.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
                try {
                    const clean = latex
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&');
                    const rendered = katex.renderToString(clean, {
                        throwOnError: true,
                        output: 'html',
                        displayMode: false
                    });
                    maths.push(`<span class="math-inline gemini-parser-math" data-math="${clean}">${rendered}</span>`);
                    return PH.MATH(maths.length - 1);
                } catch {
                    return match;
                }
            });
        }

        // 3. 마크다운 서식
        if (SETTINGS.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<b class="gemini-parser-bold">$1</b>');
        if (SETTINGS.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i class="gemini-parser-italic">$1</i>');
        if (SETTINGS.strike) html = html.replace(/~~(.*?)~~/g, '<s class="gemini-parser-strike">$1</s>');
        if (SETTINGS.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u class="gemini-parser-underline">$1</u>');

        // 4. 코드 복구
        if (SETTINGS.code) {
            html = html.replace(PH.REGEX.CODE, (_, i) => codes[i]);
        }

        // 5. 줄바꿈
        html = html.replace(/\n/g, '<br>');

        // 6. 수식 복구
        if (SETTINGS.latex) {
            html = html.replace(PH.REGEX.MATH, (_, i) => maths[i]);
        }

        // 7. 보존된 요소 복구
        html = html.replace(PH.REGEX.ELEM, (_, i) => preserved[i]);

        return html;
    }

    // ==================================
    // 처리 필요 여부 체크
    // ==================================
    function needsProcessing(text) {
        if (!text.trim()) return false;
        return /\*|\$|`|~~|<u>/.test(text);
    }

    // ==================================
    // 메인 렌더링
    // ==================================
    const SELECTOR = 'p:not([data-rendered]), h1:not([data-rendered]), h2:not([data-rendered]), h3:not([data-rendered]), h4:not([data-rendered]), td:not([data-rendered]), th:not([data-rendered])';

    function reRender() {
        if (!SETTINGS.enabled) return;

        const container = document.querySelector('.chat-container');
        if (!container) return;

        // 스트리밍 중이면 건너뛰기
        if (container.querySelector('.response-footer.animated')) return;

        container.querySelectorAll(SELECTOR).forEach(el => {
            const ctx = { preserved: [] };
            const markdown = serialize(el, ctx);

            if (!needsProcessing(markdown)) {
                el.setAttribute('data-rendered', '');
                return;
            }

            const newHtml = render(markdown, ctx.preserved);
            if (el.innerHTML !== newHtml) {
                el.innerHTML = htmlPolicy.createHTML(newHtml);
            }
            el.setAttribute('data-rendered', '');
        });
    }

    // ==================================
    // 초기화
    // ==================================
    // 커스텀 스타일 주입
    injectCustomStyles();

    // DOM 변경 감지
    new MutationObserver(() => reRender()).observe(document.body, {
        childList: true,
        subtree: true
    });

    reRender();
    console.log('[Gemini Parser] Started');

})();