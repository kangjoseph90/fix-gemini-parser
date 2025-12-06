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

// 색상 설정
let COLOR_SETTINGS = {
    boldColor: null,
    italicColor: null,
    strikeColor: null,
    underlineColor: null,
    codeColor: null,
    mathColor: null
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

// 커스텀 스타일 요소
let customStyleEl = null;

// ==================================
// 커스텀 스타일 주입
// ==================================
function injectCustomStyles() {
    if (!customStyleEl) {
        customStyleEl = document.createElement('style');
        customStyleEl.id = 'gemini-parser-custom-styles';
        document.head.appendChild(customStyleEl);
    }

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

    customStyleEl.textContent = css;
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
    if (SETTINGS.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<b class="gemini-parser-bold">$1</b>');
    if (SETTINGS.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i class="gemini-parser-italic">$1</i>');
    if (SETTINGS.strike) html = html.replace(/~~(.*?)~~/g, '<s class="gemini-parser-strike">$1</s>');
    if (SETTINGS.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u class="gemini-parser-underline">$1</u>');

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
const ALL_KEYS = [
    'enabled', 'latex', 'bold', 'italic', 'strike', 'underline', 'code',
    'boldColor', 'italicColor', 'strikeColor', 'underlineColor', 'codeColor', 'mathColor'
];

chrome.storage.sync.get(ALL_KEYS, (stored) => {
    // 설정 적용
    SETTINGS = {
        enabled: stored.enabled ?? true,
        latex: stored.latex ?? true,
        bold: stored.bold ?? true,
        italic: stored.italic ?? true,
        strike: stored.strike ?? true,
        underline: stored.underline ?? true,
        code: stored.code ?? true
    };

    // 색상 설정 적용
    COLOR_SETTINGS = {
        boldColor: stored.boldColor ?? null,
        italicColor: stored.italicColor ?? null,
        strikeColor: stored.strikeColor ?? null,
        underlineColor: stored.underlineColor ?? null,
        codeColor: stored.codeColor ?? null,
        mathColor: stored.mathColor ?? null
    };

    if (!SETTINGS.enabled) {
        console.log('[Gemini Parser] Disabled');
        return;
    }

    // 커스텀 스타일 주입
    injectCustomStyles();

    // DOM 변경 감지
    new MutationObserver(() => reRender()).observe(document.body, {
        childList: true,
        subtree: true
    });

    reRender();
    console.log('[Gemini Parser] Started');

    // 설정 변경 리스너
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'settingsUpdated') {
            const s = msg.settings;
            
            SETTINGS = {
                enabled: s.enabled ?? SETTINGS.enabled,
                latex: s.latex ?? SETTINGS.latex,
                bold: s.bold ?? SETTINGS.bold,
                italic: s.italic ?? SETTINGS.italic,
                strike: s.strike ?? SETTINGS.strike,
                underline: s.underline ?? SETTINGS.underline,
                code: s.code ?? SETTINGS.code
            };

            COLOR_SETTINGS = {
                boldColor: s.boldColor ?? null,
                italicColor: s.italicColor ?? null,
                strikeColor: s.strikeColor ?? null,
                underlineColor: s.underlineColor ?? null,
                codeColor: s.codeColor ?? null,
                mathColor: s.mathColor ?? null
            };

            // 커스텀 스타일 재주입
            injectCustomStyles();

            document.querySelectorAll('[data-rendered]').forEach(el => {
                el.removeAttribute('data-rendered');
            });
            reRender();
        }
    });
});