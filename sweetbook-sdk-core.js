/**
 * Sweetbook JavaScript SDK — Core
 * 공통 기반: Error, ResponseParser, BaseClient
 */

// ============================================================
// Errors
// ============================================================

class SweetbookApiError extends Error {
  constructor(message, { errorCode, statusCode, details, response } = {}) {
    super(message);
    this.name = 'SweetbookApiError';
    this.errorCode = errorCode || null;
    this.statusCode = statusCode || null;
    this.details = details || null;
    this.response = response || null;
  }

  static async fromResponse(response) {
    let body = null;
    try { body = await response.json(); } catch (e) { /* ignore */ }
    const err = body?.error || {};
    return new SweetbookApiError(
      err.message || `HTTP ${response.status}`,
      {
        errorCode: err.code || null,
        statusCode: response.status,
        details: err.details || null,
        response,
      }
    );
  }
}

class SweetbookNetworkError extends Error {
  constructor(message, { originalError } = {}) {
    super(message);
    this.name = 'SweetbookNetworkError';
    this.originalError = originalError || null;
  }
}

class SweetbookValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SweetbookValidationError';
    this.field = field || null;
  }
}

// ============================================================
// Response Parser
// ============================================================

class ResponseParser {
  constructor(body) {
    this.body = body;
  }

  getData() {
    return this.body?.data ?? this.body;
  }

  getList() {
    const d = this.getData();
    return Array.isArray(d) ? d : [];
  }

  getDict() {
    const d = this.getData();
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  }

  getMeta() {
    return this.body?.meta || {};
  }

  getPagination() {
    return this.getMeta().pagination || {};
  }
}

// ============================================================
// UUID generator (simple v4-like)
// ============================================================

function generateUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================
// Base HTTP Client
// ============================================================

class BaseClient {
  constructor(sweetbookClient) {
    this._client = sweetbookClient;
  }

  _getApiKey(useAdmin = false) {
    if (useAdmin && this._client._adminApiKey) {
      return this._client._adminApiKey;
    }
    return this._client._apiKey;
  }

  _buildTemplateFormData(templateUid, parameters, files, fileFieldName = 'files') {
    const fd = new FormData();
    fd.append('templateUid', templateUid);
    fd.append('parameters', JSON.stringify(parameters));
    if (files && files.length > 0) {
      for (const f of files) {
        fd.append(fileFieldName, f);
      }
    }
    return fd;
  }

  _requireParam(value, name) {
    if (value === undefined || value === null || value === '') {
      throw new SweetbookValidationError(`${name} is required`, name);
    }
  }

  async _request(method, path, { payload, formData, params, useAdmin } = {}) {
    const baseUrl = this._client._baseUrl.replace(/\/+$/, '');
    const urlPath = path.startsWith('/') ? path : `/${path}`;

    // Build query string
    let queryString = '';
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (qs) queryString = `?${qs}`;
    }

    const fullUrl = `${baseUrl}${urlPath}${queryString}`;

    const headers = {};
    const fetchOptions = { method, headers };

    if (this._client._useCookie) {
      fetchOptions.credentials = 'include';
    } else {
      headers['Authorization'] = `Bearer ${this._getApiKey(useAdmin)}`;
      headers['X-Transaction-ID'] = generateUuid();
    }

    if (formData) {
      fetchOptions.body = formData;
    } else if (payload !== undefined && payload !== null) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(payload);
    }

    const timeout = this._client._timeout;
    const maxRetries = 2;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 재시도 시 지수 백오프 대기
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        await new Promise(r => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      fetchOptions.signal = controller.signal;

      let response;
      try {
        response = await fetch(fullUrl, fetchOptions);
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          lastError = new SweetbookNetworkError(`Request timed out after ${timeout}ms`, { originalError: err });
        } else {
          lastError = new SweetbookNetworkError(`Network request failed: ${err.message}`, { originalError: err });
        }
        continue; // 네트워크 에러는 재시도
      } finally {
        clearTimeout(timeoutId);
      }

      // 429 또는 5xx는 재시도
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        lastError = await SweetbookApiError.fromResponse(response);
        continue;
      }

      if (!response.ok) {
        throw await SweetbookApiError.fromResponse(response);
      }

      const text = await response.text();
      if (!text) return null;

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    throw lastError;
  }

  async _get(path, params, options) {
    return this._request('GET', path, { params, ...options });
  }

  async _post(path, payload, options) {
    return this._request('POST', path, { payload, ...options });
  }

  async _postForm(path, formData, options) {
    return this._request('POST', path, { formData, ...options });
  }

  async _patch(path, payload, options) {
    return this._request('PATCH', path, { payload, ...options });
  }

  async _delete(path, params, options) {
    return this._request('DELETE', path, { params, ...options });
  }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SweetbookApiError, SweetbookNetworkError, SweetbookValidationError, ResponseParser, BaseClient, generateUuid };
}
