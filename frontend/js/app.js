'use strict';

const posts = new Map(); // uri → post data (source of truth)

// ── Day filter state ───────────────────────────────────────────────────────
const DAY1_START = new Date('2026-03-19T00:00:00Z');
const DAY2_START = new Date('2026-03-20T00:00:00Z');
const DAY3_START = new Date('2026-03-21T00:00:00Z');
let activeDayFilter = null; // null = all, 'day1', 'day2'

function postMatchesFilter(post) {
  if (!activeDayFilter) return true;
  const dt = new Date(post.indexed_at);
  if (activeDayFilter === 'day1') return dt >= DAY1_START && dt < DAY2_START;
  if (activeDayFilter === 'day2') return dt >= DAY2_START && dt < DAY3_START;
  return true;
}

function getFilteredBuckets() {
  if (!timelineData) return [];
  const { buckets } = timelineData;
  if (!activeDayFilter) return buckets;
  return buckets.filter(b => {
    const bt = new Date(b.start);
    if (activeDayFilter === 'day1') return bt >= DAY1_START && bt < DAY2_START;
    if (activeDayFilter === 'day2') return bt >= DAY2_START && bt < DAY3_START;
    return true;
  });
}

const feedEl = document.getElementById('feed');
const countEl = document.getElementById('postCount');
const dotEl = document.getElementById('statusDot');
const toastEl = document.getElementById('toast');
const canvas = document.getElementById('timelineCanvas');
const tooltip = document.getElementById('timelineTooltip');

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function fmtHHMM(date) {
  return date.getUTCHours().toString().padStart(2, '0') + ':' +
         date.getUTCMinutes().toString().padStart(2, '0');
}

