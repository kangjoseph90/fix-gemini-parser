// ==================================
// Fix Gemini Parser - Content Script
// ==================================

// 설정
let SETTINGS = {
    enabled: true,
    latex: true,
    bold: true,
    italic: true,
    strike: true,
    underline: true,
    code: true
};

// Trusted Types 정책
let htmlPolicy = { createHTML: (s) => s };
if (window.trustedTypes?.createPolicy) {
    try {
        htmlPolicy = window.trustedTypes.createPolicy('gemini-parser', {
            createHTML: (s) => s
        });
    } catch (e) { console.warn(e); }
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
            codes.push(`<code class="gemini-parser-code">${content}</code>`);
            return `__CODE_${codes.length - 1}__`;
        });
    }

    // 2. LaTeX 수식
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
                return `<span class="math-inline gemini-parser-math" data-math="${clean}">${rendered}</span>`;
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
        html = html.replace(/__CODE_(\d+)__/g, (_, i) => codes[i]);
    }

    // 5. 줄바꿈
    return html.replace(/\n/g, '<br>');
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
chrome.storage.sync.get(SETTINGS, (stored) => {
    SETTINGS = { ...SETTINGS, ...stored };

    if (!SETTINGS.enabled) {
        console.log('[Gemini Parser] 비활성화됨');
        return;
    }

    // DOM 변경 감지
    new MutationObserver(() => reRender()).observe(document.body, {
        childList: true,
        subtree: true
    });

    reRender();
    console.log('[Gemini Parser] 시작됨');

    // 설정 변경 리스너
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'settingsUpdated') {
            SETTINGS = msg.settings;
            document.querySelectorAll('[data-rendered]').forEach(el => {
                el.removeAttribute('data-rendered');
            });
            reRender();
        }
    });
});