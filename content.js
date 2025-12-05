// ============================================
// 공통 실행기 (사이트별 로직은 sites/*.js에서 정의)
// ============================================

// 전역 설정 객체
let SETTINGS = {
    enabled: true,
    latex: true,
    bold: true,
    italic: true,
    strike: true,
    underline: true,
    code: true
};

let htmlPolicy = { createHTML: (string) => string };
if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
        htmlPolicy = window.trustedTypes.createPolicy('re-build-engine', {
            createHTML: (string) => string,
        });
    } catch (e) { console.warn(e); }
}

// 현재 사이트에 맞는 config 찾기
function detectSiteConfig() {
    const hostname = window.location.hostname;
    const configs = window.siteConfigs || [];
    
    for (const config of configs) {
        if (config.hostPattern.test(hostname)) {
            console.log(`[ReRender] Detected site: ${config.name}`);
            return config;
        }
    }
    
    console.warn('[ReRender] No matching site config found for:', hostname);
    return null;
}

// 엔진 생성 함수
function createEngine(config) {
    if (!config) return null;

    // 메인 렌더링 함수
    function reRenderContent() {
        if (!SETTINGS.enabled) return;
        
        const container = document.querySelector(config.targetSelector);
        if (!container) return;

        const elements = container.querySelectorAll(config.elementSelector);

        elements.forEach(elem => {
            // 사이트별 serialize 메소드 사용 (SETTINGS 전달)
            const rawText = config.serialize(elem, SETTINGS);

            // 사이트별 처리 필요 여부 체크
            if (!config.needsProcessing(rawText, SETTINGS)) {
                elem.setAttribute('data-rerendered', 'true');
                return;
            }

            // 사이트별 render 메소드 사용 (SETTINGS 전달)
            const newHtml = config.render(rawText, SETTINGS);

            if (elem.innerHTML !== newHtml) {
                elem.innerHTML = htmlPolicy.createHTML(newHtml);
            }
            
            elem.setAttribute('data-rerendered', 'true');
        });
    }

    // MutationObserver 시작
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

        // 초기 실행
        reRenderContent();
        
        console.log(`[ReRender] Engine started for ${config.name}`);
    }

    return { observe, reRenderContent };
}

// 설정 불러오기 및 엔진 시작
chrome.storage.sync.get(SETTINGS, (stored) => {
    SETTINGS = { ...SETTINGS, ...stored };
    
    if (!SETTINGS.enabled) {
        console.log('[ReRender] Extension disabled by user');
        return;
    }
    
    const siteConfig = detectSiteConfig();
    if (siteConfig) {
        const engine = createEngine(siteConfig);
        engine.observe();
        
        // 설정 변경 리스너
        chrome.runtime.onMessage.addListener((message) => {
            if (message.type === 'settingsUpdated') {
                SETTINGS = message.settings;
                // 기존 렌더링 마크 제거하여 재렌더링 트리거
                document.querySelectorAll('[data-rerendered]').forEach(el => {
                    el.removeAttribute('data-rerendered');
                });
                engine.reRenderContent();
                console.log('[ReRender] Settings updated:', SETTINGS);
            }
        });
    } else {
        console.warn('[ReRender] Extension disabled - unsupported site');
    }
});