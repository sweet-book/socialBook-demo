/**
 * 구글포토북 책 생성 로직 — Python SDK의 구글포토북A/B/C_book.py에 대응
 */

// ── 이미지 파라미터 빈 값 제거 ──
const IMAGE_PARAM_KEYS = new Set(['coverPhoto', 'photo', 'frontPhoto', 'backPhoto']);

function stripEmptyImages(obj) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
        if (IMAGE_PARAM_KEYS.has(k) && (!v || v === '')) continue;
        result[k] = v;
    }
    return result;
}

async function sdkPostContent(client, bookUid, templateUid, parameters, breakBefore) {
    const result = await client.contents.insert(bookUid, templateUid, stripEmptyImages(parameters), {
        breakBefore: breakBefore === 'none' ? '' : breakBefore,
    });
    console.log('sdkPostContent result:', JSON.stringify(result));
    return result;
}

// ── A 타입: 표지 파라미터 (Python cover_params) ──
function coverParamsA(data) {
    const params = {
        subtitle: data.subtitle || '',
        dateRange: data.dateRange || '',
    };
    if (data.coverPhoto) params.coverPhoto = data.coverPhoto;
    return params;
}

// ── A 타입: 간지 파라미터 (Python ganji_params) ──
function ganjiParamsA(ganjiData) {
    const sm = MONTH_EN[ganjiData.startMonth];
    const em = MONTH_EN[ganjiData.endMonth];
    let title;
    if (ganjiData.startYear === ganjiData.endYear) {
        title = `${sm} - ${em}\n${ganjiData.endYear}`;
    } else {
        title = `${sm} ${ganjiData.startYear}\n${em} ${ganjiData.endYear}`;
    }
    return {
        monthYearTitle: title,
        dateRangeDetail: ganjiData.dateRangeDetail,
        photoCount: ganjiData.photoCount,
    };
}

// ── A 타입: 내지 dateA 파라미터 ──
function dateAParams(monthYearLabel, dayLabel, photos) {
    return { monthYearLabel, dayLabel, photos };
}

// ── A 타입: 내지 dateB 파라미터 ──
function dateBParams(dayLabel, photos) {
    return { dayLabel, photos };
}

// ── B 타입: 표지 파라미터 ──
function coverParamsB(data) {
    return data;
}

// ── B 타입: 간지 파라미터 ──
function ganjiParamsB(photoCount, dateRangeDetail) {
    return {
        recordTitle: `${photoCount}장의 기록`,
        dateRangeDetail,
    };
}

// ── B 타입: 내지 파라미터 ──
function naejiParamsB(dateLabel, photos) {
    return { dateLabel, photos };
}

// ── C 타입: 표지 파라미터 ──
function coverParamsC(data) {
    return data;
}

// ── C 타입: 간지 파라미터 ──
function ganjiParamsC(ganjiData, photoCount) {
    const sm = MONTH_EN[ganjiData.startMonth];
    const em = MONTH_EN[ganjiData.endMonth];
    let title;
    if (ganjiData.startYear === ganjiData.endYear) {
        title = `${sm} - ${em}\n${ganjiData.endYear}`;
    } else {
        title = `${sm} ${ganjiData.startYear}\n${em} ${ganjiData.endYear}`;
    }
    return {
        monthYearTitle: title,
        recordTitle: `${photoCount}장의 기록`,
    };
}

// ── C 타입: monthHeader 파라미터 ──
function monthHeaderParamsC(monthYearLabel) {
    return { monthYearLabel };
}

// ── C 타입: photo 파라미터 ──
function photoParamsC(dayLabel, photoUrl, hasDayLabel) {
    return { dayLabel, photo: photoUrl, hasDayLabel: hasDayLabel !== false };
}
