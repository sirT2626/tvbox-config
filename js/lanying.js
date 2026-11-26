/* ==================================================================
 * 蓝鹰（qijiappapi）爬虫 —— 自包含版本
 *
 * 改造点（相对原版）：
 *  1. 不再 import 'assets://js/lib/cat.js'，MD5 / AES / Base64 全部内联，
 *     不依赖壳的 assets，也不需要额外下载 486KB 的 cat.js；
 *  2. 不依赖 lodash（_），改用原生数组方法；
 *  3. req() 缺失时自动回退到 fetch()；
 *  4. detail() 增加 vod 判空，play() 的弹幕失败不再拖垮播放；
 *  5. category() 的 extend 判空，pagecount 按“本页是否满 30 条”推断；
 *  6. 去掉可选链 ?.，兼容较老的 QuickJS 引擎。
 * ================================================================== */

/* ---------------------- 一、基础编码工具 ---------------------- */

function utf8ToBytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            const c2 = str.charCodeAt(++i);
            const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(out);
}

function bytesToUtf8(bytes) {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i++];
        if (b < 0x80) {
            out += String.fromCharCode(b);
        } else if (b >= 0xc0 && b < 0xe0) {
            out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if (b >= 0xe0 && b < 0xf0) {
            out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        } else {
            const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
            const v = cp - 0x10000;
            out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
        }
    }
    return out;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_MAP = (function () {
    const m = {};
    for (let i = 0; i < B64_CHARS.length; i++) m[B64_CHARS[i]] = i;
    return m;
})();

function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64_CHARS[b0 >> 2];
        out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : '=';
    }
    return out;
}

function base64ToBytes(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
    const out = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (ch === '=') break;
        const v = B64_MAP[ch];
        if (v === undefined) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

/* ---------------------- 二、MD5 ---------------------- */

const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = (function () {
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }
    return k;
})();

function rotl32(x, n) {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function md5(text) {
    const input = utf8ToBytes(String(text));
    const len = input.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(input);
    buf[len] = 0x80;

    const bitLen = len * 8;
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 4294967296) >>> 0;
    buf[total - 8] = lo & 0xff;
    buf[total - 7] = (lo >>> 8) & 0xff;
    buf[total - 6] = (lo >>> 16) & 0xff;
    buf[total - 5] = (lo >>> 24) & 0xff;
    buf[total - 4] = hi & 0xff;
    buf[total - 3] = (hi >>> 8) & 0xff;
    buf[total - 2] = (hi >>> 16) & 0xff;
    buf[total - 1] = (hi >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);

    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) {
            const p = off + i * 4;
            M[i] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            F = (F + A + MD5_K[i] + M[g]) >>> 0;
            A = D;
            D = C;
            C = B;
            B = (B + rotl32(F, MD5_S[i])) >>> 0;
        }
        a0 = (a0 + A) >>> 0;
        b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0;
        d0 = (d0 + D) >>> 0;
    }

    function wordToHex(w) {
        let s = '';
        for (let i = 0; i < 4; i++) {
            s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return s;
    }
    return wordToHex(a0) + wordToHex(b0) + wordToHex(c0) + wordToHex(d0);
}

/* ---------------------- 三、AES（CBC / PKCS7） ---------------------- */

function xtime(b) {
    return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff;
}

const AES_EXP = new Uint8Array(512);
const AES_LOG = new Uint8Array(256);
(function initGfTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        AES_EXP[i] = x;
        AES_LOG[x] = i;
        x ^= xtime(x);
    }
    for (let i = 255; i < 512; i++) AES_EXP[i] = AES_EXP[i - 255];
})();

function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return AES_EXP[AES_LOG[a] + AES_LOG[b]];
}

const AES_SBOX = new Uint8Array(256);
const AES_INV_SBOX = new Uint8Array(256);
(function initSbox() {
    for (let i = 0; i < 256; i++) {
        const inv = i === 0 ? 0 : AES_EXP[255 - AES_LOG[i]];
        let s = inv;
        let r = inv;
        for (let k = 0; k < 4; k++) {
            r = ((r << 1) | (r >> 7)) & 0xff;
            s ^= r;
        }
        s ^= 0x63;
        AES_SBOX[i] = s;
        AES_INV_SBOX[s] = i;
    }
})();

function subWord(w) {
    return ((AES_SBOX[(w >>> 24) & 0xff] << 24) |
        (AES_SBOX[(w >>> 16) & 0xff] << 16) |
        (AES_SBOX[(w >>> 8) & 0xff] << 8) |
        AES_SBOX[w & 0xff]) >>> 0;
}

