'use strict';

const posts = new Map(); // uri → post data (source of truth)

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
  const n = posts.size;
  countEl.textContent = `${n} post${n !== 1 ? 's' : ''}`;
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
  if (!timelineData || !timelineData.buckets.length) return;

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

  const { buckets } = timelineData;
  const LABEL_H = 16;
  const MARKER_H = 8;
  const BAR_AREA = H - LABEL_H - MARKER_H - 4;
  const PAD = 32; // left/right padding for labels

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + 15 * 60 * 1000;
  const now = Date.now();

  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  function timeToX(t) {
    return PAD + ((t - firstBucket) / timeSpan) * (W - PAD * 2);
  }

  // Background
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);

  // Hour gridlines + labels
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8b949e';
  ctx.font = `10px -apple-system, sans-serif`;
  ctx.textAlign = 'center';

  const startHour = new Date(firstBucket);
  startHour.setUTCMinutes(0, 0, 0);
  for (let t = startHour.getTime(); t <= lastBucket.getTime() + 3600000; t += 3600000) {
    const x = timeToX(t);
    if (x < PAD - 10 || x > W - PAD + 10) continue;
    ctx.beginPath();
    ctx.moveTo(x, LABEL_H);
    ctx.lineTo(x, H - 2);
    ctx.stroke();
    ctx.fillText(fmtHHMM(new Date(t)), x, LABEL_H - 2);
  }

  // Bars
  const bucketWidth = Math.max(2, (W - PAD * 2) / buckets.length - 1);
  buckets.forEach(b => {
    const x = timeToX(new Date(b.start).getTime());
    const barH = (b.count / maxCount) * BAR_AREA;
    const y = H - barH - MARKER_H - 2;

    // Bar fill
    ctx.fillStyle = b.saved_count > 0 ? '#1d9bf040' : '#30363d';
    ctx.fillRect(x - bucketWidth / 2, y, bucketWidth, barH);

    // Gold top cap if has saves
    if (b.saved_count > 0) {
      ctx.fillStyle = '#f0c040';
      ctx.fillRect(x - bucketWidth / 2, y, bucketWidth, 2);
    }
  });

  // Gold markers (saved posts) — dots below bars
  const savedBuckets = buckets.filter(b => b.saved_count > 0);
  savedBuckets.forEach(b => {
    const x = timeToX(new Date(b.start).getTime());
    ctx.beginPath();
    ctx.arc(x, H - MARKER_H / 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#f0c040';
    ctx.fill();
  });

  // Current time indicator
  if (now > firstBucket && now < firstBucket.getTime() + timeSpan + 3600000) {
    const x = timeToX(now);
    ctx.beginPath();
    ctx.moveTo(x, LABEL_H);
    ctx.lineTo(x, H);
    ctx.strokeStyle = '#1d9bf0';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function timelineHover(e) {
  if (!timelineData || !timelineData.buckets.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const W = rect.width;
  const PAD = 32;
  const { buckets } = timelineData;

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + 15 * 60 * 1000;

  const t = firstBucket.getTime() + ((x - PAD) / (W - PAD * 2)) * timeSpan;
  const BUCKET_MS = 15 * 60 * 1000;
  const bucket = buckets.find(b => {
    const bs = new Date(b.start).getTime();
    return t >= bs && t < bs + BUCKET_MS;
  });

  if (bucket) {
    tooltip.style.display = 'block';
    tooltip.style.left = e.clientX + 'px';
    tooltip.textContent = `${fmtHHMM(new Date(bucket.start))} — ${bucket.count} posts` +
                          (bucket.saved_count ? ` · ${bucket.saved_count} saved` : '');
  } else {
    tooltip.style.display = 'none';
  }
}

function timelineClick(e) {
  if (!timelineData || !timelineData.buckets.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const W = rect.width;
  const PAD = 32;
  const { buckets } = timelineData;

  const firstBucket = new Date(buckets[0].start);
  const lastBucket = new Date(buckets[buckets.length - 1].start);
  const timeSpan = lastBucket - firstBucket + 15 * 60 * 1000;

  const t = firstBucket.getTime() + ((x - PAD) / (W - PAD * 2)) * timeSpan;
  const BUCKET_MS = 15 * 60 * 1000;
  const bucket = buckets.find(b => {
    const bs = new Date(b.start).getTime();
    return t >= bs && t < bs + BUCKET_MS;
  });

  if (!bucket) return;

  // Find the first card in this time bucket and scroll to it
  const bucketStart = new Date(bucket.start);
  const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS);
  const cards = feedEl.querySelectorAll('[data-uri]');
  for (const card of cards) {
    const uri = card.dataset.uri;
    const post = posts.get(uri);
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
      const card = renderCard(post);
      // Insert in chronological order (newest last = bottom of feed)
      let inserted = false;
      const allCards = [...feedEl.children];
      for (const existing of allCards) {
        const existPost = posts.get(existing.dataset.uri);
        if (existPost && new Date(existPost.indexed_at) > new Date(post.indexed_at)) {
          feedEl.insertBefore(card, existing);
          inserted = true;
          break;
        }
      }
      if (!inserted) feedEl.appendChild(card);
      updateCount();
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

// ── YouTube player ────────────────────────────────────────────────────────

let ytPlayer = null;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('ytPlayer', {
    videoId: 'jdI7MZfMEFc',
    playerVars: { autoplay: 0, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { /* player ready */ }
    }
  });
};

// ── Video panel toggle ────────────────────────────────────────────────────

const videoToggleBtn = document.getElementById('videoToggle');
const videoPanel = document.getElementById('videoPanel');

videoToggleBtn.addEventListener('click', () => {
  const isVisible = videoPanel.classList.toggle('visible');
  videoToggleBtn.classList.toggle('active', isVisible);
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

  clipBtn.disabled = true;
  clipBtn.textContent = 'Clipping…';

  try {
    const res = await fetch('/api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, session_context: sessionContext, video_time: videoTime }),
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