function colourHashtags(text) {
  return text.replace(/(#\w+)/g, '<span class="hashtag">$1</span>');
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 3000);
}

function updateCount() {
  const n = activeDayFilter
    ? [...posts.values()].filter(postMatchesFilter).length
    : posts.size;
  countEl.textContent = `${n} post${n !== 1 ? 's' : ''}`;
}

function rebuildFeed() {
  feedEl.innerHTML = '';
  const sorted = [...posts.values()]
    .filter(postMatchesFilter)
    .sort((a, b) => new Date(b.indexed_at) - new Date(a.indexed_at));
  for (const post of sorted) feedEl.appendChild(renderCard(post));
  updateCount();
}

// ── Timeline ─────────────────────────────────────────────────────────────

let timelineData = null; // {buckets, conference_start, total, saved_total}

async function refreshTimeline() {
  try {
    const r = await fetch('/api/feed/timeline');
    if (!r.ok) return;
    timelineData = await r.json();
    drawTimeline();
  } catch {}
}

function drawTimeline() {
  const buckets = getFilteredBuckets();
  if (!buckets.length) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const LABEL_W = 30; // left space for HH:MM labels
  const BAR_AREA = W - LABEL_W - 2;
  const BUCKET_MS = 15 * 60 * 1000;

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + BUCKET_MS;
  const now = Date.now();

  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  function timeToY(t) {
    return H - ((t - firstBucket) / timeSpan) * H;
  }

  // Background
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);

  // Hour gridlines + labels
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8b949e';
  ctx.font = `9px -apple-system, sans-serif`;
  ctx.textAlign = 'right';

  const startHour = new Date(firstBucket);
  startHour.setUTCMinutes(0, 0, 0);
  for (let t = startHour.getTime(); t <= lastBucket.getTime() + BUCKET_MS; t += 3600000) {
    const y = timeToY(t);
    if (y < 6 || y > H - 2) continue;
    ctx.beginPath();
    ctx.moveTo(LABEL_W, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(fmtHHMM(new Date(t)), LABEL_W - 2, y + 3);
  }

  // Bars (horizontal, time = Y axis)
  const bucketPxH = Math.max(2, (H / buckets.length) - 1);
  buckets.forEach(b => {
    const y = timeToY(new Date(b.start).getTime());
    const barW = (b.count / maxCount) * BAR_AREA;

    ctx.fillStyle = b.saved_count > 0 ? '#1d9bf040' : '#2d333b';
    ctx.fillRect(LABEL_W, y, barW, bucketPxH - 1);

    // Gold left cap for saved buckets
    if (b.saved_count > 0) {
      ctx.fillStyle = '#f0c040';
      ctx.fillRect(LABEL_W, y, 2, bucketPxH - 1);
    }
  });

  // Current time indicator
  const nowY = timeToY(now);
  if (nowY > 0 && nowY < H) {
    ctx.beginPath();
    ctx.moveTo(LABEL_W, nowY);
    ctx.lineTo(W, nowY);
    ctx.strokeStyle = '#1d9bf0';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function timelineHover(e) {
  const buckets = getFilteredBuckets();
  if (!buckets.length) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const H = rect.height;

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + 15 * 60 * 1000;

  const t = firstBucket.getTime() + ((H - y) / H) * timeSpan;
  const BUCKET_MS = 15 * 60 * 1000;
  const bucket = buckets.find(b => {
    const bs = new Date(b.start).getTime();
    return t >= bs && t < bs + BUCKET_MS;
  });

  if (bucket) {
    tooltip.style.display = 'block';
    tooltip.style.top = e.clientY + 'px';
    tooltip.style.left = rect.left + 'px';
    tooltip.textContent = `${fmtHHMM(new Date(bucket.start))} — ${bucket.count} posts` +
                          (bucket.saved_count ? ` · ${bucket.saved_count} saved` : '');
  } else {
    tooltip.style.display = 'none';
  }
}

function timelineClick(e) {
  const buckets = getFilteredBuckets();
  if (!buckets.length) return;
  const rect = canvas.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const H = rect.height;

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + 15 * 60 * 1000;

  const t = firstBucket.getTime() + ((H - y) / H) * timeSpan;
  const BUCKET_MS = 15 * 60 * 1000;
  const bucket = buckets.find(b => {
    const bs = new Date(b.start).getTime();
    return t >= bs && t < bs + BUCKET_MS;
  });

  if (!bucket) return;

  // With newest-at-top, the first matching card in DOM is the newest in the bucket
  const bucketStart = new Date(bucket.start);
  const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS);
  const cards = feedEl.querySelectorAll('[data-uri]');
  for (const card of cards) {
    const post = posts.get(card.dataset.uri);
    if (!post) continue;
    const dt = new Date(post.indexed_at);
    if (dt >= bucketStart && dt < bucketEnd) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.add('highlight');
      setTimeout(() => card.classList.remove('highlight'), 1500);
      return;
    }
  }
}

canvas.addEventListener('mousemove', timelineHover);
canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
canvas.addEventListener('click', timelineClick);
window.addEventListener('resize', drawTimeline);

// ── Embed rendering ───────────────────────────────────────────────────────

function renderQuote(q, nestedEmbed) {
  if (!q) return '';
  const nestedHtml = nestedEmbed ? renderEmbedObj(nestedEmbed) : '';
  return `<div class="embed-quote">
    <div class="quote-author">@${escHtml(q.author_handle || '')}</div>
    <div class="quote-text">${escHtml(q.text || '')}</div>
    ${nestedHtml}
  </div>`;
}

function renderEmbedObj(embed) {
  if (!embed) return '';
  if (embed.type === 'images') {
    const cls = embed.images.length >= 2 ? 'embed-images two-up' : 'embed-images';
    return `<div class="${cls}">${embed.images.map(img => {
      const src = buildCdnUrl(img);
      return src ? `<img src="${escHtml(src)}" alt="${escHtml(img.alt || '')}" loading="lazy">` : '';
    }).join('')}</div>`;
  }
  if (embed.type === 'external' && embed.uri) {
    return `<a class="embed-link" href="${escHtml(embed.uri)}" target="_blank" rel="noopener noreferrer">
      <div class="embed-link-body">
        <div class="embed-link-title">${escHtml(embed.title || embed.uri)}</div>
      </div>
    </a>`;
  }
  return '';
}

function renderEmbed(embedJson) {
  if (!embedJson) return '';
  let embed;
  try { embed = JSON.parse(embedJson); } catch { return ''; }

  if (embed.type === 'images') {
    return renderEmbedObj(embed);
  }

  if (embed.type === 'external' && embed.uri) {
    let host = '';
    try { host = new URL(embed.uri).hostname; } catch {}
    const thumb = embed.thumb ? `<img class="embed-link-thumb" src="${escHtml(embed.thumb)}" alt="" loading="lazy">` : '';
    return `<a class="embed-link" href="${escHtml(embed.uri)}" target="_blank" rel="noopener noreferrer">
      ${thumb}
      <div class="embed-link-body">
        <div class="embed-link-title">${escHtml(embed.title || embed.uri)}</div>
        ${embed.description ? `<div class="embed-link-desc">${escHtml(embed.description)}</div>` : ''}
        <div class="embed-link-host">${escHtml(host)}</div>
      </div>
    </a>`;
  }

  if (embed.type === 'recordWithMedia') {
    return renderEmbed(JSON.stringify(embed.media)) + renderQuote(embed.quote, null);
  }

  if (embed.type === 'quote') {
    return renderQuote(embed, embed.nested_embed);
  }

  return '';
}

function buildCdnUrl(img) {
  return img.thumb || img.fullsize || '';
}

// ── Card rendering ────────────────────────────────────────────────────────

function renderCard(post) {
  const uri = post.uri;
  const saved = post.saved_to_blocks || false;
  const avatarSrc = post.author_avatar || '';
  const displayName = post.author_display_name || post.author_handle;
  const embed = renderEmbed(post.embeds_json);

  const card = document.createElement('article');
  card.className = 'post-card' + (saved ? ' is-saved' : '');
  card.dataset.uri = uri;
  card.innerHTML = `
    <div class="post-header">
      ${avatarSrc
        ? `<img class="avatar" src="${escHtml(avatarSrc)}" alt="${escHtml(displayName)}" loading="lazy">`
        : `<div class="avatar"></div>`}
      <div class="author-info">
        <div class="display-name">${escHtml(displayName)}</div>
        <div class="handle-time">@${escHtml(post.author_handle)} · <time datetime="${escHtml(post.indexed_at)}">${relativeTime(post.indexed_at)}</time></div>
      </div>
    </div>
    <div class="post-text">${colourHashtags(escHtml(post.text))}</div>
    ${embed}
    <div class="post-footer">
      <div class="counts">
        <span class="count-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span class="like-count">${post.like_count}</span>
        </span>
        <span class="count-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="reply-count">${post.reply_count}</span>
        </span>
        <span class="count-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          <span class="repost-count">${post.repost_count}</span>
        </span>
      </div>
      <button class="save-btn${saved ? ' saved' : ''}" data-uri="${escHtml(uri)}">
        ${saved ? 'Saved ✓' : 'Save to Blocks'}
      </button>
    </div>
  `;

  card.querySelector('.save-btn').addEventListener('click', handleSave);
  return card;
}

function updateCardCounts(post) {
  const card = feedEl.querySelector(`[data-uri="${CSS.escape(post.uri)}"]`);
  if (!card) return;
  card.querySelector('.like-count').textContent = post.like_count;
  card.querySelector('.reply-count').textContent = post.reply_count;
  card.querySelector('.repost-count').textContent = post.repost_count;
}

function updateCardSaved(uri) {
  const card = feedEl.querySelector(`[data-uri="${CSS.escape(uri)}"]`);
  if (!card) return;
  card.classList.add('is-saved');
  const btn = card.querySelector('.save-btn');
  btn.classList.remove('saving');
  btn.classList.add('saved');
  btn.textContent = 'Saved ✓';
}

// ── Save handler ──────────────────────────────────────────────────────────

async function handleSave(e) {
  const btn = e.currentTarget;
  const uri = btn.dataset.uri;
  if (btn.classList.contains('saving')) return;

  const wasAlreadySaved = btn.classList.contains('saved');
  btn.classList.add('saving');
  btn.classList.remove('saved');
  btn.textContent = wasAlreadySaved ? 'Re-saving…' : 'Saving…';

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });
    if (!res.ok) throw new Error(await res.text());
    btn.classList.remove('saving');
    btn.classList.add('saved');
    btn.textContent = 'Saved ✓';
    showToast(wasAlreadySaved ? 'Re-saved to Blocks!' : 'Saved to Blocks!');
    // Update local state
    const post = posts.get(uri);
    if (post) post.saved_to_blocks = true;
    refreshTimeline();
  } catch (err) {
    btn.classList.remove('saving');
    if (wasAlreadySaved) btn.classList.add('saved');
    btn.textContent = wasAlreadySaved ? 'Saved ✓' : 'Save to Blocks';
    showToast('Save failed: ' + err.message, true);
  }
}