function aesKeySchedule(keyBytes) {
    const Nk = keyBytes.length >>> 2;
    if (Nk !== 4 && Nk !== 6 && Nk !== 8) {
        throw new Error('AES 密钥长度必须是 16/24/32 字节，当前 ' + keyBytes.length);
    }
    const Nr = Nk + 6;
    const w = new Uint32Array(4 * (Nr + 1));
    for (let i = 0; i < Nk; i++) {
        w[i] = (((keyBytes[i * 4] << 24) | (keyBytes[i * 4 + 1] << 16) |
            (keyBytes[i * 4 + 2] << 8) | keyBytes[i * 4 + 3]) >>> 0);
    }
    let rcon = 1;
    for (let i = Nk; i < w.length; i++) {
        let t = w[i - 1];
        if (i % Nk === 0) {
            t = ((t << 8) | (t >>> 24)) >>> 0;
            t = (subWord(t) ^ (rcon << 24)) >>> 0;
            rcon = xtime(rcon);
        } else if (Nk > 6 && i % Nk === 4) {
            t = subWord(t);
        }
        w[i] = (w[i - Nk] ^ t) >>> 0;
    }
    return { w: w, Nr: Nr };
}

function aesAddRoundKey(s, w, round) {
    for (let c = 0; c < 4; c++) {
        const k = w[round * 4 + c];
        s[c * 4] ^= (k >>> 24) & 0xff;
        s[c * 4 + 1] ^= (k >>> 16) & 0xff;
        s[c * 4 + 2] ^= (k >>> 8) & 0xff;
        s[c * 4 + 3] ^= k & 0xff;
    }
}

function aesShiftRows(s) {
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
}

function aesInvShiftRows(s) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
}

function aesMixColumns(s) {
    for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
}

function aesInvMixColumns(s) {
    for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
}

function aesEncryptBlock(input, ks) {
    const s = new Uint8Array(input);
    aesAddRoundKey(s, ks.w, 0);
    for (let round = 1; round < ks.Nr; round++) {
        for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
        aesShiftRows(s);
        aesMixColumns(s);
        aesAddRoundKey(s, ks.w, round);
    }
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    aesShiftRows(s);
    aesAddRoundKey(s, ks.w, ks.Nr);
    return s;
}

function aesDecryptBlock(input, ks) {
    const s = new Uint8Array(input);
    aesAddRoundKey(s, ks.w, ks.Nr);
    for (let round = ks.Nr - 1; round >= 1; round--) {
        aesInvShiftRows(s);
        for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
        aesAddRoundKey(s, ks.w, round);
        aesInvMixColumns(s);
    }
    aesInvShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
    aesAddRoundKey(s, ks.w, 0);
    return s;
}

function aesCbcEncrypt(plain, keyBytes, ivBytes) {
    const ks = aesKeySchedule(keyBytes);
    const padLen = 16 - (plain.length % 16);
    const data = new Uint8Array(plain.length + padLen);
    data.set(plain);
    for (let i = plain.length; i < data.length; i++) data[i] = padLen;

    const out = new Uint8Array(data.length);
    let prev = ivBytes.slice(0, 16);
    for (let off = 0; off < data.length; off += 16) {
        const block = new Uint8Array(16);
        for (let i = 0; i < 16; i++) block[i] = data[off + i] ^ prev[i];
        const enc = aesEncryptBlock(block, ks);
        out.set(enc, off);
        prev = enc;
    }
    return out;
}

function aesCbcDecrypt(cipher, keyBytes, ivBytes) {
    if (!cipher.length || cipher.length % 16 !== 0) {
        throw new Error('密文长度不是 16 的整数倍（' + cipher.length + '），可能密钥不对');
    }
    const ks = aesKeySchedule(keyBytes);
    const out = new Uint8Array(cipher.length);
    let prev = ivBytes.slice(0, 16);
    for (let off = 0; off < cipher.length; off += 16) {
        const block = cipher.slice(off, off + 16);
        const dec = aesDecryptBlock(block, ks);
        for (let i = 0; i < 16; i++) out[off + i] = dec[i] ^ prev[i];
        prev = block;
    }
    let pad = out[out.length - 1];
    if (pad < 1 || pad > 16 || pad > out.length) pad = 0;
    return out.slice(0, out.length - pad);
}

function aesDecode(str, keyStr, ivStr, type) {
    const keyBytes = utf8ToBytes(String(keyStr));
    const ivBytes = utf8ToBytes(String(ivStr));
    let cipher;
    if (type === 'hex') {
        const hex = String(str).replace(/[^0-9a-fA-F]/g, '');
        const arr = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
        cipher = arr;
    } else {
        cipher = base64ToBytes(str);
    }
    return bytesToUtf8(aesCbcDecrypt(cipher, keyBytes, ivBytes));
}

function aesEncode(str, keyStr, ivStr, type) {
    const keyBytes = utf8ToBytes(String(keyStr));
    const ivBytes = utf8ToBytes(String(ivStr));
    const cipher = aesCbcEncrypt(utf8ToBytes(String(str)), keyBytes, ivBytes);
    if (type === 'hex') {
        let hex = '';
        for (let i = 0; i < cipher.length; i++) hex += cipher[i].toString(16).padStart(2, '0');
        return hex;
    }
    return bytesToBase64(cipher);
}

