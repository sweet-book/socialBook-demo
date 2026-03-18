/**
 * 구글포토북 앱 — Google OAuth, Photos Picker, JSON 데이터, 책 생성
 */

const MIN_PAGES_FOR_FINALIZE = 24;
const MIN_PAGES_FOR_PUBLISH = 22;
const MAX_BOOK_PAGES = 130;

let client = null;
let accessToken = sessionStorage.getItem('google_access_token') || null;
let tokenExpiresAt = sessionStorage.getItem('token_expires_at') ? parseInt(sessionStorage.getItem('token_expires_at')) : null;
let pickerApiLoaded = false;
let selectedPhotos = [];
let expirationTimerInterval = null;
let dataItems = [];
let activeSource = 'google'; // 'google' | 'local' | 'json'
let _paused = false;     // 일시중지 요청 플래그
let _saved = null;       // 이어서하기용 스냅샷

// ── 환경별 API Key 저장 ──
const _envKeys = { live: '', sandbox: '' };

function getSelectedEnv() {
    return document.querySelector('input[name="apiEnv"]:checked')?.value || 'sandbox';
}

function onEnvChange() {
    const keyInput = document.getElementById('userApiKey');
    const prev = document.querySelector('input[name="apiEnv"]:not(:checked)')?.value;
    if (prev && keyInput) _envKeys[prev] = keyInput.value;
    const env = getSelectedEnv();
    if (keyInput) keyInput.value = _envKeys[env] || '';
    const warn = document.getElementById('envWarning');
    if (warn) {
        const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        warn.style.display = (env === 'live' && isLocal) ? '' : 'none';
    }
    client = null;
}

// ── Google 설정 ──
const GOOGLE_CONFIG = {
    client_id: (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.googleClientId) || '',
    api_key: (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.googleApiKey) || '',
};

// ── config.js 기본값 적용 ──
document.addEventListener('DOMContentLoaded', async () => {
    if (typeof APP_CONFIG !== 'undefined') {
        if (APP_CONFIG.environments) {
            const envs = APP_CONFIG.environments;
            if (envs.live?.apiKey) _envKeys.live = envs.live.apiKey;
            if (envs.sandbox?.apiKey) _envKeys.sandbox = envs.sandbox.apiKey;
        } else if (APP_CONFIG.userApiKey) {
            _envKeys.live = APP_CONFIG.userApiKey;
            _envKeys.sandbox = APP_CONFIG.userApiKey;
        }
        const defaultEnv = APP_CONFIG.defaultEnv || 'sandbox';
        const radio = document.querySelector(`input[name="apiEnv"][value="${defaultEnv}"]`);
        if (radio) radio.checked = true;
        document.getElementById('userApiKey').value = _envKeys[getSelectedEnv()] || '';
    }
    document.querySelectorAll('input[name="apiEnv"]').forEach(r => {
        r.addEventListener('change', onEnvChange);
    });
    await loadTemplateUids();
    renderTemplateUidFields();
    renderCoverFields();

    // Google API 체크
    const checkGoogle = setInterval(() => {
        if (typeof google !== 'undefined' && google.accounts) {
            clearInterval(checkGoogle); pickerApiLoaded = true;
            if (accessToken) updateSigninStatus(true);
        }
    }, 100);
    handlePickerCallback();
});

function getBaseUrl() {
    const env = getSelectedEnv();
    let apiUrl;
    if (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.environments?.[env]?.url) {
        apiUrl = APP_CONFIG.environments[env].url;
    } else {
        const url = APP_CONFIG?.apiServers?.[0]?.url || document.getElementById('apiServer')?.value || 'https://api.sweetbook.com/v1';
        apiUrl = env === 'sandbox' ? url.replace('://dev-api.', '://dev-api-sandbox.').replace('://api.', '://api-sandbox.') : url;
    }
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        return `/proxy/api/${apiUrl}`;
    }
    return apiUrl;
}

function getClient() {
    const apiKey = document.getElementById('userApiKey').value.trim();
    const baseUrl = getBaseUrl();
    const useCookie = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.useCookie) || false;
    if (!apiKey && !useCookie) { alert('API Key를 입력하세요.'); return null; }
    _envKeys[getSelectedEnv()] = apiKey;
    client = new SweetbookClient({ apiKey: apiKey || undefined, baseUrl, useCookie });
    return client;
}

function getSelectedType() {
    return document.querySelector('input[name="photobookType"]:checked').value;
}

// ── DOM 요소 ──
const authorizeButton = document.getElementById('authorize-button');
const signoutButton = document.getElementById('signout-button');
const googlePickArea = document.getElementById('google-pick-area');
const localPhotoInfo = document.getElementById('local-photo-info');
const localPhotoInput = document.getElementById('local-photo-input');
const dateWarning = document.getElementById('date-warning');
const dateEditList = document.getElementById('date-edit-list');
const applyDatesBtn = document.getElementById('apply-dates');
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const dataPreview = document.getElementById('dataPreview');
const dataItemsContainer = document.getElementById('dataItems');
const itemCount = document.getElementById('itemCount');
const photosGridGoogle = document.getElementById('photos-grid-google');
const photoCountGoogle = document.getElementById('photo-count-google');
const photosGridLocal = document.getElementById('photos-grid-local');
const photoCountLocal = document.getElementById('photo-count-local');
const bookOptions = document.getElementById('bookOptions');
const createBookBtn = document.getElementById('createBookBtn');
const resetBtn = document.getElementById('resetBtn');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const resultMessage = document.getElementById('resultMessage');
const logArea = document.getElementById('logArea');
const messageArea = document.getElementById('message-area');
const messageText = document.getElementById('message-text');

// ── 버튼 상태 관리 ──
function setButtons(state) {
    const show = (el, v) => el.style.display = v ? 'inline-block' : 'none';
    const pauseBtn = document.getElementById('pauseBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    createBookBtn.disabled = state !== 'idle';
    show(pauseBtn, state === 'running');
    show(resumeBtn, state === 'paused' || state === 'stopped');
    resetBtn.disabled = state === 'running';
}

// 활성 소스에 맞는 photosGrid/photoCount 반환
function getActivePhotosGrid() { return activeSource === 'local' ? photosGridLocal : photosGridGoogle; }
function getActivePhotoCount() { return activeSource === 'local' ? photoCountLocal : photoCountGoogle; }

// ── 소스 탭 전환 ──
function switchSource(source) {
    if (source === activeSource) return;
    // 이전 데이터 초기화
    clearAllData();
    activeSource = source;
    // 탭 UI
    document.querySelectorAll('.source-tab').forEach(t => t.classList.toggle('active', t.dataset.source === source));
    document.querySelectorAll('.source-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + source));
    showMessage('');
}

document.querySelectorAll('.source-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSource(tab.dataset.source));
});

// ── 데이터 전체 초기화 ──
function clearAllData() {
    selectedPhotos.forEach(p => { if (p._isLocalFile && p.mediaFile?.baseUrl) URL.revokeObjectURL(p.mediaFile.baseUrl); });
    selectedPhotos = []; dataItems = []; localPhotoFiles = [];
    photosGridGoogle.innerHTML = ''; photoCountGoogle.textContent = '';
    photosGridLocal.innerHTML = ''; photoCountLocal.textContent = '';
    dataPreview.classList.remove('show'); dateWarning.style.display = 'none';
    localDropArea.style.display = ''; localPhotoInfo.style.display = 'none';
    fileInfo.classList.remove('show'); fileInput.value = '';
    bookOptions.classList.remove('show'); createBookBtn.disabled = true;
    resultMessage.classList.remove('show'); logArea.style.display = 'none'; logArea.innerHTML = '';
    showMessage('');
}

// ── 폼 필드 초기화 ──
function clearFormFields() {
    ['bookTitle', 'coverSubtitle', 'coverDateRange',
     'publishTitle', 'publishDate', 'publishAuthor', 'publishHashtags', 'publishPublisher'
    ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

// ── 동적 필드 렌더링 ──
function renderTemplateUidFields() {
    const type = getSelectedType();
    const fields = TPL_FIELDS[type];
    const uids = TEMPLATE_UIDS[type];
    const container = document.getElementById('templateUidFields');
    container.innerHTML = '';
    fields.forEach(f => {
        const uidKey = f.id.replace('tpl', '');
        const key = uidKey.charAt(0).toLowerCase() + uidKey.slice(1);
        const div = document.createElement('div');
        div.className = 'form-group';
        div.innerHTML = `<label for="${f.id}">${f.label}</label><input type="text" id="${f.id}" value="${uids[key] || ''}" />`;
        container.appendChild(div);
    });
}

function renderCoverFields() {
    const type = getSelectedType();
    const fields = COVER_FIELDS[type];
    const container = document.getElementById('coverFields');
    container.innerHTML = '';
    fields.forEach(f => {
        const div = document.createElement('div');
        div.className = 'form-group';
        const input = document.createElement('input');
        input.type = 'text'; input.id = f.id; input.placeholder = f.placeholder; input.required = true;
        if (f.defaultValue) input.dataset.defaultValue = f.defaultValue;
        div.innerHTML = `<label for="${f.id}">${f.label}</label>`;
        div.appendChild(input);
        container.appendChild(div);
    });
}

// ── Tab 키로 빈 필드에 placeholder 자동완성 ──
document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
        const el = e.target;
        if (el.tagName === 'INPUT' && el.type === 'text' && !el.value.trim() && el.placeholder) {
            e.preventDefault();
            el.value = el.dataset.defaultValue || el.placeholder;
            // 다음 필드로 포커스 이동
            const inputs = Array.from(document.querySelectorAll('#bookOptions input[type="text"]:not([style*="display:none"])'));
            const idx = inputs.indexOf(el);
            if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
        }
    }
});

