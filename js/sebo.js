/**
 * 直播源（自包含改造版）
 * 原版 author：Leospring
 *
 * 改造点（对应“别的壳不能播放”的四条）：
 *  1. 去掉 import 'assets://js/lib/cat.js'
 *     - Crypto / load 原版导入了但全文未使用，直接删掉
 *     - 只用到 _.map 两处，换成原生 Array.map
 *     → 没有 cat.js 的壳（FongMi、精简版、电视定制版）也能加载
 *  2. req() 缺失时自动回退 fetch()，不再直接 ReferenceError
 *  3. detail() 补 vod_id / vod_name / vod_pic
 *     → 部分壳缺这几个字段会丢条目或标题空白
 *  4. play() 补 header(UA)，兼容需要校验 UA 的分线路
 *     → 这个 CDN 实测不校验 Referer，所以不硬塞 Referer，避免触发防盗链
 *
 * 另外补的健壮性：
 *  - init 的 ext 同时支持字符串和对象两种写法，自动补尾部斜杠
 *  - json.txt / 详情解析失败时返回空结构，不再 return null
 *  - 标题里的 $ 和 # 做转义，避免破坏 vod_play_url 的格式
 */

let siteUrl = 'http://api.maiyoux.com:81/mf/';
let siteKey = '';
let siteType = 0;
let cateList = {};
let cateMeta = {};        // address -> { title, pic }

const PLAY_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.101 Mobile Safari/537.36';

/* ---------------- 网络层：req 优先，fetch 兜底 ---------------- */

function formEncode(obj) {
    const parts = [];
    Object.keys(obj || {}).forEach(function (k) {
        const v = obj[k];
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined || v === null ? '' : v));
    });
    return parts.join('&');
}

async function http(url, opt) {
    if (typeof req === 'function') {
        const res = await req(url, opt);
        return res && res.content !== undefined ? res.content : '';
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
                if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
            } else {
                body = opt.data || '';
            }
        } else if (opt.data && typeof opt.data === 'object' && Object.keys(opt.data).length) {
            finalUrl += (url.indexOf('?') > -1 ? '&' : '?') + formEncode(opt.data);
        }
        const res = await fetch(finalUrl, { method: method, headers: hdrs, body: body });
        return await res.text();
    }
    throw new Error('当前运行环境没有 req() 也没有 fetch()，无法发起请求');
}

async function request(reqUrl, postData, post) {
    return await http(reqUrl, {
        method: post ? 'post' : 'get',
        data: postData || {},
        postType: post ? 'form' : '',
        timeout: 15000
    });
}

/* ---------------- 初始化 ---------------- */

async function init(cfg) {
    cfg = cfg || {};
    siteKey = cfg.skey || '';
    siteType = cfg.stype || 0;

    // ext 可能是字符串，也可能被壳解析成了对象
    let ext = cfg.ext;
    if (ext && typeof ext === 'object') {
        ext = ext.url || ext.host || ext.site || '';
    }
    if (ext && typeof ext === 'string' && ext.trim()) {
        let u = ext.trim();
        if (!/\/$/.test(u)) u += '/';
        siteUrl = u;
    }

    const txt = await request(siteUrl + 'json.txt');
    try {
        cateList = JSON.parse(txt);
    } catch (e) {
        cateList = {};
        throw new Error('json.txt 解析失败，站点可能已失效');
    }

    // 建立 address -> 标题/封面 索引，供 detail 补 vod_name / vod_pic
    cateMeta = {};
    Object.keys(cateList).forEach(function (k) {
        const arr = cateList[k];
        if (!Array.isArray(arr)) return;
        arr.forEach(function (it) {
            if (it && it.address) {
                cateMeta[String(it.address)] = { title: it.title || '', pic: it.xinimg || '' };
            }
        });
    });
}

/* ---------------- 分类 ---------------- */

async function home(filter) {
    const classes = [];
    Object.keys(cateList).forEach(function (key) {
        if (!Array.isArray(cateList[key])) return;
        classes.push({
            type_id: key,
            type_name: key
        });
    });
    return JSON.stringify({
        class: classes
        // filters: filterObj
    });
}

async function category(tid, pg, filter, ext) {
    const arr = cateList[tid] || [];
    const videos = arr.map(function (item) {
        return {
            vod_id: item['address'],
            vod_name: item['title'],
            vod_pic: item['xinimg'],
            vod_remarks: item['Number']
        };
    });
    return JSON.stringify({
        list: videos,
        page: pg || 1,
        pagecount: 1,
        total: videos.length
    });
}

/* ---------------- 详情 ---------------- */

async function detail(id) {
    try {
        const key = String(id || '');
        const target = /^https?:\/\//i.test(key) ? key : siteUrl + key;
        const txt = await request(target);
        const data = JSON.parse(txt);
        const res = data['zhubo'] || [];

        const pairs = [];
        res.forEach(function (vod) {
            // 标题里的分隔符要清掉，否则会破坏 name$url#name$url 的结构
            const name = String(vod.title || '').replace(/[$#]/g, ' ');
            const addr = String(vod.address || '').trim();
            if (addr) pairs.push(name + '$' + addr);
        });

        const meta = cateMeta[key] || {};
        const video = {
            vod_id: key,
            vod_name: meta.title || key.replace(/\.txt$/i, ''),
            vod_pic: meta.pic || '',
            vod_play_from: 'Leospring',
            vod_play_url: pairs.join('#'),
            vod_content: '作者：Leospring 公众号：蚂蚁科技杂谈'
        };

        return JSON.stringify({ list: [video] });
    } catch (e) {
        console.log('[sebo] detail 失败:', e && e.message ? e.message : e);
        // 返回空列表，比 return null 更安全（null 会让部分壳直接报错）
        return JSON.stringify({ list: [] });
    }
}

/* ---------------- 播放 ---------------- */

async function play(flag, id, flags) {
    const playUrl = String(id || '').trim();
    return JSON.stringify({
        parse: 0,
        url: playUrl,
        header: {
            'User-Agent': PLAY_UA
        }
    });
}

export function __jsEvalReturn() {
    return {
        init: init,
        home: home,
        category: category,
        detail: detail,
        play: play
    };
}