/* ---------------------- 四、网络 ---------------------- */

function formEncode(obj) {
    const parts = [];
    Object.keys(obj || {}).forEach(function (k) {
        const v = obj[k];
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined || v === null ? '' : v));
    });
    return parts.join('&');
}

/** 统一请求入口：优先用壳注入的 req()，没有则退回 fetch() */
async function httpRequest(url, opt) {
    if (typeof req === 'function') {
        return await req(url, opt);
    }
    if (typeof fetch === 'function') {
        const method = (opt.method || 'get').toUpperCase();
        const hdrs = Object.assign({}, opt.headers || {});
        let body;
        let finalUrl = url;
        if (method === 'POST') {
            if (opt.postType === 'raw') {
                body = opt.data;
            } else if (opt.data && typeof opt.data === 'object') {
                body = formEncode(opt.data);
                if (!hdrs['Content-Type'] && !hdrs['content-type']) {
                    hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
                }
            } else {
                body = opt.data || '';
            }
        } else if (opt.data && typeof opt.data === 'object' && Object.keys(opt.data).length) {
            finalUrl += (url.indexOf('?') > -1 ? '&' : '?') + formEncode(opt.data);
        }
        const res = await fetch(finalUrl, { method: method, headers: hdrs, body: body });
        let content;
        if (opt.buffer === 2) {
            content = bytesToBase64(new Uint8Array(await res.arrayBuffer()));
        } else {
            content = await res.text();
        }
        return { content: content, code: res.status };
    }
    throw new Error('当前运行环境没有 req() 也没有 fetch()，无法发起网络请求');
}

/* ---------------------- 五、站点状态 ---------------------- */

let siteUrl = '';
let key = '';
let iv = '';
let siteKey = '';
let siteType = 3;
let apiPrefix = 'getappapi.index';

const prefixMap = {
    '1': 'getappapi.index',
    '2': 'qijiappapi.index',
    '3': 'appapi'
};

let enableVerifyTimeSign = false;
let headers = {
    'User-Agent': 'okhttp/3.10.0',
    'app-user-device-id': '291b226282010337c9443590d6457be15',
    'app-version-code': '112'
};

let parseMap = {};
let homeVods = [];
let Searchstatus = false;
let searchApiSuffix = '';
let souParamName = '';
let souSalt = '';
let extraSearchHeaders = {};
let initSuffix = 'init';
let hasCustomInit = false;
let thirdDanmuBaseUrl = '';
let customPlayUa = '';
let forceVerifyCode = null;

const PAGE_SIZE = 30;

function logErr(tag, e) {
    const msg = e && e.message ? e.message : String(e);
    console.log('[lanying] ' + tag + '失败: ' + msg);
}

let request = async (reqUrl, data, header, method) => {
    let finalHeaders = Object.assign({}, headers);
    if (enableVerifyTimeSign) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        finalHeaders['app-api-verify-time'] = timestamp;
        finalHeaders['app-api-verify-sign'] = aesEncode(timestamp, key, iv);
    }
    if (header) {
        finalHeaders = Object.assign(finalHeaders, header);
    }
    const res = await httpRequest(reqUrl, {
        method: method || 'get',
        data: data || '',
        headers: finalHeaders,
        postType: method === 'post' ? 'form' : '',
        timeout: 10000
    });
    return res && res.content !== undefined ? res.content : '';
};

let request_text = async (reqUrl, data, header, method, tobase64) => {
    let finalHeaders = Object.assign({}, headers);
    if (enableVerifyTimeSign) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        finalHeaders['app-api-verify-time'] = timestamp;
        finalHeaders['app-api-verify-sign'] = aesEncode(timestamp, key, iv);
    }
    if (header) {
        finalHeaders = Object.assign(finalHeaders, header);
    }
    const optObj = {
        headers: finalHeaders,
        method: method || 'get',
        data: method === 'post' ? data : undefined,
        postType: method === 'post' ? (data ? 'raw' : 'form') : undefined,
        timeout: 10000
    };
    if (tobase64) optObj.buffer = 2;
    const res = await httpRequest(reqUrl, optObj);
    return res && res.content !== undefined ? res.content : '';
};

