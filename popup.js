// 설정 키 목록
const SETTING_KEYS = ['enabled', 'latex', 'bold', 'italic', 'strike', 'underline', 'code'];

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

// DOM 요소
const elements = {};
const optionsSection = document.getElementById('options-section');
const statusEl = document.getElementById('status');

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    // 요소 캐시
    SETTING_KEYS.forEach(key => {
        elements[key] = document.getElementById(key);
    });

    // 저장된 설정 불러오기
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
        SETTING_KEYS.forEach(key => {
            elements[key].checked = settings[key];
        });
        updateOptionsState(settings.enabled);
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
});

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
        // 현재 탭에 메시지 전송
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'settingsUpdated', settings });
            }
        });
    });
}

// 저장 상태 표시
function showStatus() {
    statusEl.classList.add('show');
    setTimeout(() => {
        statusEl.classList.remove('show');
    }, 1500);
}
