// ==UserScript==
// @name         Gemini Math & Markdown Fixer
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Google Gemini 모바일/PC 웹에서 깨지는 수식($...$)과 볼드체(**...**)를 강제로 고쳐줍니다.
// @author       My AI Partner
// @match        https://gemini.google.com/*
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @resource     KATEX_CSS https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css
// ==/UserScript==

(function() {
    'use strict';

    // 1. KaTeX CSS 스타일 주입 (인터넷에서 불러옴)
    const katexCss = GM_getResourceText("KATEX_CSS");
    GM_addStyle(katexCss);
    
    // 추가 스타일: 수식 폰트 강제 적용 및 줄바꿈 보정
    GM_addStyle(`
        .katex { font-size: 1.1em; }
        .math-inline-wrapper { display: inline-block; }
    `);

    // 설정: 감시할 컨테이너
    const targetSelector = '.content-container';

    // 보안 정책 우회 (모바일은 보통 필요 없지만 혹시 몰라 넣어둠)
    let htmlPolicy = { createHTML: (string) => string };
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            htmlPolicy = window.trustedTypes.createPolicy('gemini-fixer-userscript', {
                createHTML: (string) => string,
            });
        } catch (e) {}
    }

    // --- [핵심 로직] ---

    function serializeToRawText(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toUpperCase();
            if (tagName === 'I' || tagName === 'EM') return `*${Array.from(node.childNodes).map(serializeToRawText).join('')}*`;
            if (tagName === 'B' || tagName === 'STRONG') return `**${Array.from(node.childNodes).map(serializeToRawText).join('')}**`;
            if (tagName === 'BR') return '\n';
            if (node.classList.contains('math-inline')) {
                const mathData = node.getAttribute('data-math');
                if (mathData) return `$${mathData}$`;
            }
            return Array.from(node.childNodes).map(serializeToRawText).join('');
        }
        return '';
    }

    function parseAndRender(rawText) {
        let processedHtml = rawText
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        // 코드 블록 보호
        const codeBlocks = [];
        processedHtml = processedHtml.replace(/(`+)(.*?)\1/g, (match, tick, content) => {
            codeBlocks.push(`<code style="background:rgba(135,131,120,0.15); padding:0.2em 0.4em; border-radius:3px; font-family:monospace;">${content}</code>`);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });

        // LaTeX 파싱 (KaTeX)
        if (typeof katex !== 'undefined') {
            processedHtml = processedHtml.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
                try {
                    const cleanLatex = latex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
                    const rendered = katex.renderToString(cleanLatex, {
                        throwOnError: false, output: 'html', displayMode: false
                    });
                    return `<span class="math-inline-wrapper">${rendered}</span>`;
                } catch (e) { return match; }
            });
        }

        // Markdown 파싱
        processedHtml = processedHtml.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        processedHtml = processedHtml.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i>$1</i>');

        // 복구
        processedHtml = processedHtml.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => codeBlocks[index]);
        processedHtml = processedHtml.replace(/\n/g, '<br>');

        return processedHtml;
    }

    function reRenderContent() {
        const container = document.querySelector(targetSelector);
        if (!container) return;

        const paragraphs = container.querySelectorAll('p:not([data-rerendered="true"])');
        paragraphs.forEach(p => {
            const rawText = serializeToRawText(p);
            if (!rawText.trim() || !rawText.match(/\*|\$|`/)) {
                p.setAttribute('data-rerendered', 'true');
                return;
            }
            const newHtml = parseAndRender(rawText);
            if (p.innerHTML !== newHtml) {
                p.innerHTML = htmlPolicy.createHTML(newHtml);
            }
            p.setAttribute('data-rerendered', 'true');
        });
    }

    // 감시 시작
    const observer = new MutationObserver((mutations) => {
        const needsUpdate = mutations.some(m => m.addedNodes.length > 0 || (m.type === 'childList' && m.target.tagName === 'P'));
        if (needsUpdate) reRenderContent();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(reRenderContent, 1000);

})();