async function init(cfg) {
    cfg = cfg || {};
    siteKey = cfg.skey || '';
    siteType = cfg.stype || 3;
    if (!cfg.ext) return;

    let extObj;
    if (typeof cfg.ext === 'string') {
        try {
            extObj = JSON.parse(cfg.ext);
        } catch (e) {
            throw new Error('ext 不是合法 JSON: ' + e.message);
        }
    } else if (typeof cfg.ext === 'object' && cfg.ext !== null) {
        extObj = cfg.ext;
    } else {
        return;
    }

    if (extObj.init && typeof extObj.init === 'string' && extObj.init.startsWith('V')) {
        initSuffix = 'init' + extObj.init;
        hasCustomInit = true;
    }
    if (extObj.time !== undefined) {
        const timeVal = String(extObj.time);
        enableVerifyTimeSign = (timeVal === '1' || timeVal === 'true');
    }
    if (extObj.code !== undefined) {
        forceVerifyCode = String(extObj.code).trim();
    }
    if (extObj.ua2 !== undefined) {
        customPlayUa = String(extObj.ua2).trim();
    }
    if (extObj.head && typeof extObj.head === 'string') {
        const items = extObj.head.split(',');
        for (let i = 0; i < items.length; i++) {
            const trimmed = items[i].trim();
            if (!trimmed) continue;
            const colonIndex = trimmed.indexOf(':');
            if (colonIndex > 0) {
                const hKey = trimmed.substring(0, colonIndex).trim();
                const hValue = trimmed.substring(colonIndex + 1).trim();
                if (hKey && hValue) headers[hKey] = hValue;
            }
        }
    }

    let host = extObj.host || '';
    if (host) {
        // host 可以传一个 txt，里面写多行地址，取第一条
        if (host.startsWith('http') && (host.endsWith('.txt') || host.endsWith('.json'))) {
            const response = await request(host, null, headers, 'get');
            const urls = String(response).split('\n')
                .map(function (line) { return line.trim(); })
                .filter(function (line) { return line && line.startsWith('http'); });
            if (urls.length > 0) host = urls[0];
        }
        siteUrl = String(host).replace(/\/+$/, '');
        if (siteUrl.indexOf('php') === -1) siteUrl += '/api.php';
    }

    key = extObj.key || '';
    // 兼容大小写两种写法：原来写 "Iv" 时只有在 key===iv 的情况下才碰巧能用
    iv = extObj.iv || extObj.Iv || key;

    if (extObj.api && prefixMap[extObj.api]) {
        apiPrefix = prefixMap[extObj.api];
    }
    if (extObj.version) headers['app-version-code'] = String(extObj.version);
    if (extObj.id) headers['app-user-device-id'] = extObj.id;
    if (extObj.token) headers['app-user-token'] = extObj.token;
    if (extObj.ua) headers['User-Agent'] = extObj.ua;

    if (!siteUrl) throw new Error('ext.host 为空，无法确定站点地址');
    if (!key) throw new Error('ext.key 为空，无法解密接口数据');
}

function processSignatureValue(sig) {
    if (sig.length < 8) {
        return sig.split('').reverse().join('');
    }
    const rear = sig.slice(-8).split('').reverse().join('');
    const front = sig.slice(0, -8).split('').reverse().join('');
    return front + rear;
}

async function home(filter) {
    try {
        const initUrl = siteUrl + '/' + apiPrefix + '/' + initSuffix;
        const raw = await request(initUrl);
        let outer;
        try {
            outer = JSON.parse(raw);
        } catch (e) {
            throw new Error('初始化接口返回的不是 JSON（可能地址或 api 参数不对）');
        }
        if (!outer || !outer.data) {
            throw new Error('初始化接口无 data 字段：' + String(outer && outer.msg || '').slice(0, 60));
        }
        const data = JSON.parse(aesDecode(outer.data, key, iv));

        // ---- 第三方弹幕地址 ----
        let rawDanmuUrl = data.config ? data.config.third_danmu_url : '';
        if (Array.isArray(rawDanmuUrl)) {
            for (let i = 0; i < rawDanmuUrl.length; i++) {
                const u = rawDanmuUrl[i];
                if (u && typeof u === 'string' && u.trim()) { rawDanmuUrl = u; break; }
            }
            if (Array.isArray(rawDanmuUrl)) rawDanmuUrl = '';
        } else if (typeof rawDanmuUrl !== 'string') {
            rawDanmuUrl = '';
        }
        if (rawDanmuUrl) {
            thirdDanmuBaseUrl = rawDanmuUrl.trim();
            if (!/[?&]url=$/.test(thirdDanmuBaseUrl.toLowerCase())) {
                thirdDanmuBaseUrl += thirdDanmuBaseUrl.indexOf('?') > -1 ? '&url=' : '?url=';
            }
        } else {
            thirdDanmuBaseUrl = 'https://dmku.hls.one/?ac=dm&url=';
        }

        // ---- box_config：搜索参数/签名盐 ----
        if (data.box_config) {
            const swappedKey = key.split('').reverse().join('');
            const dynamicIv = md5(swappedKey).substring(0, 16);
            const boxJson = JSON.parse(aesDecode(data.box_config, swappedKey, dynamicIv));
            if (boxJson.search_name) searchApiSuffix = boxJson.search_name;
            if (boxJson.signature_name && boxJson.signature_value) {
                souParamName = boxJson.signature_name;
                souSalt = processSignatureValue(boxJson.signature_value);
            }
            if (boxJson.api_header && boxJson.api_header.key && boxJson.api_header.value) {
                extraSearchHeaders[boxJson.api_header.key] = boxJson.api_header.value;
            }
        } else {
            searchApiSuffix = 'searchList';
            souParamName = '';
            souSalt = '';
        }

        Searchstatus = (data.config && data.config.system_search_verify_status) || false;

        // ---- 分类 + 筛选 ----
        const filters = {};
        const classes = [];
        homeVods = [];

        const typeList = data.type_list || [];
        for (let i = 0; i < typeList.length; i++) {
            const item = typeList[i];
            if (item.type_id > 0 && Array.isArray(item.recommend_list)) {
                homeVods = homeVods.concat(item.recommend_list);
            }
            classes.push({ type_id: item.type_id, type_name: item.type_name });

            const filterList = [];
            const ftl = item.filter_type_list || [];
            for (let j = 0; j < ftl.length; j++) {
                const f = ftl[j];
                const nameMap = { class: '分类', area: '区域', lang: '语言', year: '年份', sort: '排序' };
                if (!nameMap[f.name]) continue;
                const values = (f.list || []).map(function (v) { return { v: v, n: v }; });
                filterList.push({ name: nameMap[f.name], key: f.name, value: values });
            }
            if (filterList.length > 0) filters[item.type_id] = filterList;
        }

        return JSON.stringify({ 'class': classes, 'filters': filters });
    } catch (e) {
        logErr('home', e);
        throw e;
    }
}

