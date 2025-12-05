// AI Studio 사이트 설정
const aistudioConfig = {
    name: 'aistudio',
    hostPattern: /aistudio\.google\.com/,
    
    // DOM 선택자
    targetSelector: '.chat-session-content',
    elementSelector: 'p:not([data-rerendered="true"]), h1:not([data-rerendered="true"]), h2:not([data-rerendered="true"]), h3:not([data-rerendered="true"]), h4:not([data-rerendered="true"]), td:not([data-rerendered="true"]), th:not([data-rerendered="true"])',
    
    // DOM → Raw Text 변환 (항상 마크다운 구문으로)
    serialize(node, settings) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toUpperCase();
            const children = Array.from(node.childNodes).map(n => this.serialize(n, settings)).join('');

            switch (tagName) {
                case 'STRONG':
                    return `**${children}**`;
                case 'S':
                case 'DEL':
                    return `~~${children}~~`;
                case 'U':
                    return `<u>${children}</u>`;
                case 'BR':
                    return '\n';
                case 'MS-KATEX':
                    // 이미 렌더링된 KaTeX에서 annotation으로 원본 추출
                    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
                    if (annotation) {
                        return `$${annotation.textContent}$`;
                    }
                    return '';
                case 'MS-CMARK-NODE':
                    // 래퍼 태그, 껍데기만 벗김
                    return children;
                default:
                    // inline-code 클래스 처리
                    if (node.classList.contains('inline-code')) {
                        return `\`${children}\``;
                    }
                    if (node.tagName === 'SPAN' && node.style.fontStyle === 'italic') {
                        return `*${children}*`;
                    }
                    return children;
            }
        }
        return '';
    },

    // Raw Text → HTML 변환 (AI Studio 스타일)
    render(rawText, settings) {
        let html = rawText
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        // 인라인 코드 보호
        const codeBlocks = [];
        if (settings.code) {
            html = html.replace(/(`+)(.*?)\1/g, (match, tick, content) => {
                codeBlocks.push(`<span class="inline-code">${content}</span>`);
                return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
            });
        }

        // 2. LaTeX 수식
        if (settings.latex && typeof katex !== 'undefined') {
            html = html.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
                try {
                    const cleanLatex = latex
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">")
                        .replace(/&amp;/g, "&");
                    return katex.renderToString(cleanLatex, {
                        throwOnError: true,
                        output: 'html',
                        displayMode: false
                    });
                } catch (e) {
                    return match;
                }
            });
        }

        // 3. Markdown → AI Studio 스타일 HTML
        if (settings.bold) html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        if (settings.italic) html = html.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<span style="font-style:italic">$1</span>');
        if (settings.strike) html = html.replace(/~~(.*?)~~/g, '<s>$1</s>');
        if (settings.underline) html = html.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>');

        // 4. 코드 블록 복구
        if (settings.code) html = html.replace(/__CODE_BLOCK_(\d+)__/g, (m, i) => codeBlocks[i]);

        // 5. 줄바꿈
        html = html.replace(/\n/g, '<br>');

        return html;
    },

    // 처리 필요 여부 체크
    needsProcessing(rawText, settings) {
        if (!rawText.trim()) return false;
        return new RegExp('\\*|\\$|`|~~|<u>').test(rawText);
    }
};

// 전역으로 등록
if (typeof window.siteConfigs === 'undefined') {
    window.siteConfigs = [];
}
window.siteConfigs.push(aistudioConfig);