// ── 타입 변경 ──
document.querySelectorAll('input[name="photobookType"]').forEach(r => {
    r.addEventListener('change', () => {
        renderTemplateUidFields(); renderCoverFields();
        clearAllData();
        clearFormFields();
    });
});

// ── 로그 ──
function appendLog(msg, type = 'info') {
    logArea.style.display = 'block';
    const span = document.createElement('span');
    span.className = 'log-' + type;
    span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    logArea.appendChild(span);
    logArea.scrollTop = logArea.scrollHeight;
}

// ── 메시지 ──
function showMessage(message, type = 'info') {
    if (message) {
        messageText.textContent = message;
        messageArea.className = 'message-area ' + type;
        messageArea.style.display = 'block';
    } else {
        messageArea.style.display = 'none';
    }
}

// ── Google Auth ──
authorizeButton.addEventListener('click', handleAuthClick);
signoutButton.addEventListener('click', handleSignoutClick);

function handleAuthClick() {
    if (!pickerApiLoaded) { showMessage('Google API가 아직 로드되지 않았습니다.', 'error'); return; }
    const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.client_id,
        scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
        callback: (response) => {
            if (response.error) { showMessage('인증 오류: ' + response.error, 'error'); return; }
            accessToken = response.access_token;
            sessionStorage.setItem('google_access_token', accessToken);
            if (response.expires_in) {
                tokenExpiresAt = Date.now() + (response.expires_in * 1000);
                sessionStorage.setItem('token_expires_at', tokenExpiresAt);
            }
            updateSigninStatus(true); showMessage('');
        },
    });
    tokenClient.requestAccessToken();
}

function handleSignoutClick() {
    if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; tokenExpiresAt = null;
    clearAllData();
    sessionStorage.removeItem('google_access_token'); sessionStorage.removeItem('token_expires_at');
    updateSigninStatus(false);
}

function updateSigninStatus(isSignedIn) {
    const pickArea = document.getElementById('google-pick-area');
    if (isSignedIn) {
        authorizeButton.style.display = 'none'; signoutButton.style.display = '';
        pickArea.style.opacity = ''; pickArea.style.pointerEvents = ''; pickArea.style.cursor = 'pointer';
        pickArea.querySelector('.upload-hint').textContent = '클릭하여 사진 선택';
        displayTokenExpirationInfo(); startExpirationTimer();
    } else {
        authorizeButton.style.display = ''; signoutButton.style.display = 'none';
        pickArea.style.opacity = '0.5'; pickArea.style.pointerEvents = 'none'; pickArea.style.cursor = 'not-allowed';
        pickArea.querySelector('.upload-hint').textContent = '로그인 후 사용 가능';
        document.getElementById('token-expiration').textContent = '';
        stopExpirationTimer();
    }
}

function isTokenExpired() { return tokenExpiresAt ? Date.now() >= tokenExpiresAt : false; }
function getRemainingTokenTime() { if (!tokenExpiresAt) return null; const r = Math.floor((tokenExpiresAt - Date.now()) / 1000); return r > 0 ? r : 0; }

function displayTokenExpirationInfo() {
    if (!tokenExpiresAt) return;
    const remaining = getRemainingTokenTime();
    const el = document.getElementById('token-expiration');
    if (remaining === 0) {
        if (el) { el.textContent = '토큰 만료'; el.style.display = 'block'; }
        showMessage('토큰이 만료되었습니다. 다시 로그인해주세요.', 'error');
        stopExpirationTimer();
        setTimeout(() => handleSignoutClick(), 2000); return;
    }
    const m = Math.floor(remaining / 60), s = remaining % 60;
    if (el) { el.textContent = `토큰 만료까지: ${m}분 ${s}초`; el.style.display = 'block'; }
}

function startExpirationTimer() { stopExpirationTimer(); if (!tokenExpiresAt) return; expirationTimerInterval = setInterval(() => displayTokenExpirationInfo(), 1000); }
function stopExpirationTimer() { if (expirationTimerInterval) { clearInterval(expirationTimerInterval); expirationTimerInterval = null; } }

// ── Google Photos Picker ──
googlePickArea.addEventListener('click', showPhotoPicker);