async function homeVod() {
    return JSON.stringify({ list: homeVods });
}

async function category(tid, pg, filter, extend) {
    try {
        if (!pg || pg <= 0) pg = 1;
        const ext = extend || {};
        const url = siteUrl + '/' + apiPrefix + '/typeFilterVodList';
        const params = {
            'area': ext['area'] || '全部',
            'sort': ext['sort'] || '最新',
            'class': ext['class'] || '全部',
            'type_id': tid,
            'year': ext['year'] || '全部',
            'lang': ext['lang'] || '全部',
            'page': pg
        };
        const raw = await request(url, params, '', 'post');
        const outer = JSON.parse(raw);
        if (!outer || !outer.data) {
            return JSON.stringify({ page: pg, pagecount: pg, list: [] });
        }
        const decoded = JSON.parse(aesDecode(outer.data, key, iv));
        const videos = decoded.recommend_list || [];
        // 服务端不返回总页数，且每页固定 30 条：本页满则允许翻下一页
        const pagecount = videos.length >= PAGE_SIZE ? pg + 1 : pg;
        return JSON.stringify({ page: pg, pagecount: pagecount, list: videos });
    } catch (e) {
        logErr('category', e);
        throw e;
    }
}

async function detail(id) {
    try {
        const url = siteUrl + '/' + apiPrefix + '/vodDetail';
        const resp = await request(url, { vod_id: id }, '', 'post');
        const jsonResp = JSON.parse(resp);
        if (!jsonResp || !jsonResp.data) {
            throw new Error('详情接口无数据' + (jsonResp && jsonResp.msg ? '：' + jsonResp.msg : ''));
        }
        const info = JSON.parse(aesDecode(jsonResp.data, key, iv));
        if (!info || !info.vod) {
            // 列表里会混进一些暂时下架的条目，返回空列表比抛异常体验好
            return JSON.stringify({ list: [] });
        }

        const videos = {
            vod_id: info.vod.vod_id,
            vod_name: info.vod.vod_name,
            vod_area: info.vod.vod_area,
            vod_director: info.vod.vod_director,
            vod_actor: info.vod.vod_actor,
            vod_pic: info.vod.vod_pic,
            vod_content: info.vod.vod_content,
            type_name: info.vod.vod_class,
            vod_year: info.vod.vod_year
        };

        const sourceList = info.vod_play_list || [];
        let playSources = sourceList.map(function (item) {
            const playerInfo = item.player_info || {};
            const parse = playerInfo.parse || '';
            const ua = playerInfo.user_agent || customPlayUa || '';
            const nameUrls = (item.urls || []).map(function (item2) {
                const name = item2.name === undefined ? '' : item2.name;
                const url = item2.url === undefined ? '' : item2.url;
                const token = item2.token === undefined ? '' : item2.token;
                const parseApiUrl = item2.parse_api_url === undefined ? '' : item2.parse_api_url;
                const nid = item2.nid === undefined ? 1 : item2.nid;
                return name + '$' + url + '@@' + parse + '@@' + token + '@@' + parseApiUrl + '@@' + ua + '@@' + info.vod.vod_id + '@@' + nid;
            }).join('#');
            return { show: playerInfo.show || 'Unknown', urls: nameUrls };
        });

        // 重名线路加序号：蓝光、蓝光2、蓝光3...
        const showCount = {};
        playSources = playSources.map(function (source) {
            let showName = source.show;
            if (showCount[showName]) {
                showCount[showName]++;
                showName = showName + showCount[showName];
            } else {
                showCount[showName] = 1;
            }
            return { show: showName, urls: source.urls };
        });

        // 去掉“蓝光”线路：该线路经常解析出空地址，播放器默认选中会黑屏
        // 若过滤后一条不剩（个别影片只有蓝光），则保留原列表，避免完全无法播放
        const noBluRay = playSources.filter(function (source) {
            return String(source.show).indexOf('蓝光') === -1;
        });
        if (noBluRay.length > 0) playSources = noBluRay;

        const priority = function (show) {
            if (show.indexOf('4k') > -1) return 1;
            if (show.indexOf('独家') > -1) return 3;
            if (show.indexOf('秒播') > -1) return 4;
            if (show.indexOf('自建') > -1) return 5;
            if (show.indexOf('专线') > -1) return 7;
            return 8;
        };
        playSources.sort(function (a, b) {
            return priority(a.show.toLowerCase()) - priority(b.show.toLowerCase());
        });

        videos.vod_play_from = playSources.map(function (s) { return s.show; }).join('$$$');
        videos.vod_play_url = playSources.map(function (s) { return s.urls; }).join('$$$');

        return JSON.stringify({ list: [videos] });
    } catch (e) {
        logErr('detail', e);
        throw e;
    }
}

