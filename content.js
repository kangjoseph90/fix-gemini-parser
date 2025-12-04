const targetSelector = '.content-container'; 

let htmlPolicy = { createHTML: (string) => string };
if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
        htmlPolicy = window.trustedTypes.createPolicy('re-build-engine', {
            createHTML: (string) => string,
        });
    } catch (e) { console.warn(e); }
}

function serializeToRawText(node) {
    // 1. 텍스트 노드면 값 그대로 반환
    if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue;
    }

    // 2. 요소 노드 처리
    if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();

        // <i> 태그 -> *내용*
        if (tagName === 'I' || tagName === 'EM') {
            return `*${Array.from(node.childNodes).map(serializeToRawText).join('')}*`;
        }

        // <b>, <strong> 태그 -> **내용**
        if (tagName === 'B' || tagName === 'STRONG') {
            return `**${Array.from(node.childNodes).map(serializeToRawText).join('')}**`;
        }

        // <br> 태그 -> 줄바꿈
        if (tagName === 'BR') {
            return '\n';
        }

        // <span class="math-inline"> -> $data-math값$
        if (node.classList.contains('math-inline')) {
            const mathData = node.getAttribute('data-math');
            if (mathData) {
                // data-math 값이 있으면 $...$ 로 감싸서 반환
                return `$${mathData}$`;
            }
            // data-math가 없으면 내부 텍스트라도 건짐
        }

        // 그 외 일반 태그(span 등)는 껍데기 벗기고 내용물만 재귀적으로 수집
        return Array.from(node.childNodes).map(serializeToRawText).join('');
    }

    return '';
}

function parseAndRender(rawText) {
    let processedHtml = rawText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // 1. 인라인 코드 보호 (`...`) 
    // 코드 블록 안의 *, $ 가 파싱되는 것을 방지
    const codeBlocks = [];
    processedHtml = processedHtml.replace(/(`+)(.*?)\1/g, (match, tick, content) => {
        codeBlocks.push(`<code style="background:#eee; padding:2px 4px; border-radius:3px; font-family:monospace;">${content}</code>`);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // 2. LaTeX 수식 파싱 ($...$)
    if (typeof katex !== 'undefined') {
        processedHtml = processedHtml.replace(/(?<!\\)\$([^$]+?)\$/g, (match, latex) => {
            try {
                // HTML entity로 변환된 문자들을 다시 되돌려야 KaTeX가 인식함 (&lt; -> <)
                const cleanLatex = latex
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&amp;/g, "&");

                const rendered = katex.renderToString(cleanLatex, {
                    throwOnError: false,
                    output: 'html',
                    displayMode: false
                });
                return `<span class="math-inline-wrapper">${rendered}</span>`;
            } catch (e) {
                return match;
            }
        });
    }

    // 3. Markdown 서식 파싱
    // **Bold**
    processedHtml = processedHtml.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    // *Italic* (Step 1에서 i 태그를 *로 바꿨으므로 여기서 다시 i 태그로 복구됨)
    processedHtml = processedHtml.replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '<i>$1</i>');

    // 4. 코드 블록 복구
    processedHtml = processedHtml.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => {
        return codeBlocks[index];
    });

    // 5. 줄바꿈 처리
    processedHtml = processedHtml.replace(/\n/g, '<br>');

    return processedHtml;
}

function reRenderContent() {
    const container = document.querySelector(targetSelector);
    if (!container) return;

    // 아직 건드리지 않은 p 태그들 수집
    const paragraphs = container.querySelectorAll('p:not([data-rerendered="true"])');

    paragraphs.forEach(p => {
        // 기존 DOM 해체
        const rawText = serializeToRawText(p);

        // 바꿀거 없으면 스킵
        if (!rawText.trim() || !rawText.match(/\*|\$|`/)) {
            p.setAttribute('data-rerendered', 'true');
            return;
        }

        // 텍스트 재렌더링
        const newHtml = parseAndRender(rawText);

        // DOM 덮어씌우기
        if (p.innerHTML !== newHtml) {
            p.innerHTML = htmlPolicy.createHTML(newHtml);
        }
        
        // 처리 완료 표시
        p.setAttribute('data-rerendered', 'true');
    });
}

const observer = new MutationObserver((mutations) => {
    const needsUpdate = mutations.some(m => 
        m.addedNodes.length > 0 || 
        (m.type === 'childList' && m.target.tagName === 'P')
    );
    if (needsUpdate) reRenderContent();
});

observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
});

reRenderContent();