// ── SSE client ────────────────────────────────────────────────────────────

let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  const es = new EventSource('/api/feed/stream');

  es.onopen = () => {
    dotEl.className = 'status-dot connected';
    dotEl.title = 'Connected';
  };

  es.onerror = () => {
    dotEl.className = 'status-dot error';
    dotEl.title = 'Reconnecting…';
    es.close();
    reconnectTimer = setTimeout(connect, 5000);
  };

  es.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }

    // Saved notification from the server
    if (event.event === 'saved') {
      const post = posts.get(event.uri);
      if (post) {
        post.saved_to_blocks = true;
        updateCardSaved(event.uri);
      }
      return;
    }

    // New or updated post
    const uri = event.uri;
    if (!uri) return;
    // Remove the internal event field before storing
    const { event: _, ...post } = event;

    if (posts.has(uri)) {
      const existing = posts.get(uri);
      const updatedPost = { ...existing, ...post };
      posts.set(uri, updatedPost);
      updateCardCounts(updatedPost);
      if (post.saved_to_blocks && !existing.saved_to_blocks) {
        updateCardSaved(uri);
      }
    } else {
      posts.set(uri, post);
      if (postMatchesFilter(post)) {
        const card = renderCard(post);
        // Initial batch arrives newest-first → append keeps the order.
        // Live posts arrive as they're polled (newest) → prepend to top.
        // We distinguish: if the new post is newer than the current top card, prepend.
        const firstCard = feedEl.firstElementChild;
        const firstPost = firstCard ? posts.get(firstCard.dataset.uri) : null;
        if (firstPost && new Date(post.indexed_at) > new Date(firstPost.indexed_at)) {
          feedEl.prepend(card);
        } else {
          feedEl.appendChild(card);
        }
        updateCount();
      }
    }
  };
}