async function play(flag, id, flags) {
    const parts = String(id).split('@@');
    const playUrl = parts[0];
    const parse = parts[1] || '';
    const token = parts[2] || '';
    const parse_api_url = parts[3] || '';
    const ua = parts[4] || '';
    const vodId = parts[5] || '';
    const nidStr = parts[6] || '1';

    // 弹幕失败不能影响播放，整段独立捕获
    let danmakuUrl = '';
    try {
        if (thirdDanmuBaseUrl && vodId) {
            let nid = parseInt(nidStr, 10);
            if (isNaN(nid) || nid < 1) nid = 1;
            const danmuRet = await request(siteUrl + '/' + apiPrefix + '/danmuList', {
                url_position: String(nid - 1),
                vod_id: vodId
            }, '', 'post');
            const danmuResponse = JSON.parse(danmuRet);
            if (danmuResponse && danmuResponse.data) {
                const decryptedDanmu = JSON.parse(aesDecode(danmuResponse.data, key, iv));
                if (decryptedDanmu && decryptedDanmu.official_url) {
                    const realDanmuUrl = thirdDanmuBaseUrl + decryptedDanmu.official_url;
                    if (typeof js2Proxy === 'function') {
                        danmakuUrl = js2Proxy(false, siteType, siteKey || '', encodeURIComponent(realDanmuUrl), headers);
                    }
                }
            }
        }
    } catch (e) {
        console.log('[lanying] 弹幕获取失败（忽略）: ' + (e && e.message ? e.message : e));
    }

    const withHeader = function (obj) {
        if (ua) obj.header = { 'User-Agent': ua };
        return obj;
    };

    // 1) 本身就是直链
    if ((playUrl.indexOf('http://') > -1 || playUrl.indexOf('https://') > -1) &&
        (playUrl.indexOf('m3u8') > -1 || playUrl.indexOf('mp4') > -1 || playUrl.indexOf('mkv') > -1) &&
        !parse_api_url) {
        return JSON.stringify(withHeader({ parse: 0, url: playUrl, danmaku: danmakuUrl }));
    }

    // 2) parse 字段本身就是解析接口地址
    if (parse.indexOf('http') === 0) {
        let parseUrl = parse + playUrl;
        if (token) parseUrl += '&token=' + token;
        const requestHeaders = ua ? { 'User-Agent': ua } : {};
        const rets = await request(parseUrl, null, requestHeaders, 'get');
        if (String(rets).indexOf('DOCTYPE html') > -1) {
            return JSON.stringify(withHeader({ parse: 1, url: parseUrl, danmaku: danmakuUrl }));
        }
        let parsedUrl = '';
        try {
            const parseJson = JSON.parse(rets);
            parsedUrl = parseJson.url || (parseJson.data && parseJson.data.url) || '';
        } catch (e) {
            throw new Error('解析接口返回的不是 JSON');
        }
        return JSON.stringify(withHeader({ parse: 0, url: parsedUrl, danmaku: danmakuUrl }));
    }

    // 3) 走站点自己的 vodParse
    const params = {
        'parse_api': parse,
        'url': aesEncode(playUrl, key, iv),
        'token': token
    };
    const requestHeaders = ua ? { 'User-Agent': ua } : {};
    const rets = await request(siteUrl + '/' + apiPrefix + '/vodParse', params, requestHeaders, 'post');
    const retJson = JSON.parse(rets);
    if (!retJson || !retJson.data) {
        throw new Error('解析接口无返回' + (retJson && retJson.msg ? '：' + retJson.msg : ''));
    }
    const parsed = JSON.parse(aesDecode(retJson.data, key, iv));
    let finalPlayUrl = '';
    try {
        const inner = typeof parsed.json === 'string' ? JSON.parse(parsed.json) : parsed.json;
        finalPlayUrl = (inner && inner.url) || '';
    } catch (e) {
        finalPlayUrl = '';
    }
    if (!finalPlayUrl) {
        throw new Error('解析结果里没有播放地址（该线路可能已失效，换一条试试）');
    }
    return JSON.stringify(withHeader({ parse: 0, url: finalPlayUrl, danmaku: danmakuUrl }));
}

