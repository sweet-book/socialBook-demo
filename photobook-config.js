/**
 * 구글포토북 A/B/C 타입별 설정 — 템플릿 UID, 그래픽 키맵, 파라미터 빌더
 */

// ── 템플릿 UID (templates.json에서 로드) ──
const TEMPLATE_UIDS = { A: {}, B: {}, C: {} };

// templateName → 코드키 매핑 (Python TEMPLATE_NAME_TO_KEY와 동일)
const TPL_NAME_MAP = {
    A: {
        '구글포토북A_표지': 'cover', '구글포토북A_간지': 'ganji',
        '구글포토북A_내지_dateA': 'dateA', '구글포토북A_내지_dateB': 'dateB',
        '구글포토북A_발행면': 'publish', '구글포토북A_빈내지': 'blank',
    },
    B: {
        '구글포토북B_표지': 'cover', '구글포토북B_간지': 'ganji',
        '구글포토북B_내지': 'naeji',
        '구글포토북B_발행면': 'publish', '구글포토북B_빈내지': 'blank',
    },
    C: {
        '구글포토북C_표지': 'cover', '구글포토북C_간지': 'ganji',
        '구글포토북C_내지_monthHeader': 'monthHeader', '구글포토북C_내지_photo': 'photo',
        '구글포토북C_발행면': 'publish', '구글포토북C_빈내지': 'blank',
    },
};

// 템플릿 필드 정의 (UI 표시용)
const TPL_FIELDS = {
    A: [
        { id: 'tplCover', label: '표지' }, { id: 'tplGanji', label: '간지' },
        { id: 'tplDateA', label: '내지 dateA' }, { id: 'tplDateB', label: '내지 dateB' },
        { id: 'tplBlank', label: '빈내지' }, { id: 'tplPublish', label: '발행면' },
    ],
    B: [
        { id: 'tplCover', label: '표지' }, { id: 'tplGanji', label: '간지' },
        { id: 'tplNaeji', label: '내지' },
        { id: 'tplBlank', label: '빈내지' }, { id: 'tplPublish', label: '발행면' },
    ],
    C: [
        { id: 'tplCover', label: '표지' }, { id: 'tplGanji', label: '간지' },
        { id: 'tplMonthHeader', label: '내지 monthHeader' }, { id: 'tplPhoto', label: '내지 photo' },
        { id: 'tplBlank', label: '빈내지' }, { id: 'tplPublish', label: '발행면' },
    ],
};

// 표지 필드 정의
const COVER_FIELDS = {
    A: [
        { id: 'coverSubtitle', label: '표지 서브타이틀 *', placeholder: '나의 모든 순간들' },
        { id: 'coverDateRange', label: '기간 *', placeholder: '2024.06 - 2025.12' },
    ],
    B: [
        { id: 'coverSubtitle', label: '표지 서브타이틀 *', placeholder: '나의 모든 순간들', defaultValue: '나의 모든\n순간들' },
        { id: 'coverDateRange', label: '기간 *', placeholder: '2025.04 - 2025.06' },
    ],
    C: [
        { id: 'coverSubtitle', label: '표지 서브타이틀 *', placeholder: '나의 모든 순간들' },
        { id: 'coverDateRange', label: '기간 *', placeholder: '2024.12 - 2025.06' },
    ],
};

function parseTemplatesJson(items, nameMap) {
    const result = {};
    for (const item of items) {
        const key = nameMap[item.templateName];
        if (key) result[key] = item.templateUid;
    }
    return result;
}

async function loadTemplateUids() {
    try {
        const [respA, respB, respC] = await Promise.all([
            fetch('구글포토북A/templates/templates.json'), fetch('구글포토북B/templates/templates.json'), fetch('구글포토북C/templates/templates.json'),
        ]);
        if (respA.ok) Object.assign(TEMPLATE_UIDS.A, parseTemplatesJson(await respA.json(), TPL_NAME_MAP.A));
        if (respB.ok) Object.assign(TEMPLATE_UIDS.B, parseTemplatesJson(await respB.json(), TPL_NAME_MAP.B));
        if (respC.ok) Object.assign(TEMPLATE_UIDS.C, parseTemplatesJson(await respC.json(), TPL_NAME_MAP.C));
    } catch (err) { console.warn('templates.json 로드 실패:', err); }
}

// 구글포토북A/C는 graphics.json에서 로드, B는 그래픽 없음

// ── 월 영문 매핑 ──
const MONTH_EN = {
    1: 'JANUARY', 2: 'FEBRUARY', 3: 'MARCH', 4: 'APRIL',
    5: 'MAY', 6: 'JUNE', 7: 'JULY', 8: 'AUGUST',
    9: 'SEPTEMBER', 10: 'OCTOBER', 11: 'NOVEMBER', 12: 'DECEMBER',
};
