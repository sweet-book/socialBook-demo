/**
 * Sweetbook JavaScript SDK — User
 * 일반 사용자용: Books, Photos, Covers, Contents
 *
 * 의존: sweetbook-sdk-core.js (BaseClient, ResponseParser 등)
 *
 * Usage:
 *   const client = new SweetbookClient({ apiKey: 'your-api-key' });
 *   const book = await client.books.create({ bookSpecUid: 'spec123', title: 'My Book' });
 */

// ============================================================
// Books Client
// ============================================================

class BooksClient extends BaseClient {
  /**
   * List books
   * @param {Object} params - { status, limit, offset }
   */
  async list(params = {}) {
    const { status, limit = 20, offset = 0 } = params;
    const body = await this._get('/Books', { status, limit, offset });
    return new ResponseParser(body).getDict();
  }

  /**
   * Create a book
   * @param {Object} data - { bookSpecUid, title, creationType, ...extraData }
   */
  async create(data) {
    const { bookSpecUid, title, creationType = 'NORMAL', ...extraData } = data;
    if (!bookSpecUid) throw new SweetbookValidationError('bookSpecUid is required', 'bookSpecUid');
    const payload = { bookSpecUid, creationType, ...extraData };
    if (title) payload.title = title;
    const body = await this._post('/Books', payload);
    return new ResponseParser(body).getDict();
  }

  /**
   * Get book details
   * @param {string} bookUid
   */
  async get(bookUid) {
    const body = await this._get(`/Books/${bookUid}`);
    return new ResponseParser(body).getDict();
  }

  /**
   * Finalize a book
   * @param {string} bookUid
   */
  async finalize(bookUid) {
    const body = await this._post(`/Books/${bookUid}/finalization`, {});
    return new ResponseParser(body).getDict();
  }

  /**
   * Delete a book
   * @param {string} bookUid
   */
  async delete(bookUid) {
    return this._delete(`/Books/${bookUid}`);
  }
}

// ============================================================
// Photos Client
// ============================================================

class PhotosClient extends BaseClient {
  /**
   * Upload a single photo file
   * @param {string} bookUid
   * @param {File|Blob} file
   * @param {Object} options - { preserveExif }
   */
  async upload(bookUid, file, options = {}) {
    const fd = new FormData();
    fd.append('file', file);
    if (options.preserveExif) {
      fd.append('preserveExif', 'true');
    }
    const body = await this._postForm(`/Books/${bookUid}/photos`, fd);
    return new ResponseParser(body).getData();
  }

  /**
   * Upload multiple photo files
   * @param {string} bookUid
   * @param {Array<File|Blob>} files
   * @param {Object} options - { preserveExif }
   */
  async uploadMultiple(bookUid, files, options = {}) {
    const results = [];
    for (const file of files) {
      const result = await this.upload(bookUid, file, options);
      results.push(result);
    }
    return results;
  }

  /**
   * List photos in a book
   * @param {string} bookUid
   */
  async list(bookUid) {
    const body = await this._get(`/Books/${bookUid}/photos`);
    return new ResponseParser(body).getDict();
  }

  /**
   * Delete a photo
   * @param {string} bookUid
   * @param {string} fileName
   */
  async delete(bookUid, fileName) {
    return this._delete(`/Books/${bookUid}/photos/${fileName}`);
  }
}

// ============================================================
// Covers Client
// ============================================================

class CoversClient extends BaseClient {
  /**
   * Create a book cover
   * @param {string} bookUid
   * @param {string} templateUid
   * @param {Object} parameters - template parameters
   * @param {Array<File|Blob>} [files] - files for $upload parameters
   */
  async create(bookUid, templateUid, parameters, files) {
    const fd = this._buildTemplateFormData(templateUid, parameters, files, 'files');
    const body = await this._postForm(`/Books/${bookUid}/cover`, fd);
    return new ResponseParser(body).getData();
  }

  /**
   * Get cover info
   * @param {string} bookUid
   */
  async get(bookUid) {
    const body = await this._get(`/Books/${bookUid}/cover`);
    return new ResponseParser(body).getDict();
  }

  /**
   * Delete cover
   * @param {string} bookUid
   */
  async delete(bookUid) {
    return this._delete(`/Books/${bookUid}/cover`);
  }
}

// ============================================================
// Contents Client
// ============================================================

class ContentsClient extends BaseClient {
  /**
   * Insert content page(s)
   * @param {string} bookUid
   * @param {string} templateUid
   * @param {Object} parameters - template parameters
   * @param {Object} [options] - { files, breakBefore }
   *   breakBefore: "page" | "spread" | "" | null
   *   files: Array<File|Blob> for $upload parameters
   */
  async insert(bookUid, templateUid, parameters, options = {}) {
    const { files, breakBefore } = options;
    const fd = this._buildTemplateFormData(templateUid, parameters, files, 'rowPhotos');
    const params = {};
    if (breakBefore) params.breakBefore = breakBefore;
    const body = await this._request('POST', `/Books/${bookUid}/contents`, { formData: fd, params });
    const data = new ResponseParser(body).getData();
    if (body?.cursor && data && typeof data === 'object') {
      data.pageNum = body.cursor.pageNum;
      data.pageSide = body.cursor.pageSide;
    }
    return data;
  }

  /**
   * Clear all content pages
   * @param {string} bookUid
   */
  async clear(bookUid) {
    return this._delete(`/Books/${bookUid}/contents`);
  }
}

// ============================================================
// User Client
// ============================================================

class SweetbookClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - User API key (required unless useCookie is true)
   * @param {string} [options.baseUrl] - API base URL (default: https://api.sweetbook.com/v1)
   * @param {string} [options.environment] - 'sandbox' for sandbox server, 'live' for production (default)
   * @param {boolean} [options.useCookie] - Use cookie auth with credentials:'include'
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   */
  constructor(options = {}) {
    if (!options.apiKey && !options.useCookie) {
      throw new SweetbookValidationError('apiKey is required (or set useCookie: true)', 'apiKey');
    }
    this._apiKey = options.apiKey || null;
    this._adminApiKey = null;
    this._useCookie = options.useCookie || false;
    this._timeout = options.timeout || 30000;

    // G-30: sandbox/live 환경 자동 분기
    if (options.baseUrl) {
      this._baseUrl = options.baseUrl;
    } else if (options.environment === 'sandbox') {
      this._baseUrl = 'https://api-sandbox.sweetbook.com/v1';
    } else {
      this._baseUrl = 'https://api.sweetbook.com/v1';
    }

    this.books = new BooksClient(this);
    this.photos = new PhotosClient(this);
    this.covers = new CoversClient(this);
    this.contents = new ContentsClient(this);
  }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SweetbookClient, BooksClient, PhotosClient, CoversClient, ContentsClient };
}
