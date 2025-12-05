// ==UserScript==
// @name         Fix Gemini Parser
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Gemini, AI Studio 등에서 깨지는 수식($...$)과 마크다운을 고쳐줍니다.
// @author       kangjoseph90
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @resource     KATEX_CSS https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // 🔧 사용자 설정 (여기서 true/false 수정)
    // ============================================
    const SETTINGS = {
        enabled: true,      // 전체 on/off
        latex: true,        // $수식$ 파싱
        bold: true,         // **볼드** 파싱
        italic: true,       // *이탤릭* 파싱
        strike: true,       // ~~취소선~~ 파싱
        underline: true,    // <u>밑줄</u> 파싱
        code: true,         // `코드` 파싱
    };
    // ============================================

    // 전체 비활성화시 종료
    if (!SETTINGS.enabled) {
        console.log('[AI Fixer] Disabled by user settings');
        return;
    }

    // KaTeX CSS 스타일 주입
    GM_addStyle(GM_getResourceText("KATEX_CSS"));
    GM_addStyle(`
        .katex { font-size: 1.1em; }
        .math-inline-wrapper { display: inline-block; }
    `);

    // 보안 정책 우회
    let htmlPolicy = { createHTML: (string) => string };
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            htmlPolicy = window.trustedTypes.createPolicy('ai-fixer-userscript', {
                createHTML: (string) => string,
            });
        } catch (e) {}
    }

    // ============================================
    // 사이트별 설정
    // ============================================

    const geminiConfig = {
        name: 'gemini',
        hostPattern: /gemini\.google\.com/,
        targetSelector: '.chat-container',
        elementSelector: 'p:not([data-rerendered="true"]), h1:not([data-rerendered="true"]), h2:not([data-rerendered="true"]), h3:not([data-rerendered="true"]), h4:not([data-rerendered="true"]), td:not([data-rerendered="true"]), th:not([data-rerendered="true"])',

        serialize(node) {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName.toUpperCase();
                const children = Array.from(node.childNodes).map(n => this.serialize(n)).join('');

                switch (tagName) {
                    case 'I':
                    case 'EM':
                        return `*${children}*`;
                    case 'B':
                    case 'STRONG':
                        return `**${children}**`;
                    case 'CODE':
                        return `\`${children}\``;
                    case 'BR':
                        return '\n';
                    default:
                        if (node.classList.contains('math-inline')) {
                            const mathData = node.getAttribute('data-math');
                            if (mathData) return `$${mathData}$`;
                        }
                        return children;
                }
            }
            return '';
        },

        render(rawText) {
            let html = rawText
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");

            // 인라인 코드 보호
            const codeBlocks = [];
            if (SETTINGS.code) {
                html = html.replace(/(`+)(.*?)\1/g, (match, tick, content) => {
                    codeBlocks.push(`<code>${content}</code>`);
                    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
                });
            }

            // LaTeX 수식
            if (SETTINGS.latex && typeof katex !== 'undefined') {
                html = html.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
                    try {
                        const cleanLatex = latex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
                        return katex.renderToString(cleanLatex, { throwOnError: true, output: 'html', displayMode: false });
                    } catch (e) { return match; }
                });
            }

            // Markdown → Gemini 스타일
            if (SETTINGS.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            if (SETTINGS.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i>$1</i>');
            if (SETTINGS.strike) html = html.replace(/~~(.*?)~~/g, '<s>$1</s>');
            if (SETTINGS.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>');

            // 코드 블록 복구 & 줄바꿈
            if (SETTINGS.code) html = html.replace(/__CODE_BLOCK_(\d+)__/g, (m, i) => codeBlocks[i]);
            html = html.replace(/\n/g, '<br>');

            return html;
        },

        needsProcessing(rawText) {
            if (!rawText.trim()) return false;
            const patterns = [];
            if (SETTINGS.bold || SETTINGS.italic) patterns.push('\\*');
            if (SETTINGS.latex) patterns.push('\\$');
            if (SETTINGS.code) patterns.push('`');
            if (SETTINGS.strike) patterns.push('~~');
            if (SETTINGS.underline) patterns.push('<u>');
            return patterns.length > 0 && new RegExp(patterns.join('|')).test(rawText);
        }
    };

    const aistudioConfig = {
        name: 'aistudio',
        hostPattern: /aistudio\.google\.com/,
        targetSelector: '.chat-session-content',
        elementSelector: 'p:not([data-rerendered="true"]), h1:not([data-rerendered="true"]), h2:not([data-rerendered="true"]), h3:not([data-rerendered="true"]), h4:not([data-rerendered="true"]), td:not([data-rerendered="true"]), th:not([data-rerendered="true"])',

        serialize(node) {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName.toUpperCase();
                const children = Array.from(node.childNodes).map(n => this.serialize(n)).join('');

                switch (tagName) {
                    case 'EM':
                        return `*${children}*`;
                    case 'STRONG':
                        return `**${children}**`;
                    case 'S':
                    case 'DEL':
                        return `~~${children}~~`;
                    case 'BR':
                        return '\n';
                    case 'MS-KATEX':
                        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
                        if (annotation) return `$${annotation.textContent}$`;
                        return '';
                    case 'MS-CMARK-NODE':
                        return children;
                    default:
                        if (node.classList.contains('inline-code')) {
                            return `\`${children}\``;
                        }
                        return children;
                }
            }
            return '';
        },

        render(rawText) {
            let html = rawText
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");

            // 인라인 코드 보호
            const codeBlocks = [];
            if (SETTINGS.code) {
                html = html.replace(/(`+)(.*?)\1/g, (match, tick, content) => {
                    codeBlocks.push(`<span class="inline-code">${content}</span>`);
                    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
                });
            }

            // LaTeX 수식
            if (SETTINGS.latex && typeof katex !== 'undefined') {
                html = html.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
                    try {
                        const cleanLatex = latex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
                        return katex.renderToString(cleanLatex, { throwOnError: true, output: 'html', displayMode: false });
                    } catch (e) { return match; }
                });
            }

            // Markdown → AI Studio 스타일
            if (SETTINGS.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            if (SETTINGS.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<span style="font-style:italic">$1</span>');
            if (SETTINGS.strike) html = html.replace(/~~(.*?)~~/g, '<s>$1</s>');
            if (SETTINGS.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>');

            // 코드 블록 복구 & 줄바꿈
            if (SETTINGS.code) html = html.replace(/__CODE_BLOCK_(\d+)__/g, (m, i) => codeBlocks[i]);
            html = html.replace(/\n/g, '<br>');

            return html;
        },

        needsProcessing(rawText) {
            if (!rawText.trim()) return false;
            const patterns = [];
            if (SETTINGS.bold || SETTINGS.italic) patterns.push('\\*');
            if (SETTINGS.latex) patterns.push('\\$');
            if (SETTINGS.code) patterns.push('`');
            if (SETTINGS.strike) patterns.push('~~');
            if (SETTINGS.underline) patterns.push('<u>');
            return patterns.length > 0 && new RegExp(patterns.join('|')).test(rawText);
        }
    };

    // ============================================
    // 공통 엔진
    // ============================================

    const siteConfigs = [geminiConfig, aistudioConfig];

    function detectSiteConfig() {
        const hostname = window.location.hostname;
        for (const config of siteConfigs) {
            if (config.hostPattern.test(hostname)) {
                console.log(`[AI Fixer] Detected site: ${config.name}`);
                return config;
            }
        }
        return null;
    }

    function createEngine(config) {
        function reRenderContent() {
            const container = document.querySelector(config.targetSelector);
            if (!container) return;

            const elements = container.querySelectorAll(config.elementSelector);
            elements.forEach(elem => {
                const rawText = config.serialize(elem);

                if (!config.needsProcessing(rawText)) {
                    elem.setAttribute('data-rerendered', 'true');
                    return;
                }

                const newHtml = config.render(rawText);
                if (elem.innerHTML !== newHtml) {
                    elem.innerHTML = htmlPolicy.createHTML(newHtml);
                }
                elem.setAttribute('data-rerendered', 'true');
            });
        }

        function observe() {
            const observer = new MutationObserver((mutations) => {
                const needsUpdate = mutations.some(m =>
                    m.addedNodes.length > 0 ||
                    (m.type === 'childList' && ['P', 'H1', 'H2', 'H3', 'H4', 'TD', 'TH'].includes(m.target.tagName))
                );
                if (needsUpdate) reRenderContent();
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });

            reRenderContent();
            console.log(`[AI Fixer] Engine started for ${config.name}`);
        }

        return { observe, reRenderContent };
    }

    // 실행
    const siteConfig = detectSiteConfig();
    if (siteConfig) {
        createEngine(siteConfig).observe();
    } else {
        console.warn('[AI Fixer] Unsupported site');
    }

})();