/**
 * 브라우저에서 JPEG EXIF DateTimeOriginal 추출 (외부 라이브러리 없음)
 * + 파일명에서 날짜 추출 fallback
 */

/**
 * File/Blob에서 EXIF DateTimeOriginal 추출.
 * @param {File|Blob} file
 * @returns {Promise<string|null>} "YYYY-MM-DD" 또는 null
 */
async function getExifDate(file) {
    try {
        const buffer = await readFileSlice(file, 0, 128 * 1024); // 첫 128KB만 읽기
        const view = new DataView(buffer);

        // JPEG SOI 확인
        if (view.getUint16(0) !== 0xFFD8) return null;

        let offset = 2;
        while (offset < view.byteLength - 4) {
            const marker = view.getUint16(offset);
            if (marker === 0xFFE1) { // APP1 (EXIF)
                const length = view.getUint16(offset + 2);
                return parseExifBlock(view, offset + 4, length - 2);
            }
            if ((marker & 0xFF00) !== 0xFF00) break;
            const segLen = view.getUint16(offset + 2);
            offset += 2 + segLen;
        }
    } catch (e) {
        // 파싱 실패 시 무시
    }
    return null;
}

function readFileSlice(file, start, end) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file.slice(start, end));
    });
}

function parseExifBlock(view, offset, length) {
    const end = offset + length;
    // "Exif\0\0" 확인
    if (view.getUint32(offset) !== 0x45786966 || view.getUint16(offset + 4) !== 0x0000) return null;

    const tiffStart = offset + 6;
    const byteOrder = view.getUint16(tiffStart);
    const le = byteOrder === 0x4949; // little-endian

    const get16 = (o) => view.getUint16(o, le);
    const get32 = (o) => view.getUint32(o, le);

    // TIFF 헤더
    if (get16(tiffStart + 2) !== 0x002A) return null;
    const ifd0Offset = tiffStart + get32(tiffStart + 4);

    // IFD0에서 ExifIFD 포인터 (tag 0x8769) 찾기
    const exifIfdOffset = findTagValue(view, ifd0Offset, tiffStart, end, 0x8769, get16, get32);
    if (exifIfdOffset === null) return null;

    const exifOffset = tiffStart + exifIfdOffset;
    // ExifIFD에서 DateTimeOriginal (0x9003) 찾기
    const dateStr = findStringTag(view, exifOffset, tiffStart, end, 0x9003, get16, get32);
    if (dateStr) return formatExifDate(dateStr);

    // fallback: DateTime (0x0132)
    const dateStr2 = findStringTag(view, ifd0Offset, tiffStart, end, 0x0132, get16, get32);
    if (dateStr2) return formatExifDate(dateStr2);

    return null;
}

function findTagValue(view, ifdOffset, tiffStart, end, targetTag, get16, get32) {
    if (ifdOffset + 2 > end) return null;
    const count = get16(ifdOffset);
    for (let i = 0; i < count; i++) {
        const entryOffset = ifdOffset + 2 + (i * 12);
        if (entryOffset + 12 > end) return null;
        const tag = get16(entryOffset);
        if (tag === targetTag) {
            return get32(entryOffset + 8);
        }
    }
    return null;
}

function findStringTag(view, ifdOffset, tiffStart, end, targetTag, get16, get32) {
    if (ifdOffset + 2 > end) return null;
    const count = get16(ifdOffset);
    for (let i = 0; i < count; i++) {
        const entryOffset = ifdOffset + 2 + (i * 12);
        if (entryOffset + 12 > end) return null;
        const tag = get16(entryOffset);
        if (tag === targetTag) {
            const type = get16(entryOffset + 2);
            const numValues = get32(entryOffset + 4);
            if (type !== 2) continue; // ASCII
            let strOffset;
            if (numValues <= 4) {
                strOffset = entryOffset + 8;
            } else {
                strOffset = tiffStart + get32(entryOffset + 8);
            }
            if (strOffset + numValues > end) return null;
            let str = '';
            for (let j = 0; j < numValues - 1; j++) {
                str += String.fromCharCode(view.getUint8(strOffset + j));
            }
            return str;
        }
    }
    return null;
}

function formatExifDate(exifStr) {
    // "2020:09:03 14:29:49" → "2020-09-03"
    const match = exifStr.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return null;
}

/**
 * 파일명에서 날짜 추출 (fallback)
 * 지원 패턴:
 *  - KakaoTalk_YYYYMMDD_...
 *  - IMG_YYYYMMDD_...
 *  - YYYYMMDD_... (8자리 숫자로 시작)
 *  - YYYY-MM-DD 또는 YYYY_MM_DD
 * @param {string} filename
 * @returns {string|null} "YYYY-MM-DD" 또는 null
 */
function getDateFromFilename(filename) {
    // KakaoTalk_20200903_... 또는 IMG_20200903_...
    let match = filename.match(/[_](\d{4})(\d{2})(\d{2})[_]/);
    if (match) {
        const [, y, m, d] = match;
        if (isValidDate(y, m, d)) return `${y}-${m}-${d}`;
    }

    // YYYYMMDD로 시작
    match = filename.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) {
        const [, y, m, d] = match;
        if (isValidDate(y, m, d)) return `${y}-${m}-${d}`;
    }

    // YYYY-MM-DD 또는 YYYY_MM_DD
    match = filename.match(/(\d{4})[_-](\d{2})[_-](\d{2})/);
    if (match) {
        const [, y, m, d] = match;
        if (isValidDate(y, m, d)) return `${y}-${m}-${d}`;
    }

    return null;
}

function isValidDate(y, m, d) {
    const year = parseInt(y), month = parseInt(m), day = parseInt(d);
    return year >= 1990 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * 사진 파일에서 날짜 추출 (EXIF → 파일명 → null)
 * @param {File} file
 * @returns {Promise<{date: string|null, source: string}>}
 */
async function extractPhotoDate(file) {
    // 1. EXIF
    const exifDate = await getExifDate(file);
    if (exifDate) return { date: exifDate, source: 'exif' };

    // 2. 파일명
    const fnDate = getDateFromFilename(file.name);
    if (fnDate) return { date: fnDate, source: 'filename' };

    // 3. 실패
    return { date: null, source: 'none' };
}