connect();

// ── Initial timeline load ─────────────────────────────────────────────────
refreshTimeline();
setInterval(refreshTimeline, 3 * 60 * 1000); // refresh every 3 min

// Refresh relative timestamps every minute
setInterval(() => {
  feedEl.querySelectorAll('time[datetime]').forEach(el => {
    el.textContent = relativeTime(el.getAttribute('datetime'));
  });
}, 60_000);

// ── Stream management ─────────────────────────────────────────────────────

const DEFAULT_STREAMS = [{ id: 'jdI7MZfMEFc', name: 'Monkigras Main Stream' }];
let _streamsConfig = { streams: DEFAULT_STREAMS, active_stream: DEFAULT_STREAMS[0].id };

function getActiveStreamId() {
  return _streamsConfig.active_stream || _streamsConfig.streams[0]?.id || '';
}

async function _fetchStreamsConfig() {
  try {
    const r = await fetch('/api/config/streams');
    if (r.ok) {
      const data = await r.json();
      if (data.streams?.length) _streamsConfig = data;
    }
  } catch {}
}

async function _saveStreamsConfig() {
  try {
    await fetch('/api/config/streams', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_streamsConfig),
    });
  } catch {}
}

function extractVideoId(input) {
  const s = input.trim();
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

const streamSelectEl = document.getElementById('streamSelect');
const streamAddForm = document.getElementById('streamAddForm');
const streamNameInput = document.getElementById('streamNameInput');
const streamUrlInput = document.getElementById('streamUrlInput');

function renderStreamSelect() {
  streamSelectEl.innerHTML = _streamsConfig.streams.map(s =>
    `<option value="${escHtml(s.id)}"${s.id === _streamsConfig.active_stream ? ' selected' : ''}>${escHtml(s.name)}</option>`
  ).join('');
}

streamSelectEl.addEventListener('change', () => {
  _streamsConfig.active_stream = streamSelectEl.value;
  _saveStreamsConfig();
  if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(_streamsConfig.active_stream);
});

document.getElementById('streamAddBtn').addEventListener('click', () => {
  streamAddForm.classList.add('visible');
  streamNameInput.focus();
});

document.getElementById('streamCancelBtn').addEventListener('click', () => {
  streamAddForm.classList.remove('visible');
  streamNameInput.value = '';
  streamUrlInput.value = '';
});

document.getElementById('streamSaveBtn').addEventListener('click', async () => {
  const name = streamNameInput.value.trim();
  const id = extractVideoId(streamUrlInput.value);
  if (!name) { showToast('Enter a stream name', true); return; }
  if (!id) { showToast('Invalid YouTube URL or video ID', true); return; }
  if (_streamsConfig.streams.find(s => s.id === id)) { showToast('Stream already added', true); return; }
  _streamsConfig.streams.push({ id, name });
  _streamsConfig.active_stream = id;
  await _saveStreamsConfig();
  renderStreamSelect();
  streamAddForm.classList.remove('visible');
  streamNameInput.value = '';
  streamUrlInput.value = '';
  if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(id);
  showToast(`Added: ${name}`);
});

document.getElementById('streamRemoveBtn').addEventListener('click', async () => {
  if (_streamsConfig.streams.length <= 1) { showToast('Cannot remove the last stream', true); return; }
  const active = _streamsConfig.active_stream;
  _streamsConfig.streams = _streamsConfig.streams.filter(s => s.id !== active);
  _streamsConfig.active_stream = _streamsConfig.streams[0].id;
  await _saveStreamsConfig();
  renderStreamSelect();
  if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(_streamsConfig.active_stream);
});

// ── YouTube player ────────────────────────────────────────────────────────

let ytPlayer = null;
let _ytReadyResolve;
const _ytReady = new Promise(r => { _ytReadyResolve = r; });

window.onYouTubeIframeAPIReady = async function () {
  await _ytReady;
  ytPlayer = new YT.Player('ytPlayer', {
    videoId: getActiveStreamId(),
    playerVars: { autoplay: 0, rel: 0, modestbranding: 1 },
    events: { onReady: () => {} }
  });
};

async function initStreams() {
  await _fetchStreamsConfig();
  renderStreamSelect();
  _ytReadyResolve();
}

initStreams();

// ── Video panel toggle ────────────────────────────────────────────────────

const videoToggleBtn = document.getElementById('videoToggle');
const videoPanel = document.getElementById('videoPanel');

videoToggleBtn.addEventListener('click', () => {
  const isVisible = videoPanel.classList.toggle('visible');
  videoToggleBtn.classList.toggle('active', isVisible);
});

// ── Resize handle ─────────────────────────────────────────────────────────

const resizerEl = document.getElementById('resizer');
const VIDEO_W_KEY = 'mgflow_video_w';

// Restore saved panel width
const savedVideoW = localStorage.getItem(VIDEO_W_KEY);
if (savedVideoW && videoPanel) videoPanel.style.width = savedVideoW + 'px';

let isResizing = false;
let resizeStartX = 0;
let resizeStartW = 0;

resizerEl.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeStartX = e.clientX;
  resizeStartW = videoPanel.offsetWidth;
  resizerEl.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newW = Math.max(240, Math.min(resizeStartW + (e.clientX - resizeStartX), window.innerWidth * 0.7));
  videoPanel.style.width = newW + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizerEl.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  localStorage.setItem(VIDEO_W_KEY, videoPanel.offsetWidth);
  drawTimeline();
});