async function showPhotoPicker() {
    if (!accessToken) { showMessage('먼저 Google 로그인을 해주세요.', 'error'); return; }
    if (isTokenExpired()) { showMessage('토큰이 만료되었습니다.', 'error'); handleSignoutClick(); return; }
    // 이전 데이터 초기화 (같은 소스 내 재선택)
    selectedPhotos.forEach(p => { if (p._isLocalFile && p.mediaFile?.baseUrl) URL.revokeObjectURL(p.mediaFile.baseUrl); });
    selectedPhotos = []; localPhotoFiles = [];
    photosGridGoogle.innerHTML = ''; photoCountGoogle.textContent = '';
    resultMessage.classList.remove('show'); logArea.style.display = 'none'; logArea.innerHTML = '';
    showMessage(''); showLoading(true, '구글 포토 여는 중...');
    try {
        const response = await fetch('/proxy/photospicker/v1/sessions', {
            method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        if (!response.ok) {
            const err = await response.json();
            if (err.error?.status === 'FAILED_PRECONDITION') { showMessage('Google Photos 계정이 설정되지 않았습니다.', 'error'); showLoading(false); return; }
            showMessage('사진 선택 중 오류: ' + (err.error?.message || ''), 'error'); showLoading(false); return;
        }
        const data = await response.json();
        if (data.pickerUri) {
            sessionStorage.setItem('picker_session_id', data.id);
            window.open(data.pickerUri + '/autoclose', 'photoPicker', 'width=1000,height=800');
            showLoading(false); startSessionPolling(data.id);
        }
    } catch (error) { showMessage('사진 선택 중 오류: ' + error.message, 'error'); showLoading(false); }
}

function startSessionPolling(sessionId) {
    showLoading(false); showMessage(''); let pollCount = 0;
    const pollInterval = setInterval(async () => {
        pollCount++;
        try {
            const response = await fetch(`/proxy/photospicker/v1/sessions/${sessionId}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!response.ok) { if (response.status === 401) { clearInterval(pollInterval); showMessage('인증이 만료되었습니다.', 'error'); } return; }
            const sessionData = await response.json();
            if (sessionData.mediaItemsSet === true) {
                clearInterval(pollInterval);
                showLoading(true, '선택한 사진 불러오는 중...');
                if (sessionData.mediaItems?.length > 0) {
                    addPhotosToSelection(sessionData.mediaItems); displayPhotos(selectedPhotos, photosGridGoogle);
                    photoCountGoogle.textContent = `총 ${selectedPhotos.length}개의 사진 선택됨`; showLoading(false);
                    showBookOptions();
                } else { await loadSelectedPhotos(sessionId); }
            }
        } catch (error) { console.error('Polling error:', error); }
        if (pollCount >= 150) { clearInterval(pollInterval); showLoading(false); showMessage('시간이 초과되었습니다.', 'error'); }
    }, 2000);
}

async function loadSelectedPhotos(sessionId) {
    try {
        let allPhotos = [], nextPageToken = null;
        do {
            const params = new URLSearchParams({ sessionId });
            if (nextPageToken) params.set('pageToken', nextPageToken);
            const url = `/proxy/photospicker/v1/mediaItems?${params}`;
            const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            if (!response.ok) throw new Error('Failed to load photos');
            const data = await response.json();
            if (data.mediaItems?.length > 0) allPhotos = allPhotos.concat(data.mediaItems);
            nextPageToken = data.nextPageToken || null;
        } while (nextPageToken);
        if (allPhotos.length > 0) {
            addPhotosToSelection(allPhotos); displayPhotos(selectedPhotos, photosGridGoogle);
            photoCountGoogle.textContent = `총 ${selectedPhotos.length}개의 사진 선택됨`;
            showBookOptions();
        } else showMessage('선택된 사진이 없습니다.', 'error');
    } catch (error) { showMessage('사진을 불러오는 중 오류: ' + error.message, 'error'); }
    finally { showLoading(false); }
}

function addPhotosToSelection(newPhotos) {
    const videoExtensions = ['.mp4', '.mov', '.avi', '.wmv', '.flv', '.mkv', '.webm', '.m4v'];
    const newUniquePhotos = newPhotos.filter(np => {
        const mt = np.mediaFile?.mimeType || '', tp = np.type || '', fn = np.mediaFile?.filename || '';
        if (mt.startsWith('video/') || tp.toLowerCase() === 'video' || videoExtensions.some(ext => fn.toLowerCase().endsWith(ext))) return false;
        return !selectedPhotos.some(ex => (ex.id && np.id && ex.id === np.id) || (ex.mediaFile?.baseUrl && np.mediaFile?.baseUrl && ex.mediaFile.baseUrl === np.mediaFile.baseUrl));
    });
    selectedPhotos = [...selectedPhotos, ...newUniquePhotos];
}

async function handlePickerCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');
    if (sessionId) {
        accessToken = sessionStorage.getItem('google_access_token');
        const se = sessionStorage.getItem('token_expires_at'); if (se) tokenExpiresAt = parseInt(se);
        if (!accessToken) { showMessage('세션이 만료되었습니다.', 'error'); return; }
        updateSigninStatus(true); showLoading(true, '선택한 사진 불러오는 중...');
        switchSource('google');
        await loadSelectedPhotos(sessionId);
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function displayPhotos(photoList, grid) {
    grid.innerHTML = '';
    if (photoList.length === 0) { grid.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">선택된 사진이 없습니다.</p>'; return; }
    photoList.forEach((photo) => {
        const card = document.createElement('div'); card.className = 'photo-card';
        const removeBtn = document.createElement('button'); removeBtn.className = 'remove-photo'; removeBtn.innerHTML = '&times;';
        removeBtn.addEventListener('click', e => { e.stopPropagation(); removePhoto(photo); }); card.appendChild(removeBtn);
        const img = document.createElement('img');
        let imageUrl = photo.mediaFile?.baseUrl, filename = photo.mediaFile?.filename || 'Untitled', creationTime = photo.createTime;
        if (imageUrl) {
            if (photo._isLocalFile) {
                img.src = imageUrl;
            } else {
                // Google Photos는 Authorization 필요 → 이미지 프록시 사용
                img.src = `/proxy/image?url=${encodeURIComponent(imageUrl + '=w400-h400')}&token=${encodeURIComponent(accessToken || '')}`;
            }
            img.alt = filename; img.loading = 'lazy';
        } else { img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="400"%3E%3Crect fill="%23ddd" width="400" height="400"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" fill="%23999"%3ENo Image%3C/text%3E%3C/svg%3E'; }
        const info = document.createElement('div'); info.className = 'photo-info';
        const fnDiv = document.createElement('div'); fnDiv.className = 'photo-filename'; fnDiv.textContent = filename; fnDiv.title = filename;
        info.appendChild(fnDiv);
        if (creationTime) { const dtDiv = document.createElement('div'); dtDiv.className = 'photo-date'; dtDiv.textContent = new Date(creationTime).toLocaleDateString('ko-KR'); info.appendChild(dtDiv); }
        card.appendChild(img); card.appendChild(info); grid.appendChild(card);
    });
}

function removePhoto(photo) {
    const pid = photo.id || photo.mediaFile?.baseUrl;
    selectedPhotos = selectedPhotos.filter(p => (p.id || p.mediaFile?.baseUrl) !== pid);
    const grid = getActivePhotosGrid();
    const countEl = getActivePhotoCount();
    displayPhotos(selectedPhotos, grid);
    countEl.textContent = selectedPhotos.length > 0 ? `총 ${selectedPhotos.length}개의 사진 선택됨` : '';
}

// ── 로컬 사진 업로드 ──
let localPhotoFiles = []; // {file, date, source}

const localDropArea = document.getElementById('local-drop-area');
localDropArea.addEventListener('click', () => localPhotoInput.click());
localDropArea.addEventListener('dragover', (e) => { e.preventDefault(); localDropArea.classList.add('dragover'); });
localDropArea.addEventListener('dragleave', () => { localDropArea.classList.remove('dragover'); });
localDropArea.addEventListener('drop', async (e) => {
    e.preventDefault(); localDropArea.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f =>
        f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)
    );
    if (files.length === 0) { showMessage('이미지 파일만 업로드할 수 있습니다.', 'error'); return; }
    await handleLocalPhotos(files);
});
localPhotoInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    localPhotoInput.value = '';
    await handleLocalPhotos(files);
});

async function handleLocalPhotos(files) {
    // 이전 데이터 초기화
    selectedPhotos.forEach(p => { if (p._isLocalFile && p.mediaFile?.baseUrl) URL.revokeObjectURL(p.mediaFile.baseUrl); });
    selectedPhotos = []; localPhotoFiles = [];
    photosGridLocal.innerHTML = ''; photoCountLocal.textContent = '';
    dateWarning.style.display = 'none';
    resultMessage.classList.remove('show'); logArea.style.display = 'none'; logArea.innerHTML = '';

    showMessage('사진 날짜를 분석하는 중...', 'info');

    const photoData = [];
    for (let i = 0; i < files.length; i++) {
        showMessage(`사진 날짜 분석 중... (${i + 1}/${files.length})`, 'info');
        const { date, source } = await extractPhotoDate(files[i]);
        photoData.push({ file: files[i], date, source });
    }

    localPhotoFiles = photoData;
    const noDatePhotos = photoData.filter(p => !p.date);

    if (noDatePhotos.length > 0) {
        showDateWarning(photoData);
        showMessage(`${noDatePhotos.length}장의 사진에서 날짜를 찾을 수 없습니다. 아래에서 날짜를 지정해주세요.`, 'error');
    } else {
        dateWarning.style.display = 'none';
        finishLocalPhotoLoad(photoData);
    }
}

function showDateWarning(photoData) {
    dateWarning.style.display = 'block';
    dateEditList.innerHTML = '';

    const knownDates = photoData.filter(p => p.date).map(p => p.date);
    const defaultDate = knownDates.length > 0 ? knownDates[0] : new Date().toISOString().split('T')[0];

    photoData.forEach((p, idx) => {
        if (p.date) return;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:6px; padding:6px; background:white; border-radius:4px;';
        row.innerHTML = `
            <span style="flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${p.file.name}">${p.file.name}</span>
            <span style="font-size:11px; color:#999;">${(p.file.size / 1024).toFixed(0)}KB</span>
            <input type="date" data-photo-idx="${idx}" value="${defaultDate}" style="padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;" />
        `;
        dateEditList.appendChild(row);
    });
}

applyDatesBtn.addEventListener('click', () => {
    const inputs = dateEditList.querySelectorAll('input[type="date"]');
    let allFilled = true;
    inputs.forEach(input => {
        const idx = parseInt(input.dataset.photoIdx);
        const val = input.value;
        if (!val) { allFilled = false; return; }
        localPhotoFiles[idx].date = val;
        localPhotoFiles[idx].source = 'manual';
    });
    if (!allFilled) { alert('모든 사진에 날짜를 입력해주세요.'); return; }
    dateWarning.style.display = 'none';
    finishLocalPhotoLoad(localPhotoFiles);
});

function finishLocalPhotoLoad(photoData) {
    selectedPhotos = photoData.map((p, i) => ({
        id: `local-${i}`,
        createTime: p.date + 'T00:00:00Z',
        _isLocalFile: true,
        _file: p.file,
        _dateSource: p.source,
        mediaFile: {
            baseUrl: URL.createObjectURL(p.file),
            filename: p.file.name,
            mediaFileMetadata: {},
        },
    }));

    localDropArea.style.display = 'none';
    localPhotoInfo.style.display = '';
    displayPhotos(selectedPhotos, photosGridLocal);
    const exifCount = photoData.filter(p => p.source === 'exif').length;
    const fnCount = photoData.filter(p => p.source === 'filename').length;
    const manualCount = photoData.filter(p => p.source === 'manual').length;
    const parts = [];
    if (exifCount > 0) parts.push(`EXIF: ${exifCount}장`);
    if (fnCount > 0) parts.push(`파일명: ${fnCount}장`);
    if (manualCount > 0) parts.push(`수동: ${manualCount}장`);
    photoCountLocal.textContent = `총 ${selectedPhotos.length}개의 로컬 사진 (${parts.join(', ')})`;
    showMessage(`${selectedPhotos.length}장의 사진을 불러왔습니다.`, 'success');
    showBookOptions();
}

// ── 구글포토북 데이터 JSON 업로드 (타입별 JSON) ──
uploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleDataFile(f); });
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('dragover'); });
uploadArea.addEventListener('drop', e => {
    e.preventDefault(); uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.json')) handleDataFile(f); else alert('JSON 파일만 업로드 가능합니다.');
});

function validateJsonForType(data, type) {
    if (!data.entries || !Array.isArray(data.entries) || data.entries.length === 0)
        return '"entries" 배열이 필요합니다';
    if (!data.cover || typeof data.cover !== 'object')
        return '"cover" 객체가 필요합니다';
    if (!data.ganji || typeof data.ganji !== 'object')
        return '"ganji" 객체가 필요합니다';
    if (!data.publish || typeof data.publish !== 'object')
        return '"publish" 객체가 필요합니다';

    const entries = data.entries;
    const entryTypes = new Set(entries.map(e => e.type).filter(Boolean));

    if (type === 'A') {
        if (!entryTypes.has('dateA'))
            return '구글포토북A JSON에는 type:"dateA" 항목이 필요합니다.\n현재 타입: ' + [...entryTypes].join(', ');
        if (!data.ganji.startYear || !data.ganji.startMonth)
            return '구글포토북A의 ganji에 startYear, startMonth가 필요합니다';
    } else if (type === 'B') {
        const hasDateField = entries.some(e => e.date && e.photos);
        if (!hasDateField)
            return '구글포토북B JSON에는 date + photos 항목이 필요합니다';
        if (!data.ganji.dateRangeDetail)
            return '구글포토북B의 ganji에 dateRangeDetail이 필요합니다';
    } else if (type === 'C') {
        if (!entryTypes.has('month') && !entryTypes.has('photo'))
            return '구글포토북C JSON에는 type:"month"과 type:"photo" 항목이 필요합니다.\n현재 타입: ' + [...entryTypes].join(', ');
        if (!data.ganji.startYear || !data.ganji.startMonth)
            return '구글포토북C의 ganji에 startYear, startMonth가 필요합니다';
    }
    return null; // 통과
}

function handleDataFile(file) {
    fileNameEl.textContent = `📄 ${file.name}`;
    fileSizeEl.textContent = `크기: ${(file.size / 1024).toFixed(2)} KB`;
    fileInfo.classList.add('show');
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            const type = getSelectedType();
            const error = validateJsonForType(data, type);
            if (error) {
                alert(`구글포토북${type} JSON 검증 실패:\n\n${error}`);
                fileInfo.classList.remove('show');
                fileInput.value = '';
                dataPreview.classList.remove('show');
                return;
            }
            parseBookData(data);
        } catch (err) { alert('JSON 오류: ' + err.message); }
    };
    reader.readAsText(file);
}

function parseBookData(data) {
    // 이전 데이터 초기화
    selectedPhotos = []; localPhotoFiles = [];
    resultMessage.classList.remove('show'); logArea.style.display = 'none'; logArea.innerHTML = '';

    dataItems = [data]; // 전체 데이터 객체 저장
    dataItemsContainer.innerHTML = '';
    const entries = data.entries;

    // 미리보기 표시
    entries.forEach(entry => {
        const d = document.createElement('div'); d.className = 'data-item';
        let h = '';
        if (entry.type === 'dateA') h = `<div class="item-date">dateA: ${entry.month_year} - ${entry.day}</div><div class="item-text">사진 ${entry.photos.length}장</div>`;
        else if (entry.type === 'dateB') h = `<div class="item-date">dateB: ${entry.day}</div><div class="item-text">사진 ${entry.photos.length}장</div>`;
        else if (entry.type === 'month') h = `<div class="item-date">월 헤더: ${entry.label}</div>`;
        else if (entry.type === 'photo') h = `<div class="item-date">사진: ${entry.day.replace('\n', '/')}</div>`;
        else h = `<div class="item-date">${entry.date || entry.type || 'entry'}</div><div class="item-text">사진 ${(entry.photos || []).length}장</div>`;
        d.innerHTML = h;
        dataItemsContainer.appendChild(d);
    });
    itemCount.textContent = `${entries.length}개 항목`;
    dataPreview.classList.add('show');

    // 커버/간지/발행 필드 자동 채우기 (이전 값 덮어쓰기)
    const fill = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    if (data.cover) {
        fill('coverSubtitle', data.cover.subtitle);
        fill('coverDateRange', data.cover.dateRange);
    }
    if (data.publish) {
        fill('publishTitle', data.publish.title);
        fill('publishDate', data.publish.publishDate);
        fill('publishAuthor', data.publish.author);
        fill('publishHashtags', data.publish.hashtags);
        fill('publishPublisher', data.publish.publisher);
    }
    if (data.title) fill('bookTitle', data.title);

    showBookOptions();
}

function showBookOptions() {
    bookOptions.classList.add('show');
    createBookBtn.disabled = false;
}

// ── 유틸리티 ──
function showLoading(show, text = '처리 중...') {
    if (show) { loadingText.textContent = text; loadingEl.classList.add('show'); }
    else { loadingEl.classList.remove('show'); }
}

// ── 책 생성 ──
async function createPhotoBook() {
    const bookTitle = document.getElementById('bookTitle').value.trim();
    const apiEnv = getSelectedEnv();
    const type = getSelectedType();
    if (!bookTitle) { alert('책 제목을 입력하세요.'); document.getElementById('bookTitle').focus(); return; }

    // 필수 필드 검증
    const requiredFields = [
        { id: 'coverSubtitle', name: '표지 서브타이틀' }, { id: 'coverDateRange', name: '기간' },
        { id: 'publishTitle', name: '발행 제목' }, { id: 'publishDate', name: '발행일' },
        { id: 'publishAuthor', name: '저자' }, { id: 'publishHashtags', name: '해시태그' },
        { id: 'publishPublisher', name: '발행처' },
    ];
    for (const f of requiredFields) {
        const el = document.getElementById(f.id);
        if (el && !el.value.trim()) { alert(`${f.name}을(를) 입력하세요. (Tab 키로 기본값 자동완성 가능)`); el.focus(); return; }
    }

    if (!getClient()) return;

    const tplUids = {};
    const fields = TPL_FIELDS[type];
    for (const f of fields) {
        const el = document.getElementById(f.id);
        if (el && el.value.trim()) tplUids[f.id] = el.value.trim();
    }

    // 필수 템플릿 확인
    const requiredKeys = fields.filter(f => f.id !== 'tplBlank').map(f => f.id);
    for (const k of requiredKeys) {
        if (!tplUids[k]) { alert(`${fields.find(f => f.id === k).label} 템플릿 UID를 입력하세요.`); return; }
    }

    // 데이터 소스 확인 (활성 소스 기반)
    const hasJsonData = activeSource === 'json' && dataItems.length > 0 && dataItems[0].entries;
    const hasPhotos = (activeSource === 'google' || activeSource === 'local') && selectedPhotos.length > 0;

    if (!hasJsonData && !hasPhotos) {
        alert('사진 또는 데이터 JSON을 먼저 업로드하세요.'); return;
    }

    _paused = false;
    _saved = null;
    setButtons('running');
    loadingEl.classList.add('show'); resultMessage.classList.remove('show');
    logArea.innerHTML = ''; logArea.style.display = 'block';
    const startTime = Date.now();

    try {
        appendLog(`구글포토북${type} 책 생성 시작...`, 'info');
        appendLog(`API: ${getBaseUrl()}`, 'info');
        const createResult = await client.books.create({ title: bookTitle, bookSpecUid: 'SQUAREBOOK_HC', creationType: apiEnv === 'live' ? 'LIVE' : 'TEST' });
        const bookUid = createResult.bookUid || createResult.uid;
        appendLog(`책 생성 완료: ${bookUid}`, 'success');

        let result;
        if (hasJsonData) {
            result = await createBookFromJson(bookUid, type, tplUids, dataItems[0]);
        } else {
            result = await createBookFromPhotos(bookUid, type, tplUids);
        }

        // 일시중지/에러 중단 처리
        if (result?.paused) {
            _saved = { bookUid, type, tplUids, data: hasJsonData ? dataItems[0] : null, hasPhotos,
                       startIndex: result.startIndex, resumeState: result, startTime };
            const phase = result.phase === 'upload' ? '업로드' : '내지 생성';
            const idx = result.phase === 'upload' ? result.uploadIndex : (result.contentIndex ?? result.startIndex);
            appendLog(`일시중지 — ${phase} (${idx}번째)`, 'info');
            loadingEl.classList.remove('show');
            setButtons(result.failCount > 0 ? 'stopped' : 'paused');
            return;
        }

        // 빈내지 삽입 (pageSide 체크 — 발행면이 left에 오도록)
        let lastResult = result?.lastResult;
        const lastSide = lastResult?.pageSide || 'right';
        if (lastSide === 'left' && tplUids.tplBlank) {
            appendLog('빈내지 삽입 (발행면 위치 조정)...', 'info');
            lastResult = await sdkPostContent(client, bookUid, tplUids.tplBlank, {}, 'page');
            appendLog('빈내지 삽입 완료', 'success');
        }

        // 발행면 — 페이지 부족 시 보류
        const prePublishPages = lastResult?.pageCount || 0;
        let totalPages = prePublishPages;
        let publishDeferred = false;
        const publishParams = {
            photo: result.coverPhoto || '',
            title: document.getElementById('publishTitle').value.trim() || bookTitle,
            publishDate: document.getElementById('publishDate').value.trim() || '',
            author: document.getElementById('publishAuthor').value.trim() || '',
            hashtags: document.getElementById('publishHashtags').value.trim() || '',
            publisher: document.getElementById('publishPublisher')?.value.trim() || '',
        };

        if (prePublishPages >= MIN_PAGES_FOR_PUBLISH) {
            loadingText.textContent = '발행면 생성 중...';
            appendLog('발행면 생성 중...', 'info');
            const publishResult = await sdkPostContent(client, bookUid, tplUids.tplPublish, publishParams, 'page');
            appendLog('발행면 완료', 'success');
            totalPages = publishResult?.pageCount || 0;
        } else {
            publishDeferred = true;
            appendLog(`현재 ${prePublishPages}페이지 — 페이지 부족으로 발행면 삽입을 보류합니다.`, 'info');
        }

        const tt = Date.now() - startTime;
        appendLog(`책 생성 완료! bookUid: ${bookUid}, 총 ${totalPages}페이지, 소요시간: ${(tt / 1000).toFixed(2)}초`, 'success');
        loadingEl.classList.remove('show');
        resultMessage.innerHTML = `✓ 구글포토북${type} 책이 생성되었습니다! (최종화 전)<br><small>bookUid: ${bookUid}</small><br><small>총 ${totalPages}페이지 | 성공: ${result.successCount}개 | 실패: ${result.failCount}개</small><br><small>생성 시간: ${(tt / 1000).toFixed(2)}초</small>`;
        resultMessage.className = 'result-message success show';

        // 빈내지 추가 / 발행면 추가 / 제작 버튼
        const finalizeBtn = document.getElementById('finalizeBtn');
        const addBlankBtn = document.getElementById('addBlankBtn');
        const addPublishBtn = document.getElementById('addPublishBtn');
        finalizeBtn.dataset.bookUid = bookUid;
        addBlankBtn.dataset.bookUid = bookUid;
        addBlankBtn.dataset.pageCount = totalPages;
        addBlankBtn.dataset.tplBlank = tplUids.tplBlank || '';
        addPublishBtn.dataset.bookUid = bookUid;
        addPublishBtn.dataset.tplPublish = tplUids.tplPublish || '';
        addPublishBtn.dataset.publishParams = JSON.stringify(publishParams);
        addPublishBtn.dataset.published = publishDeferred ? '' : 'true';
        if (totalPages < MIN_PAGES_FOR_FINALIZE && tplUids.tplBlank) {
            addBlankBtn.disabled = false;
            addBlankBtn.style.display = 'inline-block';
            appendLog(`현재 ${totalPages}페이지 — 24페이지 이상이어야 제작 가능합니다. 빈내지를 추가하세요.`, 'info');
        }
        // 발행면 보류 상태에서 짝수 + 22이상이면 바로 발행면 버튼 표시
        if (publishDeferred && totalPages >= 22 && totalPages % 2 === 0) {
            addPublishBtn.disabled = false;
            addPublishBtn.style.display = 'inline-block';
        }
        finalizeBtn.disabled = totalPages < MIN_PAGES_FOR_FINALIZE;
        finalizeBtn.style.display = 'inline-block';
        _saved = null;
        setButtons('done');
    } catch (error) {
        const detail = error.details ? ` | ${JSON.stringify(error.details)}` : '';
        appendLog(`오류: ${error.message}${detail}`, 'error');
        loadingEl.classList.remove('show');
        resultMessage.textContent = '✗ 책 생성 중 오류: ' + error.message;
        resultMessage.className = 'result-message error show';
        setButtons('idle');
    }
}

// ── JSON 데이터 기반 생성 (Python _book.py와 동일 흐름) ──
async function createBookFromJson(bookUid, type, tplUids, data, startIndex = 0, resumeState = null) {
    let successCount = resumeState?.successCount || 0;
    let failCount = resumeState?.failCount || 0;
    let lastResult = resumeState?.lastResult || null;
    const coverPhoto = data.cover?.coverPhoto || '';

    if (startIndex === 0) {
        // 표지
        loadingText.textContent = '표지 생성 중...';
        appendLog('표지 생성 중...', 'info');
        let coverParams;
        if (type === 'A') coverParams = coverParamsA(data.cover);
        else if (type === 'B') coverParams = coverParamsB(data.cover);
        else coverParams = coverParamsC(data.cover);
        await client.covers.create(bookUid, tplUids.tplCover, stripEmptyImages(coverParams));
        appendLog('표지 생성 완료', 'success');

        // 간지
        loadingText.textContent = '간지 생성 중...';
        appendLog('간지 생성 중...', 'info');
        let ganjiParams;
        if (type === 'A') ganjiParams = ganjiParamsA(data.ganji);
        else if (type === 'B') {
            const totalPhotos = data.entries.reduce((sum, e) => sum + (e.photos ? e.photos.length : 0), 0);
            ganjiParams = ganjiParamsB(String(totalPhotos), data.ganji.dateRangeDetail);
        } else {
            const totalPhotos = data.entries.filter(e => e.type === 'photo').length;
            ganjiParams = ganjiParamsC(data.ganji, String(totalPhotos));
        }
        lastResult = await sdkPostContent(client, bookUid, tplUids.tplGanji, ganjiParams, 'page');
        appendLog('간지 생성 완료', 'success');
    }

    // 내지 시퀀스
    const entries = data.entries;

    // 페이지 수 예상 (130페이지 제한 체크)
    const MAX_PAGES = MAX_BOOK_PAGES;
    const estPages = 4 + entries.length; // 표지 2 + 발행면 2 + 간지 1 (이미 생성됨) 포함
    appendLog(`예상 페이지 수: ${estPages}페이지 (최대 ${MAX_PAGES})`, estPages > MAX_PAGES ? 'error' : 'info');
    if (estPages > MAX_PAGES) {
        const over = estPages - MAX_PAGES;
        throw new Error(`예상 페이지(${estPages})가 최대 ${MAX_PAGES}페이지를 초과합니다. ${over}페이지를 줄여주세요.`);
    }

    let first = startIndex === 0;
    let prevDay = null;
    // first 플래그: startIndex > 0이면 이미 첫 entry는 지남
    if (startIndex > 0) {
        first = false;
        // prevDay 복원 (C타입)
        for (let j = 0; j < startIndex; j++) {
            if (entries[j].type === 'month') prevDay = null;
            else if (entries[j].type === 'photo') prevDay = entries[j].day;
        }
    }

    for (let i = startIndex; i < entries.length; i++) {
        if (_paused) {
            return { paused: true, startIndex: i, lastResult, successCount, failCount, coverPhoto };
        }
        const entry = entries[i];
        try {
            if (type === 'A') {
                if (entry.type === 'dateA') {
                    const bb = first ? (entry.break_before || 'page') : 'none';
                    first = false;
                    const params = dateAParams(entry.month_year, entry.day, entry.photos);
                    loadingText.textContent = `dateA: ${entry.month_year} - ${entry.day} (${i + 1}/${entries.length})`;
                    appendLog(`dateA: ${entry.month_year} - ${entry.day} (${entry.photos.length}photos, bb=${bb})`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplDateA, params, bb);
                    successCount++;
                } else if (entry.type === 'dateB') {
                    const params = dateBParams(entry.day, entry.photos);
                    loadingText.textContent = `dateB: ${entry.day} (${i + 1}/${entries.length})`;
                    appendLog(`dateB: ${entry.day} (${entry.photos.length}photos)`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplDateB, params, 'none');
                    successCount++;
                }
            } else if (type === 'B') {
                const bb = first ? (entry.break_before || 'page') : 'none';
                first = false;
                const params = naejiParamsB(entry.date, entry.photos);
                loadingText.textContent = `내지: ${entry.date} (${i + 1}/${entries.length})`;
                appendLog(`내지: ${entry.date} (${entry.photos.length}photos, bb=${bb})`, 'info');
                lastResult = await sdkPostContent(client, bookUid, tplUids.tplNaeji, params, bb);
                successCount++;
            } else if (type === 'C') {
                if (entry.type === 'month') {
                    const bb = first ? (entry.break_before || 'page') : 'none';
                    first = false;
                    prevDay = null;
                    const params = monthHeaderParamsC(entry.label);
                    loadingText.textContent = `monthHeader: ${entry.label} (${i + 1}/${entries.length})`;
                    appendLog(`monthHeader: ${entry.label} (bb=${bb})`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplMonthHeader, params, bb);
                    successCount++;
                } else if (entry.type === 'photo') {
                    const showLabel = entry.day !== prevDay;
                    prevDay = entry.day;
                    const params = photoParamsC(entry.day, entry.url, showLabel);
                    loadingText.textContent = `photo: ${entry.day.replace('\n', '/')} (${i + 1}/${entries.length})`;
                    appendLog(`photo: day=${entry.day.replace('\n', '/')} hasDayLabel=${showLabel}`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplPhoto, params, 'none');
                    successCount++;
                }
            }
        } catch (err) {
            const detail = err.details ? ` | ${JSON.stringify(err.details)}` : '';
            appendLog(`${entry.type || 'entry'} 오류: ${err.message}${detail}`, 'error');
            failCount++;
            return { paused: true, startIndex: i, lastResult, successCount, failCount, coverPhoto };
        }
    }

    return { lastResult, successCount, failCount, coverPhoto };
}

// ── Google Photos / 로컬 사진 기반 생성 ──
async function createBookFromPhotos(bookUid, type, tplUids, resumeCtx = null) {
    let successCount = resumeCtx?.successCount || 0;
    let failCount = resumeCtx?.failCount || 0;
    let lastResult = resumeCtx?.lastResult || null;
    const phase = resumeCtx?.phase || 'upload';  // 'upload' | 'content'
    const photoUrlMap = resumeCtx?.photoUrlMap || {};
    let coverPhotoUrl = resumeCtx?.coverPhoto || '';

    // ── 사진 업로드 단계 ──
    if (phase === 'upload') {
        const uploadStart = resumeCtx?.uploadIndex || 0;
        if (uploadStart === 0) appendLog(`사진 ${selectedPhotos.length}장 서버 업로드 시작...`, 'info');
        for (let i = uploadStart; i < selectedPhotos.length; i++) {
            if (_paused) {
                return { paused: true, phase: 'upload', uploadIndex: i, photoUrlMap,
                         lastResult, successCount, failCount, coverPhoto: coverPhotoUrl };
            }
            const photo = selectedPhotos[i];
            loadingText.textContent = `사진 업로드 중... (${i + 1}/${selectedPhotos.length})`;
            try {
                let file;
                if (photo._isLocalFile) {
                    file = photo._file;
                    if (!file.type && /\.heic$/i.test(file.name)) {
                        file = new File([file], file.name, { type: 'image/heic' });
                    } else if (!file.type && /\.heif$/i.test(file.name)) {
                        file = new File([file], file.name, { type: 'image/heif' });
                    }
                } else {
                    const imageUrl = photo.mediaFile.baseUrl + '=d';
                    const proxyUrl = `/proxy/image?url=${encodeURIComponent(imageUrl)}&token=${encodeURIComponent(accessToken || '')}`;
                    const resp = await fetch(proxyUrl);
                    if (!resp.ok) throw new Error(`이미지 다운로드 실패: ${resp.status}`);
                    const blob = await resp.blob();
                    let filename = photo.mediaFile.filename || `photo_${i}.jpg`;
                    let mimeType = blob.type || '';
                    const ext = filename.split('.').pop()?.toLowerCase();
                    if ((ext === 'heic' || ext === 'heif') && mimeType.startsWith('image/jpeg')) {
                        filename = filename.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
                    } else if (!mimeType) {
                        mimeType = ext === 'heic' ? 'image/heic' : ext === 'heif' ? 'image/heif' : 'image/jpeg';
                    }
                    file = new File([blob], filename, { type: mimeType });
                }
                const result = await client.photos.upload(bookUid, file);
                if (i === 0) console.log('photos.upload 응답:', JSON.stringify(result));
                let serverFileName = '';
                if (Array.isArray(result) && result.length > 0) {
                    serverFileName = result[0].fileName || result[0].file_name || '';
                } else if (result && typeof result === 'object') {
                    serverFileName = result.fileName || result.file_name || '';
                }
                photoUrlMap[photo.id] = serverFileName;
                const name = photo._isLocalFile ? photo._file.name : (photo.mediaFile.filename || photo.id);
                appendLog(`업로드 완료: ${name} → ${serverFileName || '(응답: ' + JSON.stringify(result).substring(0, 100) + ')'}`, 'success');
            } catch (err) {
                const name = photo._isLocalFile ? photo._file.name : (photo.mediaFile.filename || photo.id);
                appendLog(`업로드 실패: ${name} - ${err.message}`, 'error');
                failCount++;
                return { paused: true, phase: 'upload', uploadIndex: i, photoUrlMap,
                         lastResult, successCount, failCount, coverPhoto: coverPhotoUrl };
            }
        }
        appendLog(`사진 업로드 완료 (${Object.keys(photoUrlMap).length}/${selectedPhotos.length}장)`, 'info');
    }

    function resolvePhotoUrl(photo) {
        return photoUrlMap[photo.id] || '';
    }

    // ── 표지/간지 (content 단계 첫 진입 시에만) ──
    const contentStart = resumeCtx?.contentIndex || 0;
    if (contentStart === 0 && phase !== 'content') {
        coverPhotoUrl = resolvePhotoUrl(selectedPhotos[0] || {});
        loadingText.textContent = '표지 생성 중...';
        appendLog('표지 생성 중...', 'info');
        const coverSubtitle = document.getElementById('coverSubtitle')?.value.trim() || '';
        const coverDateRange = document.getElementById('coverDateRange')?.value.trim() || '';
        const coverParams = { subtitle: coverSubtitle, dateRange: coverDateRange, coverPhoto: coverPhotoUrl };
        await client.covers.create(bookUid, tplUids.tplCover, stripEmptyImages(coverParams));
        appendLog('표지 생성 완료', 'success');

        loadingText.textContent = '간지 생성 중...';
        appendLog('간지 생성 중...', 'info');
        const dates = selectedPhotos.filter(p => p.createTime).map(p => new Date(p.createTime)).sort((a, b) => a - b);
        const startDate = dates[0] || new Date();
        const endDate = dates[dates.length - 1] || new Date();
        const ganjiData = {
            startYear: startDate.getFullYear(), startMonth: startDate.getMonth() + 1,
            endYear: endDate.getFullYear(), endMonth: endDate.getMonth() + 1,
            dateRangeDetail: `${startDate.toISOString().slice(0, 10).replace(/-/g, '.')} - ${endDate.toISOString().slice(0, 10).replace(/-/g, '.')}`,
            photoCount: `${selectedPhotos.length}장`,
        };
        let ganjiParams;
        if (type === 'A') ganjiParams = ganjiParamsA(ganjiData);
        else if (type === 'B') ganjiParams = ganjiParamsB(String(selectedPhotos.length), ganjiData.dateRangeDetail);
        else ganjiParams = ganjiParamsC(ganjiData, String(selectedPhotos.length));
        lastResult = await sdkPostContent(client, bookUid, tplUids.tplGanji, ganjiParams, 'page');
        appendLog('간지 생성 완료', 'success');
    }

    // ── 내지 — 날짜별 그룹화 후 타입별 처리 ──
    const photosByDate = {};
    selectedPhotos.forEach(p => {
        let dk = new Date().toISOString().split('T')[0];
        if (p.createTime) try { dk = new Date(p.createTime).toISOString().split('T')[0]; } catch (e) {}
        if (!photosByDate[dk]) photosByDate[dk] = [];
        photosByDate[dk].push(p);
    });
    const sortedDates = Object.keys(photosByDate).sort();

    // 상태 복원 함수
    function makeContentReturn(dateIdx) {
        return { paused: true, phase: 'content', contentIndex: dateIdx, photoUrlMap,
                 lastResult, successCount, failCount, coverPhoto: coverPhotoUrl };
    }

    if (type === 'A') {
        let firstNaeji = contentStart === 0;
        let prevMonthYear = '';
        // 상태 복원: contentStart 이전 entries를 스캔하여 prevMonthYear 복원
        for (let j = 0; j < contentStart; j++) {
            const d = new Date(sortedDates[j]);
            prevMonthYear = `${MONTH_EN[d.getMonth() + 1]} ${d.getFullYear()}`;
        }
        for (let di = contentStart; di < sortedDates.length; di++) {
            if (_paused) return makeContentReturn(di);
            const date = sortedDates[di];
            const photos = photosByDate[date];
            const d = new Date(date);
            const month = d.getMonth() + 1, day = d.getDate(), year = d.getFullYear();
            const monthYear = `${MONTH_EN[month]} ${year}`;
            const dayLabel = `${month}/${day}`;
            const photoUrls = photos.map(p => resolvePhotoUrl(p)).filter(u => u);

            if (monthYear !== prevMonthYear) {
                prevMonthYear = monthYear;
                const bb = firstNaeji ? 'page' : 'none';
                firstNaeji = false;
                try {
                    const params = dateAParams(monthYear, dayLabel, photoUrls);
                    appendLog(`dateA: ${monthYear} - ${dayLabel} (${photoUrls.length}photos)`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplDateA, params, bb);
                    successCount++;
                } catch (err) {
                    appendLog(`dateA 오류: ${err.message}${err.details ? ' | ' + JSON.stringify(err.details) : ''}`, 'error');
                    failCount++;
                    return makeContentReturn(di);
                }
            } else {
                try {
                    const params = dateBParams(dayLabel, photoUrls);
                    appendLog(`dateB: ${dayLabel} (${photoUrls.length}photos)`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplDateB, params, 'none');
                    successCount++;
                } catch (err) {
                    appendLog(`dateB 오류: ${err.message}`, 'error');
                    failCount++;
                    return makeContentReturn(di);
                }
            }
        }
    } else if (type === 'B') {
        let first = contentStart === 0;
        for (let di = contentStart; di < sortedDates.length; di++) {
            if (_paused) return makeContentReturn(di);
            const date = sortedDates[di];
            const photos = photosByDate[date];
            const dateLabel = '/ ' + date.replace(/-/g, '.');
            const photoUrls = photos.map(p => resolvePhotoUrl(p)).filter(u => u);
            const bb = first ? 'page' : 'none';
            first = false;
            try {
                const params = naejiParamsB(dateLabel, photoUrls);
                appendLog(`내지: ${dateLabel} (${photoUrls.length}photos)`, 'info');
                lastResult = await sdkPostContent(client, bookUid, tplUids.tplNaeji, params, bb);
                successCount++;
            } catch (err) {
                appendLog(`내지 오류: ${err.message}`, 'error');
                failCount++;
                return makeContentReturn(di);
            }
        }
    } else if (type === 'C') {
        let first = contentStart === 0;
        let prevMonth = '';
        let prevDay = null;
        // 상태 복원: contentStart 이전 entries 스캔
        for (let j = 0; j < contentStart; j++) {
            const d = new Date(sortedDates[j]);
            const ml = `${MONTH_EN[d.getMonth() + 1]} ${d.getFullYear()}`;
            if (ml !== prevMonth) { prevMonth = ml; prevDay = null; }
            const photos = photosByDate[sortedDates[j]];
            for (const p of photos) {
                prevDay = String(d.getMonth() + 1).padStart(2, '0') + '\n' + String(d.getDate()).padStart(2, '0');
            }
        }
        for (let di = contentStart; di < sortedDates.length; di++) {
            if (_paused) return makeContentReturn(di);
            const date = sortedDates[di];
            const photos = photosByDate[date];
            const d = new Date(date);
            const month = d.getMonth() + 1, day = d.getDate(), year = d.getFullYear();
            const monthLabel = `${MONTH_EN[month]} ${year}`;

            if (monthLabel !== prevMonth) {
                prevMonth = monthLabel;
                prevDay = null;
                const bb = first ? 'page' : 'none';
                first = false;
                try {
                    appendLog(`monthHeader: ${monthLabel}`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplMonthHeader, monthHeaderParamsC(monthLabel), bb);
                    successCount++;
                } catch (err) {
                    appendLog(`monthHeader 오류: ${err.message}`, 'error');
                    failCount++;
                    return makeContentReturn(di);
                }
            }

            const dayStr = String(month).padStart(2, '0') + '\n' + String(day).padStart(2, '0');
            for (const photo of photos) {
                const showLabel = dayStr !== prevDay;
                prevDay = dayStr;
                const url = resolvePhotoUrl(photo);
                try {
                    appendLog(`photo: ${month}/${day} hasDayLabel=${showLabel}`, 'info');
                    lastResult = await sdkPostContent(client, bookUid, tplUids.tplPhoto, photoParamsC(dayStr, url, showLabel), 'none');
                    successCount++;
                } catch (err) {
                    appendLog(`photo 오류: ${err.message}`, 'error');
                    failCount++;
                    return makeContentReturn(di);
                }
            }
        }
    }

    return { lastResult, successCount, failCount, coverPhoto: coverPhotoUrl };
}

// ── 이어서하기 ──
async function resumeBook() {
    if (!_saved) return;
    const s = _saved;
    _paused = false;
    loadingEl.classList.add('show');
    setButtons('running');

    try {
        let result;
        if (s.data) {
            result = await createBookFromJson(s.bookUid, s.type, s.tplUids, s.data, s.startIndex, s.resumeState);
        } else {
            result = await createBookFromPhotos(s.bookUid, s.type, s.tplUids, s.resumeState);
        }

        if (result?.paused) {
            _saved = { ...s, startIndex: result.startIndex, resumeState: result };
            const phase = result.phase === 'upload' ? '업로드' : '내지 생성';
            const idx = result.phase === 'upload' ? result.uploadIndex : (result.contentIndex ?? result.startIndex);
            appendLog(`일시중지 — ${phase} (${idx}번째)`, 'info');
            loadingEl.classList.remove('show');
            setButtons(result.failCount > 0 ? 'stopped' : 'paused');
            return;
        }

        // 완료 — 빈내지 + 발행면 처리
        let lastResult = result?.lastResult;
        const lastSide = lastResult?.pageSide || 'right';
        if (lastSide === 'left' && s.tplUids.tplBlank) {
            appendLog('빈내지 삽입 (발행면 위치 조정)...', 'info');
            lastResult = await sdkPostContent(client, s.bookUid, s.tplUids.tplBlank, {}, 'page');
            appendLog('빈내지 삽입 완료', 'success');
        }

        const publishParams = {
            photo: result.coverPhoto || '',
            title: document.getElementById('publishTitle').value.trim() || '',
            publishDate: document.getElementById('publishDate').value.trim() || '',
            author: document.getElementById('publishAuthor').value.trim() || '',
            hashtags: document.getElementById('publishHashtags').value.trim() || '',
            publisher: document.getElementById('publishPublisher')?.value.trim() || '',
        };
        const prePublishPages = lastResult?.pageCount || 0;
        let totalPages = prePublishPages;
        if (prePublishPages >= MIN_PAGES_FOR_PUBLISH) {
            appendLog('발행면 생성 중...', 'info');
            const publishResult = await sdkPostContent(client, s.bookUid, s.tplUids.tplPublish, publishParams, 'page');
            appendLog('발행면 완료', 'success');
            totalPages = publishResult?.pageCount || 0;
        }

        const tt = Date.now() - s.startTime;
        appendLog(`책 생성 완료! bookUid: ${s.bookUid}, 총 ${totalPages}페이지, 소요시간: ${(tt / 1000).toFixed(2)}초`, 'success');
        loadingEl.classList.remove('show');
        resultMessage.innerHTML = `✓ 구글포토북${s.type} 책이 생성되었습니다! (최종화 전)<br><small>bookUid: ${s.bookUid}</small><br><small>총 ${totalPages}페이지 | 성공: ${result.successCount}개 | 실패: ${result.failCount}개</small>`;
        resultMessage.className = 'result-message success show';

        const finalizeBtn = document.getElementById('finalizeBtn');
        finalizeBtn.dataset.bookUid = s.bookUid;
        finalizeBtn.disabled = totalPages < MIN_PAGES_FOR_FINALIZE;
        finalizeBtn.style.display = 'inline-block';
        _saved = null;
        setButtons('done');
    } catch (error) {
        appendLog(`오류: ${error.message}`, 'error');
        loadingEl.classList.remove('show');
        setButtons('idle');
    }
}

createBookBtn.addEventListener('click', createPhotoBook);
document.getElementById('pauseBtn').addEventListener('click', () => { _paused = true; });
document.getElementById('resumeBtn').addEventListener('click', resumeBook);
resetBtn.addEventListener('click', () => {
    if (confirm('모든 내용을 초기화하시겠습니까?')) resetAll();
});

// 제작(최종화) 버튼
document.getElementById('finalizeBtn').addEventListener('click', async () => {
    const finalizeBtn = document.getElementById('finalizeBtn');
    const bookUid = finalizeBtn.dataset.bookUid;
    if (!bookUid) return;
    finalizeBtn.disabled = true;
    appendLog('최종화 중...', 'info');
    try {
        await client.books.finalize(bookUid);
        appendLog(`최종화 완료! bookUid: ${bookUid}`, 'success');
        resultMessage.innerHTML = resultMessage.innerHTML.replace('(최종화 전)', '(최종화 완료)');
        finalizeBtn.style.display = 'none';
        createBookBtn.disabled = true;
    } catch (error) {
        appendLog(`최종화 오류: ${error.message}`, 'error');
        finalizeBtn.disabled = false;
    }
});

// 빈내지 추가 버튼
document.getElementById('addBlankBtn').addEventListener('click', async () => {
    const addBlankBtn = document.getElementById('addBlankBtn');
    const finalizeBtn = document.getElementById('finalizeBtn');
    const addPublishBtn = document.getElementById('addPublishBtn');
    const bookUid = addBlankBtn.dataset.bookUid;
    const tplBlank = addBlankBtn.dataset.tplBlank;
    if (!bookUid || !tplBlank) return;
    addBlankBtn.disabled = true;
    try {
        appendLog('빈내지 삽입 중...', 'info');
        const result = await sdkPostContent(client, bookUid, tplBlank, {}, 'page');
        const pageCount = result?.pageCount || 0;
        addBlankBtn.dataset.pageCount = pageCount;
        appendLog(`빈내지 삽입 완료 (현재 ${pageCount}페이지)`, 'success');

        // 발행면 보류 상태 + 짝수 페이지 + 22이상이면 발행면 추가 버튼 표시
        const publishDeferred = addPublishBtn.dataset.published !== 'true';
        if (publishDeferred && pageCount >= MIN_PAGES_FOR_PUBLISH && pageCount % 2 === 0) {
            addPublishBtn.disabled = false;
            addPublishBtn.style.display = 'inline-block';
        }

        if (pageCount >= MIN_PAGES_FOR_FINALIZE) {
            addBlankBtn.style.display = 'none';
            finalizeBtn.disabled = false;
            appendLog('24페이지 도달! 제작 버튼이 활성화되었습니다.', 'success');
        } else {
            addBlankBtn.disabled = false;
            appendLog(`${MIN_PAGES_FOR_FINALIZE - pageCount}페이지 더 필요합니다.`, 'info');
        }
    } catch (error) {
        appendLog(`빈내지 삽입 오류: ${error.message}`, 'error');
        addBlankBtn.disabled = false;
    }
});

// 발행면 추가 버튼
document.getElementById('addPublishBtn').addEventListener('click', async () => {
    const addPublishBtn = document.getElementById('addPublishBtn');
    const addBlankBtn = document.getElementById('addBlankBtn');
    const finalizeBtn = document.getElementById('finalizeBtn');
    const bookUid = addPublishBtn.dataset.bookUid;
    const tplPublish = addPublishBtn.dataset.tplPublish;
    if (!bookUid || !tplPublish) return;
    addPublishBtn.disabled = true;
    try {
        const publishParams = JSON.parse(addPublishBtn.dataset.publishParams || '{}');
        appendLog('발행면 삽입 중...', 'info');
        const result = await sdkPostContent(client, bookUid, tplPublish, publishParams, 'page');
        const pageCount = result?.pageCount || 0;
        addPublishBtn.dataset.published = 'true';
        addPublishBtn.style.display = 'none';
        addBlankBtn.dataset.pageCount = pageCount;
        appendLog(`발행면 삽입 완료 (현재 ${pageCount}페이지)`, 'success');
        if (pageCount >= MIN_PAGES_FOR_FINALIZE) {
            addBlankBtn.style.display = 'none';
            finalizeBtn.disabled = false;
            appendLog('24페이지 도달! 제작 버튼이 활성화되었습니다.', 'success');
        } else {
            appendLog(`${MIN_PAGES_FOR_FINALIZE - pageCount}페이지 더 필요합니다.`, 'info');
        }
    } catch (error) {
        appendLog(`발행면 삽입 오류: ${error.message}`, 'error');
        addPublishBtn.disabled = false;
    }
});

function resetAll() {
    _paused = false;
    _saved = null;
    setButtons('idle');
    clearAllData();
    clearFormFields();
    loadingEl.classList.remove('show');
    const finalizeBtn = document.getElementById('finalizeBtn');
    finalizeBtn.style.display = 'none';
    finalizeBtn.dataset.bookUid = '';
    const addBlankBtn = document.getElementById('addBlankBtn');
    addBlankBtn.style.display = 'none';
    addBlankBtn.disabled = true;
    addBlankBtn.dataset.bookUid = '';
    addBlankBtn.dataset.pageCount = '';
    const addPublishBtn = document.getElementById('addPublishBtn');
    addPublishBtn.style.display = 'none';
    addPublishBtn.disabled = true;
    addPublishBtn.dataset.bookUid = '';
    addPublishBtn.dataset.tplPublish = '';
    addPublishBtn.dataset.publishParams = '';
    addPublishBtn.dataset.published = '';
}
