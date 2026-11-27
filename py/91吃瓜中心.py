import json
import re
import sys
import time
import hashlib
from base64 import b64decode, b64encode
from urllib.parse import urlparse

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from pyquery import PyQuery as pq
sys.path.append('..')
from base.spider import Spider as BaseSpider

img_cache = {}

class Spider(BaseSpider):

    # 站点域名，按实测稳定性排序；探测不通会自动切下一个
    DOMAINS = ['https://adopt.ybejhul.com/', 'https://but.ybejhul.com/']
    _good_host = ''       # 最近一次探测成功的域名（类级，进程内复用）
    _good_ts = 0.0
    _html_cache = None    # (host, ts, html)，首页只请求一次
    HOST_TTL = 300        # 成功域名缓存 5 分钟
    PROBE_TIMEOUT = 6     # 单域名探测超时

    def init(self, extend=""):
        try:
            cfg = json.loads(extend) if isinstance(extend, str) and extend.strip() else {}
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}

        # ext 支持 {"host": "https://xxx", "proxy": {"http": "...", "https": "..."}}
        # 同时兼容旧写法：ext 直接就是代理字典 {"http": "...", "https": "..."}
        if 'proxy' in cfg:
            proxy = cfg.get('proxy')
            self.proxies = proxy if isinstance(proxy, dict) else {}
        elif 'http' in cfg or 'https' in cfg:
            self.proxies = {k: v for k, v in (('http', cfg.get('http')), ('https', cfg.get('https'))) if v}
        else:
            self.proxies = {}
        self.forced_host = str(cfg.get('host') or '').strip().rstrip('/')
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
        }
        self.host = self.get_working_host()
        self.headers.update({'Origin': self.host, 'Referer': f"{self.host}/"})
        print(f"使用站点: {self.host}")

    def getName(self):
        return "🌈 91吃瓜中心|终极完美版"

    def isVideoFormat(self, url):
        return any(ext in (url or '') for ext in ['.m3u8', '.mp4', '.ts'])

    def manualVideoCheck(self):
        return False

    def destroy(self):
        global img_cache
        img_cache.clear()

    def get_working_host(self):
        # 1) ext 指定了域名就不探测，避免拖慢 init
        if getattr(self, 'forced_host', ''):
            return self.forced_host + '/'

        # 2) 5 分钟内成功过的域名直接用
        if Spider._good_host and time.time() - Spider._good_ts < self.HOST_TTL:
            return Spider._good_host

        # 3) 依次探测，6 秒超时，失败立刻换下一个
        for url in self.DOMAINS:
            try:
                response = requests.get(url, headers=self.headers, proxies=self.proxies,
                                        timeout=self.PROBE_TIMEOUT)
                if response.status_code == 200:
                    Spider._good_host = url
                    Spider._good_ts = time.time()
                    return url
            except Exception:
                continue

        # 4) 全部失败：优先沿用上次成功的，其次第一个
        return Spider._good_host or self.DOMAINS[0]

    def _alt_host(self):
        cur = self.host.rstrip('/') + '/'
        for url in self.DOMAINS:
            if url != cur:
                return url
        return ''

    def _get(self, url, timeout=12):
        """请求失败时自动切换到备用域名重试一次"""
        try:
            return requests.get(url, headers=self.headers, proxies=self.proxies, timeout=timeout)
        except Exception:
            old = self.host.rstrip('/')
            alt = self._alt_host()
            if not alt:
                raise
            alt = alt.rstrip('/')
            Spider._good_host = alt + '/'
            Spider._good_ts = time.time()
            self.host = alt
            self.headers.update({'Origin': alt, 'Referer': f"{alt}/"})
            print(f"切换站点: {old} -> {alt}")
            return requests.get(url.replace(old, alt, 1), headers=self.headers,
                                proxies=self.proxies, timeout=timeout)

    def _home_html(self, timeout=12):
        """首页 HTML 缓存 2 分钟，homeContent 与 homeVideoContent 共用一次请求"""
        cache = Spider._html_cache
        if cache and cache[0] == self.host and time.time() - cache[1] < 120:
            return cache[2]
        response = self._get(self.host, timeout=timeout)
        if response.status_code != 200:
            return ''
        Spider._html_cache = (self.host, time.time(), response.text)
        return response.text

    def homeContent(self, filter):
        try:
            text = self._home_html()
            if not text: return {'class': [], 'list': []}
            data = self.getpq(text)
            
            classes = []
            category_selectors = ['.category-list ul li', '.nav-menu li', '.menu li', 'nav ul li']
            for selector in category_selectors:
                for k in data(selector).items():
                    link = k('a')
                    href = (link.attr('href') or '').strip()
                    name = (link.text() or '').strip()
                    if not href or href == '#' or not name: continue
                    classes.append({'type_name': name, 'type_id': href})
                if classes: break
            
            if not classes:
                classes = [{'type_name': '最新', 'type_id': '/latest/'}, {'type_name': '热门', 'type_id': '/hot/'}]
            
            return {'class': classes, 'list': self.getlist(data('#index article, article'))}
        except Exception as e:
            return {'class': [], 'list': []}

    def homeVideoContent(self):
        try:
            text = self._home_html()
            if not text: return {'list': []}
            return {'list': self.getlist(self.getpq(text)('#index article, article'))}
        except Exception as e:
            return {'list': []}

    def categoryContent(self, tid, pg, filter, extend):
        try:
            if '@folder' in tid:
                v = self.getfod(tid.replace('@folder', ''))
                return {'list': v, 'page': 1, 'pagecount': 1, 'limit': 90, 'total': len(v)}
            
            pg = int(pg) if pg else 1
            
            if tid.startswith('http'):
                base_url = tid.rstrip('/')
            else:
                path = tid if tid.startswith('/') else f"/{tid}"
                base_url = f"{self.host}{path}".rstrip('/')
            
            if pg == 1:
                url = f"{base_url}/"
            else:
                url = f"{base_url}/{pg}/"
                
            response = self._get(url, timeout=12)
            if response.status_code != 200: return {'list': [], 'page': pg, 'pagecount': 9999, 'limit': 90, 'total': 0}
                
            data = self.getpq(response.text)
            videos = self.getlist(data('#archive article, #index article, article'), tid)
            
            return {'list': videos, 'page': pg, 'pagecount': 9999, 'limit': 90, 'total': 999999}
        except Exception as e:
            return {'list': [], 'page': pg, 'pagecount': 9999, 'limit': 90, 'total': 0}

    def detailContent(self, ids):
        try:
            url = ids[0] if ids[0].startswith('http') else f"{self.host}{ids[0]}"
            response = self._get(url, timeout=12)
            data = self.getpq(response.text)
            
            plist = []
            used_names = set()
            if data('.dplayer'):
                for c, k in enumerate(data('.dplayer').items(), start=1):
                    try:
                        config_attr = k.attr('data-config')
                        if config_attr:
                            config = json.loads(config_attr)
                            video_url = config.get('video', {}).get('url', '')
                            
                            if video_url:
                                ep_name = ''
                                parent = k.parents().eq(0)
                                for _ in range(4):
                                    if not parent: break
                                    heading = parent.find('h2, h3, h4').eq(0).text().strip()
                                    if heading:
                                        ep_name = heading
                                        break
                                    parent = parent.parents().eq(0)
                                
                                base_name = ep_name if ep_name else f"视频{c}"
                                name = base_name
                                count = 2
                                while name in used_names:
                                    name = f"{base_name} {count}"
                                    count += 1
                                used_names.add(name)
                                
                                plist.append(f"{name}${video_url}")
                    except: continue
            
            if not plist:
                content_area = data('.post-content, article')
                for i, link in enumerate(content_area('a').items(), start=1):
                    link_text = link.text().strip()
                    link_href = link.attr('href')
                    
                    if link_href and any(kw in link_text for kw in ['点击观看', '观看', '播放', '视频', '第一弹', '第二弹', '第三弹', '第四弹', '第五弹', '第六弹', '第七弹', '第八弹', '第九弹', '第十弹']):
                        ep_name = link_text.replace('点击观看：', '').replace('点击观看', '').strip()
                        if not ep_name: ep_name = f"视频{i}"
                        
                        if not link_href.startswith('http'):
                            link_href = f"{self.host}{link_href}" if link_href.startswith('/') else f"{self.host}/{link_href}"
                        
                        plist.append(f"{ep_name}${link_href}")
            
            play_url = '#'.join(plist) if plist else f"未找到视频源${url}"
            
            vod_content = ''
            try:
                tags = []
                seen_names = set()
                seen_ids = set()
                
                tag_links = data('.tags a, .keywords a, .post-tags a')
                
                candidates = []
                for k in tag_links.items():
                    title = k.text().strip()
                    href = k.attr('href')
                    if title and href:
                        candidates.append({'name': title, 'id': href})
                
                candidates.sort(key=lambda x: len(x['name']), reverse=True)
                
                for item in candidates:
                    name = item['name']
                    id_ = item['id']
                    
                    if id_ in seen_ids: continue
                    
                    is_duplicate = False
                    for seen in seen_names:
                        if name in seen:
                            is_duplicate = True
                            break
                    
                    if not is_duplicate:
                        target = json.dumps({'id': id_, 'name': name})
                        tags.append(f'[a=cr:{target}/]{name}[/a]')
                        seen_names.add(name)
                        seen_ids.add(id_)
                
                if tags:
                    vod_content = ' '.join(tags)
                else:
                    vod_content = data('.post-title').text()
            except Exception:
                vod_content = '获取标签失败'

            if not vod_content:
                vod_content = data('h1').text() or '91吃瓜中心'

            return {'list': [{'vod_play_from': '91吃瓜中心', 'vod_play_url': play_url, 'vod_content': vod_content}]}
        except:
            return {'list': [{'vod_play_from': '91吃瓜中心', 'vod_play_url': '获取失败'}]}

    def searchContent(self, key, quick, pg="1"):
        try:
            pg = int(pg) if pg else 1
            
            if pg == 1:
                url = f"{self.host}/search/{key}/"
            else:
                url = f"{self.host}/search/{key}/{pg}/"
            
            response = self._get(url, timeout=12)
            return {'list': self.getlist(self.getpq(response.text)('article')), 'page': pg, 'pagecount': 9999}
        except:
            return {'list': [], 'page': pg, 'pagecount': 9999}

    def playerContent(self, flag, id, vipFlags):
        parse = 0 if self.isVideoFormat(id) else 1
        url = self.proxy(id) if '.m3u8' in id else id
        return {'parse': parse, 'url': url, 'header': self.headers}

    def localProxy(self, param):
        try:
            type_ = param.get('type')
            url = param.get('url')
            if type_ == 'cache':
                key = param.get('key')
                if content := img_cache.get(key):
                    return [200, 'image/jpeg', content]
                return [404, 'text/plain', b'Expired']
            elif type_ == 'img':
                real_url = self.d64(url) if not url.startswith('http') else url
                res = requests.get(real_url, headers=self.headers, proxies=self.proxies, timeout=10)
                content = self.aesimg(res.content)
                return [200, 'image/jpeg', content]
            elif type_ == 'm3u8':
                return self.m3Proxy(url)
            else:
                return self.tsProxy(url)
        except:
            return [404, 'text/plain', b'']

    def proxy(self, data, type='m3u8'):
        if data and self.proxies: return f"{self.getProxyUrl()}&url={self.e64(data)}&type={type}"
        return data

    def m3Proxy(self, url):
        url = self.d64(url)
        res = requests.get(url, headers=self.headers, proxies=self.proxies)
        data = res.text
        base = res.url.rsplit('/', 1)[0]
        lines = []
        for line in data.split('\n'):
            if '#EXT' not in line and line.strip():
                if not line.startswith('http'):
                    line = f"{base}/{line}"
                lines.append(self.proxy(line, 'ts'))
            else:
                lines.append(line)
        return [200, "application/vnd.apple.mpegurl", '\n'.join(lines)]

    def tsProxy(self, url):
        return [200, 'video/mp2t', requests.get(self.d64(url), headers=self.headers, proxies=self.proxies).content]

    def e64(self, text):
        return b64encode(str(text).encode()).decode()

    def d64(self, text):
        return b64decode(str(text).encode()).decode()

    def aesimg(self, data):
        if len(data) < 16: return data
        keys = [(b'f5d965df75336270', b'97b60394abc2fbe1'), (b'75336270f5d965df', b'abc2fbe197b60394')]
        for k, v in keys:
            try:
                dec = unpad(AES.new(k, AES.MODE_CBC, v).decrypt(data), 16)
                if dec.startswith(b'\xff\xd8') or dec.startswith(b'\x89PNG'): return dec
            except: pass
            try:
                dec = unpad(AES.new(k, AES.MODE_ECB).decrypt(data), 16)
                if dec.startswith(b'\xff\xd8'): return dec
            except: pass
        return data

    def getlist(self, data, tid=''):
        videos = []
        is_folder = '/mrdg' in (tid or '')
        for k in data.items():
            card_html = k.outer_html() if hasattr(k, 'outer_html') else str(k)
            a = k if k.is_('a') else k('a').eq(0)
            href = a.attr('href')
            title = k('h2').text() or k('.entry-title').text() or k('.post-title').text()
            if not title and k.is_('a'): title = k.text()
            
            if href and title:
                img = self.getimg(k('script').text(), k, card_html)
                videos.append({
                    'vod_id': f"{href}{'@folder' if is_folder else ''}",
                    'vod_name': title.strip(),
                    'vod_pic': img,
                    'vod_remarks': k('time').text() or '',
                    'vod_tag': 'folder' if is_folder else '',
                    'style': {"type": "rect", "ratio": 1.33}
                })
        return videos

    def getfod(self, id):
        url = f"{self.host}{id}"
        data = self.getpq(self._get(url, timeout=12).text)
        videos = []
        for i, h2 in enumerate(data('.post-content h2').items()):
            p_txt = data('.post-content p').eq(i * 2)
            p_img = data('.post-content p').eq(i * 2 + 1)
            p_html = p_img.outer_html() if hasattr(p_img, 'outer_html') else str(p_img)
            videos.append({
                'vod_id': p_txt('a').attr('href'),
                'vod_name': p_txt.text().strip(),
                'vod_pic': self.getimg('', p_img, p_html),
                'vod_remarks': h2.text().strip()
            })
        return videos

    def getimg(self, text, elem=None, html_content=None):
        if m := re.search(r"loadBannerDirect\('([^']+)'", text or ''):
            return self._proc_url(m.group(1))
        
        if html_content is None and elem is not None:
             html_content = elem.outer_html() if hasattr(elem, 'outer_html') else str(elem)
        if not html_content: return ''

        html_content = html_content.replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')

        if 'data:image' in html_content:
            m = re.search(r'(data:image/[a-zA-Z0-9+/=;,]+)', html_content)
            if m: return self._proc_url(m.group(1))

        m = re.search(r'(https?://[^"\'\s)]+\.(?:jpg|png|jpeg|webp))', html_content, re.I)
        if m: return self._proc_url(m.group(1))
            
        if 'url(' in html_content:
            m = re.search(r'url\s*\(\s*[\'"]?([^"\'\)]+)[\'"]?\s*\)', html_content, re.I)
            if m: return self._proc_url(m.group(1))
            
        return ''

    def _proc_url(self, url):
        if not url: return ''
        url = url.strip('\'" ')
        if url.startswith('data:'):
            try:
                _, b64_str = url.split(',', 1)
                raw = b64decode(b64_str)
                if not (raw.startswith(b'\xff\xd8') or raw.startswith(b'\x89PNG') or raw.startswith(b'GIF8')):
                    raw = self.aesimg(raw)
                key = hashlib.md5(raw).hexdigest()
                img_cache[key] = raw
                return f"{self.getProxyUrl()}&type=cache&key={key}"
            except: return ""
        if not url.startswith('http'):
            url = f"{self.host}{url}" if url.startswith('/') else f"{self.host}/{url}"
        return f"{self.getProxyUrl()}&url={self.e64(url)}&type=img"

    def getpq(self, data):
        try: return pq(data)
        except: return pq(data.encode('utf-8'))