// ── Session context persistence ───────────────────────────────────────────

const SESSION_KEY = 'mgflow_session';
const sessionEl = document.getElementById('sessionContext');

if (sessionEl) {
  sessionEl.value = localStorage.getItem(SESSION_KEY) || '';
  sessionEl.addEventListener('input', () => {
    localStorage.setItem(SESSION_KEY, sessionEl.value);
  });
}

// ── Clip handler ──────────────────────────────────────────────────────────

const clipBtn = document.getElementById('clipBtn');
const clipNoteEl = document.getElementById('clipNote');

clipBtn.addEventListener('click', async () => {
  const note = clipNoteEl.value.trim();
  if (!note) {
    showToast('Add a note before clipping', true);
    return;
  }

  const videoTime = ytPlayer ? Math.floor(ytPlayer.getCurrentTime()) : null;
  const sessionContext = sessionEl ? sessionEl.value.trim() : '';
  const videoId = getActiveStreamId();

  clipBtn.disabled = true;
  clipBtn.textContent = 'Clipping…';

  try {
    const res = await fetch('/api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, session_context: sessionContext, video_time: videoTime, video_id: videoId }),
    });
    if (!res.ok) throw new Error(await res.text());
    clipBtn.classList.add('success');
    clipBtn.textContent = 'Clipped ✓';
    clipNoteEl.value = '';
    showToast('Clipped to Blocks!');
    setTimeout(() => {
      clipBtn.classList.remove('success');
      clipBtn.textContent = '📎 Clip to Blocks';
      clipBtn.disabled = false;
    }, 2500);
  } catch (err) {
    clipBtn.disabled = false;
    clipBtn.textContent = '📎 Clip to Blocks';
    showToast('Clip failed: ' + err.message, true);
  }
});

// ── Day filter ─────────────────────────────────────────────────────────────

document.getElementById('dayFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.day-btn');
  if (!btn) return;
  activeDayFilter = btn.dataset.day || null;
  document.querySelectorAll('.day-btn').forEach(b => b.classList.toggle('active', b === btn));
  rebuildFeed();
  drawTimeline();
});
