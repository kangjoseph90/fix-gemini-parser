// 설정 키 목록
const SETTING_KEYS = ['enabled', 'latex', 'bold', 'italic', 'strike', 'underline', 'code'];

// 색상 키 목록
const COLOR_KEYS = ['boldColor', 'italicColor', 'strikeColor', 'underlineColor', 'codeColor', 'mathColor'];

// 기본값
const DEFAULT_SETTINGS = {
    enabled: true,
    latex: true,
    bold: true,
    italic: true,
    strike: true,
    underline: true,
    code: true
};

// 기본 색상값 (null = 사용자 설정 없음)
const DEFAULT_COLORS = {
    boldColor: null,
    italicColor: null,
    strikeColor: null,
    underlineColor: null,
    codeColor: null,
    mathColor: null
};

// DOM 요소
const elements = {};
const optionsSection = document.getElementById('options-section');
const statusEl = document.getElementById('status');

// 모달 요소
const modal = document.getElementById('color-modal');
const modalTitle = document.getElementById('modal-title');
const closeModalBtn = document.getElementById('close-modal-btn');
const colorInput = document.getElementById('color-input');
const opacityInput = document.getElementById('opacity-input');
const opacityValue = document.getElementById('opacity-value');
const previewText = document.getElementById('preview-text');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');

// 고급 설정 요소
const advancedToggle = document.getElementById('advanced-toggle');
const advancedSettings = document.getElementById('advanced-settings');
const customCssInput = document.getElementById('custom-css-input');

// 현재 편집 중인 색상 키
let currentColorKey = null;
let colorSettings = { ...DEFAULT_COLORS };

// 라벨 매핑
const LABEL_MAP = {
    boldColor: 'Bold',
    italicColor: 'Italic',
    strikeColor: 'Strikethrough',
    underlineColor: 'Underline',
    codeColor: 'Inline Code',
    mathColor: 'LaTeX Math'
};

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    // 요소 캐시
    SETTING_KEYS.forEach(key => {
        elements[key] = document.getElementById(key);
    });

    // 저장된 설정 불러오기
    chrome.storage.sync.get({ ...DEFAULT_SETTINGS, ...DEFAULT_COLORS }, (settings) => {
        SETTING_KEYS.forEach(key => {
            elements[key].checked = settings[key];
        });
        
        // 색상 설정 로드
        COLOR_KEYS.forEach(key => {
            colorSettings[key] = settings[key];
        });
        
        updateOptionsState(settings.enabled);
        updateColorButtons();
    });

    // 이벤트 리스너 등록
    SETTING_KEYS.forEach(key => {
        elements[key].addEventListener('change', () => {
            saveSettings();
            if (key === 'enabled') {
                updateOptionsState(elements[key].checked);
            }
        });
    });

    // 색상 버튼 이벤트
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openColorModal(btn.dataset.key);
        });
    });

    // 모달 이벤트
    colorInput.addEventListener('input', updatePreview);
    opacityInput.addEventListener('input', () => {
        opacityValue.textContent = opacityInput.value + '%';
        updatePreview();
    });

    saveBtn.addEventListener('click', saveColor);
    resetBtn.addEventListener('click', resetColor);
    closeModalBtn.addEventListener('click', closeModal);

    // 고급 설정 토글
    advancedToggle.addEventListener('click', () => {
        const isHidden = advancedSettings.classList.contains('hidden');
        advancedSettings.classList.toggle('hidden');
        advancedToggle.classList.toggle('expanded', isHidden);
        advancedToggle.textContent = isHidden ? '▲ Advanced Settings' : '▼ Advanced Settings';
    });

    // 모달 외부 클릭 시 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
});

// 색상 버튼 업데이트
function updateColorButtons() {
    document.querySelectorAll('.color-btn').forEach(btn => {
        const key = btn.dataset.key;
        const colorData = colorSettings[key];
        
        if (colorData && (colorData.color || colorData.customCss)) {
            if (colorData.color) {
                btn.style.backgroundColor = colorData.color;
                btn.style.opacity = (colorData.opacity ?? 100) / 100;
            }
            btn.classList.add('has-color');
        } else {
            btn.style.backgroundColor = 'transparent';
            btn.style.opacity = 1;
            btn.classList.remove('has-color');
        }
    });
}

// 색상 모달 열기
function openColorModal(key) {
    currentColorKey = key;
    modalTitle.textContent = LABEL_MAP[key] + ' Style';
    
    const colorData = colorSettings[key];
    if (colorData) {
        colorInput.value = colorData.color || '#ffffff';
        opacityInput.value = colorData.opacity ?? 100;
        customCssInput.value = colorData.customCss || '';
    } else {
        colorInput.value = '#ffffff';
        opacityInput.value = 100;
        customCssInput.value = '';
    }
    
    // 고급 설정 초기 상태로 닫기
    advancedSettings.classList.add('hidden');
    advancedToggle.classList.remove('expanded');
    advancedToggle.textContent = '▼ Advanced Settings';
    
    opacityValue.textContent = opacityInput.value + '%';
    updatePreview();
    modal.classList.remove('hidden');
}

// 미리보기 업데이트
function updatePreview() {
    const color = colorInput.value;
    const opacity = opacityInput.value / 100;
    previewText.style.color = color;
    previewText.style.opacity = opacity;
}

// 색상 저장
function saveColor() {
    if (!currentColorKey) return;

    colorSettings[currentColorKey] = {
        color: colorInput.value,
        opacity: parseInt(opacityInput.value),
        customCss: customCssInput.value.trim()
    };

    chrome.storage.sync.set(colorSettings, () => {
        updateColorButtons();
        notifyContentScript();
        closeModal();
    });
}

// 색상 초기화
function resetColor() {
    if (!currentColorKey) return;

    colorSettings[currentColorKey] = null;

    chrome.storage.sync.set(colorSettings, () => {
        updateColorButtons();
        notifyContentScript();
        closeModal();
    });
}

// 모달 닫기
function closeModal() {
    modal.classList.add('hidden');
    currentColorKey = null;
}

// 옵션 섹션 활성화/비활성화
function updateOptionsState(enabled) {
    if (enabled) {
        optionsSection.classList.remove('disabled');
        SETTING_KEYS.filter(k => k !== 'enabled').forEach(key => {
            elements[key].disabled = false;
        });
    } else {
        optionsSection.classList.add('disabled');
        SETTING_KEYS.filter(k => k !== 'enabled').forEach(key => {
            elements[key].disabled = true;
        });
    }
}

// 설정 저장
function saveSettings() {
    const settings = {};
    SETTING_KEYS.forEach(key => {
        settings[key] = elements[key].checked;
    });

    chrome.storage.sync.set(settings, () => {
        showStatus();
        notifyContentScript();
    });
}

// 콘텐츠 스크립트에 알림
function notifyContentScript() {
    const allSettings = {};
    SETTING_KEYS.forEach(key => {
        allSettings[key] = elements[key].checked;
    });
    Object.assign(allSettings, colorSettings);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'settingsUpdated', settings: allSettings });
        }
    });
}

// 저장 상태 표시
function showStatus() {
    statusEl.classList.add('show');
    setTimeout(() => {
        statusEl.classList.remove('show');
    }, 1500);
}
