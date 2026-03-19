/**
 * 로컬 개발 서버 — 정적 파일 서빙 + API 프록시 + 이미지 프록시
 *
 * 실행: node server.js [port]
 * 기본 포트: 8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function serveStatic(req, res) {
    let filePath = path.join(ROOT, decodeURIComponent(url.parse(req.url).pathname));
    if (filePath.endsWith(path.sep) || filePath.endsWith('/')) filePath += 'index.html';

    try {
        if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch (e) { /* ignore */ }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

/**
 * API 프록시: /proxy/api/{targetUrl}
 * 브라우저 CORS 우회를 위해 localhost → 실제 API 서버로 프록시합니다.
 */
function proxyApi(req, res) {
    const prefix = '/proxy/api/';
    const rawTarget = req.url.substring(prefix.length);
    if (!rawTarget) {
        res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
        res.end('Missing target URL');
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(rawTarget);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
        res.end('Invalid target URL: ' + rawTarget);
        return;
    }

    const headers = { 'Host': targetUrl.hostname };
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
    };

    const proxyReq = https.request(options, (proxyRes) => {
        const resHeaders = {
            'Content-Type': proxyRes.headers['content-type'] || 'application/json',
            ...CORS_HEADERS,
        };
        if (proxyRes.statusCode >= 400) {
            let body = '';
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, resHeaders);
                res.end(body);
            });
            return;
        }
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        }
        res.end(JSON.stringify({ error: err.message }));
    });

    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        req.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
}

/**
 * 이미지 프록시 허용 도메인 화이트리스트 (SSRF 방지)
 */
const ALLOWED_IMAGE_DOMAINS = [
    'lh3.googleusercontent.com',
    'picsum.photos',
    'images.pexels.com',
    'images.unsplash.com',
];

function isAllowedImageHost(hostname) {
    if (ALLOWED_IMAGE_DOMAINS.includes(hostname)) return true;
    if (hostname.endsWith('.googleusercontent.com')) return true;
    return false;
}

function isPrivateIP(hostname) {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (/^10\./.test(hostname)) return true;
    const m172 = hostname.match(/^172\.(\d+)\./);
    if (m172 && parseInt(m172[1]) >= 16 && parseInt(m172[1]) <= 31) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (hostname === '0.0.0.0') return true;
    return false;
}

/**
 * 이미지 프록시
 * /proxy/image?url=...&token=... → Authorization 헤더 붙여서 이미지 전달
 */
function proxyImage(req, res) {
    const parsed = url.parse(req.url, true);
    const imageUrl = parsed.query.url;
    const token = parsed.query.token;
    if (!imageUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
    }

    let target;
    try {
        target = new URL(imageUrl);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid URL');
        return;
    }

    if (isPrivateIP(target.hostname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: private/internal addresses are not allowed');
        return;
    }

    if (!isAllowedImageHost(target.hostname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: domain not in allowlist');
        return;
    }

    const options = {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {},
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
        });
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Image proxy error: ' + err.message);
    });
    proxyReq.end();
}

const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    // API 프록시
    if (req.url.startsWith('/proxy/api/')) {
        proxyApi(req, res);
        return;
    }

    // 이미지 프록시
    const pathname = url.parse(req.url).pathname;
    if (pathname === '/proxy/image') {
        proxyImage(req, res);
        return;
    }

    // 정적 파일
    serveStatic(req, res);
});

server.listen(PORT, () => {
    console.log(`서버 시작: http://localhost:${PORT}`);
    console.log(`종료: Ctrl+C`);
});
