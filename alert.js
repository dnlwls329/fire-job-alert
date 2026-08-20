const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SEEN_PATH = path.join(__dirname, 'seen.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_TOTAL = 10;
const SITE_PRIORITY = { 잡코리아: 0, 사람인: 1, 원티드: 2 };

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return {};
  return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf-8'));
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
}

function matchesKeyword(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

// 사람인: loc_mcd=102000(경기 전체), job_type=1(신입) 을 사이트가 직접 걸러줌
async function fetchSaramin(keywords) {
  const results = [];
  const url =
    'https://www.saramin.co.kr/zf_user/search/recruit?searchword=' +
    encodeURIComponent('소방점검') +
    '&loc_mcd=102000&job_type=1';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('.item_recruit').each((_, el) => {
    const a = $(el).find('.job_tit a');
    const title = (a.attr('title') || a.text()).trim();
    const href = a.attr('href');
    if (!title || !href) return;
    if (!matchesKeyword(title, keywords)) return;
    const company = $(el).find('.corp_name a').text().trim();
    const idMatch = href.match(/rec_idx=(\d+)/);
    const id = idMatch ? idMatch[1] : href;
    results.push({
      site: '사람인',
      id: 'saramin_' + id,
      title,
      company,
      link: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=' + id,
    });
  });
  return results;
}

// 잡코리아: careerType=1(신입)은 사이트가 걸러주고, 경기 지역은 목록 텍스트에 "경기"가 있는지로 직접 확인
async function fetchJobKorea(keywords) {
  const results = [];
  const url =
    'https://www.jobkorea.co.kr/Search/?stext=' + encodeURIComponent('소방점검') + '&careerType=1';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const $ = cheerio.load(html);
  const byId = new Map();
  $('a[href*="/Recruit/GI_Read/"]').each((_, el) => {
    const href = $(el).attr('href');
    const idMatch = href.match(/GI_Read\/(\d+)/);
    if (!idMatch) return;
    const id = idMatch[1];
    const text = $(el).text().trim();
    if (!text) return;
    const blockText = $(el).closest('div,li').parent().text().replace(/\s+/g, ' ');
    if (!byId.has(id)) byId.set(id, { texts: [], blockText });
    byId.get(id).texts.push(text);
  });
  for (const [id, { texts, blockText }] of byId) {
    const title = texts.reduce((a, b) => (a.length >= b.length ? a : b), '');
    if (!matchesKeyword(title, keywords)) continue;
    if (!blockText.includes('경기')) continue;
    const company = texts.find((t) => t !== title) || '';
    results.push({
      site: '잡코리아',
      id: 'jobkorea_' + id,
      title,
      company,
      link: 'https://www.jobkorea.co.kr/Recruit/GI_Read/' + id,
    });
  }
  return results;
}

// 원티드: API 응답의 address로 경기 지역만, 별도 신입 필드는 없어서 제목/설명에 필터 적용
async function fetchWanted(keywords) {
  const results = [];
  const url =
    'https://www.wanted.co.kr/api/v4/jobs?query=' +
    encodeURIComponent('소방') +
    '&country=kr&job_sort=job.latest_order&years=-1&locations=all';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const json = await res.json();
  (json.data || []).forEach((d) => {
    const title = d.position || '';
    if (!matchesKeyword(title, keywords)) return;
    const location = d.address && d.address.location ? d.address.location : '';
    if (!location.includes('경기')) return;
    results.push({
      site: '원티드',
      id: 'wanted_' + d.id,
      title,
      company: d.company ? d.company.name : '',
      link: 'https://www.wanted.co.kr/wd/' + d.id,
    });
  });
  return results;
}

function normalizeForDedupe(text) {
  return text.replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

// 같은 공고가 여러 사이트에 겹치면 잡코리아 > 사람인 > 원티드 순으로 하나만 남김
function dedupeByPriority(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const key = normalizeForDedupe(job.title) + '|' + normalizeForDedupe(job.company);
    const existing = map.get(key);
    if (!existing || SITE_PRIORITY[job.site] < SITE_PRIORITY[existing.site]) {
      map.set(key, job);
    }
  }
  return [...map.values()];
}

async function fetchSummary(job) {
  try {
    const res = await fetch(job.link, { headers: { 'User-Agent': UA } });
    const html = await res.text();
    const $ = cheerio.load(html);
    let desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    desc = desc.replace(/\s+/g, ' ').trim();
    if (desc.length > 80) desc = desc.slice(0, 80) + '...';
    return desc || '(요약 정보 없음)';
  } catch (e) {
    return '(요약 정보 없음)';
  }
}

async function refreshAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.kakao_client_id,
    client_secret: cfg.kakao_client_secret,
    refresh_token: cfg.kakao_refresh_token,
  });
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('카카오 토큰 갱신 실패: ' + JSON.stringify(json));
  }
  if (json.refresh_token) {
    cfg.kakao_refresh_token = json.refresh_token;
    saveConfig(cfg);
  }
  return json.access_token;
}

async function sendKakaoText(accessToken, text, link) {
  const body = new URLSearchParams();
  body.append(
    'template_object',
    JSON.stringify({
      object_type: 'text',
      text,
      link: { web_url: link, mobile_web_url: link },
    })
  );
  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body,
  });
  const json = await res.json();
  if (json.result_code !== 0) {
    throw new Error('카카오 메시지 전송 실패: ' + JSON.stringify(json));
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const cfg = loadConfig();
  const seen = loadSeen();

  const [saramin, jobkorea, wanted] = await Promise.all([
    fetchSaramin(cfg.keywords).catch((e) => {
      console.error('사람인 오류:', e.message);
      return [];
    }),
    fetchJobKorea(cfg.keywords).catch((e) => {
      console.error('잡코리아 오류:', e.message);
      return [];
    }),
    fetchWanted(cfg.keywords).catch((e) => {
      console.error('원티드 오류:', e.message);
      return [];
    }),
  ]);

  const deduped = dedupeByPriority([...jobkorea, ...saramin, ...wanted]);
  const fresh = deduped.filter((job) => !seen[job.id]).slice(0, MAX_TOTAL);

  console.log(`중복 제거 후 ${deduped.length}건 중 새 공고 ${fresh.length}건 (최대 ${MAX_TOTAL}건까지 전송)`);

  if (fresh.length === 0) {
    console.log('새로운 공고가 없어 메시지를 보내지 않습니다.');
    return;
  }

  for (const job of fresh) {
    job.summary = await fetchSummary(job);
  }

  const accessToken = await refreshAccessToken(cfg);

  const groups = chunk(fresh, 3);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const lines = g.map(
      (j) => `[${j.site}] ${j.title}${j.company ? ' - ' + j.company : ''}\n${j.summary}\n${j.link}`
    );
    const header = groups.length > 1 ? `소방 공고 알림 (${i + 1}/${groups.length})\n\n` : '오늘의 소방 관련 채용 공고 (경기·신입)\n\n';
    const text = header + lines.join('\n\n');
    await sendKakaoText(accessToken, text.slice(0, 990), g[0].link);
  }

  fresh.forEach((j) => {
    seen[j.id] = new Date().toISOString();
  });
  saveSeen(seen);

  console.log('전송 완료.');
}

main().catch((e) => {
  console.error('실행 중 오류:', e);
  process.exit(1);
});