async function search(wd, quick, pg) {
    if (hasCustomInit) {
        await home({});
    }
    const searchPath = searchApiSuffix || 'searchList';
    const url = siteUrl + '/' + apiPrefix + '/' + searchPath;
    let videos = [];
    let attemptedCaptcha = false;
    let attemptedSlider = false;
    let sliderVerified = false;

    const params = { 'page': '1', 'type_id': '0', 'keywords': wd };

    if (souParamName && souSalt) {
        const currentTimestamp = Math.floor(Date.now() / 1000).toString();
        const md5Value = md5('/' + souParamName + '-' + currentTimestamp + '-sb-0-' + souSalt);
        params[souParamName] = currentTimestamp + '-sb-0-' + md5Value;
    }

    const searchHeaders = Object.assign({}, headers, extraSearchHeaders);
    if (forceVerifyCode) {
        params['code'] = forceVerifyCode;
        params['key'] = generateUUID();
    }

    const maxWaitRetries = 2;
    let waitRetryCount = 0;
    let loops = 0;

    while (loops++ < 6) {
        let response;
        try {
            response = JSON.parse(await request(url, params, searchHeaders, 'post'));
        } catch (e) {
            throw new Error('搜索接口返回异常: ' + (e && e.message ? e.message : e));
        }
        if (!response) break;

        // 滑块验证
        if (response.code === 1001 && response.need_slider === true && !attemptedSlider) {
            attemptedSlider = true;
            try {
                const sliderJson = JSON.parse(await request(siteUrl + '/' + apiPrefix + '/getSlider', {}, searchHeaders, 'post'));
                if (sliderJson && sliderJson.code === 1 && sliderJson.data) {
                    const sliderData = JSON.parse(aesDecode(sliderJson.data, key, iv));
                    const sliderId = sliderData.slider_id || '';
                    const targetX = parseInt(sliderData.target_x) || 0;
                    if (sliderId && targetX > 0) {
                        let posX = targetX + Math.floor(Math.random() * 3) - 1;
                        const maxX = sliderData.bg_width || 280;
                        if (posX < 1) posX = 1;
                        if (posX > maxX) posX = maxX;
                        const timestamp = Date.now();
                        await new Promise(function (r) { setTimeout(r, 1000); });
                        const verifyJson = JSON.parse(await request(siteUrl + '/' + apiPrefix + '/verifySlider', {
                            pos_x: posX.toString(),
                            slider_id: sliderId,
                            timestamp: timestamp.toString()
                        }, searchHeaders, 'post'));
                        if (verifyJson && verifyJson.code === 1 && verifyJson.data) {
                            const verifyResult = JSON.parse(aesDecode(verifyJson.data, key, iv));
                            if (verifyResult && verifyResult.verified === true) {
                                sliderVerified = true;
                                continue;
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('[lanying] 滑块验证失败（忽略）: ' + (e && e.message ? e.message : e));
            }

            if (!sliderVerified) {
                if (!forceVerifyCode && (Searchstatus || (response.code === 0 && response.msg && response.msg.indexOf('验证码') > -1))) {
                    if (attemptedCaptcha) break;
                    attemptedCaptcha = true;
                    const ok = await fillCaptcha(params);
                    if (!ok) break;
                    continue;
                }
                break;
            }
        }

        // 频率限制：等一会儿再试
        if (response.code === 0 &&
            (!response.data || response.data.length === 0) &&
            response.msg &&
            /等.*秒|等待.*秒|等|搜|请等待|稍等|稍候/i.test(response.msg)) {
            if (waitRetryCount >= maxWaitRetries) break;
            let waitSeconds = extractWaitTime(response.msg);
            if (waitSeconds < 1) waitSeconds = 2;
            if (waitSeconds > 30) waitSeconds = 30;
            await new Promise(function (r) { setTimeout(r, (waitSeconds + 1) * 1000); });
            waitRetryCount++;
            continue;
        }

        if (response.data && response.data.length > 0) {
            const decodedData = JSON.parse(aesDecode(response.data, key, iv));
            videos = decodedData.search_list || [];
            break;
        }

        if (!forceVerifyCode && (Searchstatus || (response.code === 0 && response.msg && response.msg.indexOf('验证码') > -1))) {
            if (attemptedCaptcha) break;
            attemptedCaptcha = true;
            const ok = await fillCaptcha(params);
            if (!ok) break;
            continue;
        }
        break;
    }

    return JSON.stringify({ list: videos });
}

/** 走远端 OCR 填验证码；失败返回 false，避免无限重试 */
async function fillCaptcha(params) {
    try {
        const uuid = generateUUID();
        const verifyBase = apiPrefix.replace('.index', '');
        const verifyUrl = siteUrl + '/' + verifyBase + '.verify/create?key=' + uuid;
        let base64Img = await request_text(verifyUrl, null, headers, 'get', true);
        base64Img = String(base64Img).replace(/\n/g, '');
        const ocrResult = await request_text('https://api.nn.ci/ocr/b64/text', base64Img, { 'User-Agent': 'okhttp/3.10.0' }, 'post');
        const code = String(ocrResult || '').trim();
        if (!code) return false;
        params['code'] = code;
        params['key'] = uuid;
        return true;
    } catch (e) {
        console.log('[lanying] 验证码识别失败: ' + (e && e.message ? e.message : e));
        return false;
    }
}

function generateUUID() {
    const chars = '0123456789abcdef';
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return chars[v];
    });
}

function chineseToNumber(chineseStr) {
    const m = {
        '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2,
        '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5,
        '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8,
        '九': 9, '玖': 9, '十': 10, '拾': 10
    };
    if (chineseStr.length === 1) return m[chineseStr] || 2;
    if (chineseStr.startsWith('十') && chineseStr.length === 2) {
        const u = m[chineseStr[1]];
        return u ? 10 + u : 10;
    }
    if (chineseStr.endsWith('十') && chineseStr.length === 2) {
        const t = m[chineseStr[0]];
        return t ? t * 10 : 10;
    }
    if (chineseStr.length === 3 && chineseStr.indexOf('十') > -1) {
        const t = m[chineseStr[0]];
        const u = m[chineseStr[2]];
        return t && u ? t * 10 + u : (t ? t * 10 : 10);
    }
    return 2;
}

function extractWaitTime(message) {
    const digitMatch = message.match(/(\d+)\s*秒/);
    if (digitMatch && digitMatch[1]) return parseInt(digitMatch[1], 10);
    const chineseMatch = message.match(/([零一二三四五六七八九十两壹贰叁肆伍陆柒捌玖拾〇]+)\s*秒/);
    if (chineseMatch && chineseMatch[1]) return chineseToNumber(chineseMatch[1]);
    if (/几秒|数秒|若干秒/i.test(message)) return 3;
    return 2;
}

/* ---------------------- 六、弹幕代理（可选能力） ---------------------- */

function hexToDec(hex) {
    hex = String(hex || '#FFFFFF').replace(/^#/, '').toUpperCase();
    if (hex.length !== 6) {
        while (hex.length < 6) hex += '0';
        hex = hex.slice(0, 6);
    }
    return parseInt(hex, 16);
}

function escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function jsonDanmakuToXml(json) {
    if (!json || !json.danmuku || !Array.isArray(json.danmuku)) {
        return '<?xml version="1.0" encoding="utf-8"?><i><code>0</code><id>error_no_danmaku</id></i>';
    }
    const lines = [];
    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<i>');
    lines.push(' <code>' + (json.code || 0) + '</code>');
    lines.push(' <id>' + escapeXml(json.name || '12345') + '</id>');
    const positionMap = { 'top': 5, 'right': 1, 'bottom': 4, 'left': 6, 'scroll': 1 };
    json.danmuku.forEach(function (danmu) {
        if (!Array.isArray(danmu) || danmu.length < 5) return;
        const time = danmu[0] === undefined ? 0 : danmu[0];
        const mode = danmu[1] === undefined ? 'scroll' : danmu[1];
        const text = danmu[4] === undefined ? '' : danmu[4];
        const fontSize = danmu[7] === undefined ? '24px' : danmu[7];
        const colorHex = '#' + Array(6).fill(0).map(function () {
            return '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
        }).join('');
        const pos = positionMap[mode] || 1;
        const colorDec = hexToDec(colorHex);
        const fs = parseInt(String(fontSize).replace(/px/gi, '')) || 24;
        const p = Number(time).toFixed(3) + ',' + pos + ',' + fs + ',' + colorDec + ',,,,,';
        lines.push(' <d p="' + p + '">' + escapeXml(text) + '</d>');
    });
    lines.push('</i>');
    return lines.join('\n');
}

async function proxy(params) {
    const jsonUrl = decodeURIComponent(params.url || params[0] || params.danmaku || '');
    if (!jsonUrl || jsonUrl.indexOf('http') !== 0) {
        return JSON.stringify({
            code: 400,
            content: '缺少有效的弹幕 URL',
            headers: { 'Content-Type': 'text/plain' }
        });
    }
    const jsonContent = await request_text(jsonUrl, null, headers, 'get');
    const xmlContent = jsonDanmakuToXml(JSON.parse(jsonContent));
    return JSON.stringify({
        code: 200,
        content: xmlContent,
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'Cache-Control': 'no-cache'
        }
    });
}

export function __jsEvalReturn() {
    return {
        init: init,
        home: home,
        homeVod: homeVod,
        category: category,
        detail: detail,
        play: play,
        search: search,
        proxy: proxy
    };
}
