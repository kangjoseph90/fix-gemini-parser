// ==UserScript==
// @name         Fix Gemini Parser
// @namespace    http://tampermonkey.net/
// @version      3.3
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
        } catch (e) {}
    }

    // ==================================
    // DOM → Markdown 변환
    // ==================================
    function serialize(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const tag = node.tagName;
        const children = Array.from(node.childNodes).map(serialize).join('');

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
    function render(text) {
        // HTML 이스케이프
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 1. 인라인 코드 보호
        const codes = [];
        if (SETTINGS.code) {
            html = html.replace(/(`+)(.*?)\1/g, (_, tick, content) => {
                codes.push(`<code>${content}</code>`);
                return `__CODE_${codes.length - 1}__`;
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
                    return `__MATH_${maths.length - 1}__`;
                } catch {
                    return match;
                }
            });
        }

        // 3. 마크다운 서식
        if (SETTINGS.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        if (SETTINGS.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i>$1</i>');
        if (SETTINGS.strike) html = html.replace(/~~(.*?)~~/g, '<s>$1</s>');
        if (SETTINGS.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>');

        // 4. 코드 복구
        if (SETTINGS.code) {
            html = html.replace(/__CODE_(\d+)__/g, (_, i) => codes[i]);
        }

        // 5. 줄바꿈
        html = html.replace(/\n/g, '<br>');
        
        // 6. 수식 복구
        if (SETTINGS.latex) {
            html = html.replace(/__MATH_(\d+)__/g, (_, i) => maths[i]);
        }
    
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
        const container = document.querySelector('.chat-container');
        if (!container) return;

        // 스트리밍 중이면 건너뛰기
        if (container.querySelector('.pending, .animating')) return;

        container.querySelectorAll(SELECTOR).forEach(el => {
            const markdown = serialize(el);

            if (!needsProcessing(markdown)) {
                el.setAttribute('data-rendered', '');
                return;
            }

            const newHtml = render(markdown);
            if (el.innerHTML !== newHtml) {
                el.innerHTML = htmlPolicy.createHTML(newHtml);
            }
            el.setAttribute('data-rendered', '');
        });
    }

    // ==================================
    // 초기화
    // ==================================
    new MutationObserver(() => reRender()).observe(document.body, {
        childList: true,
        subtree: true
    });

    reRender();
    console.log('[Gemini Parser] 시작됨');

})();