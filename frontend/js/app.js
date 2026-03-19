'use strict';

const SAVED_KEY = 'mgflow_saved';
const posts = new Map(); // uri → post data
let savedUris = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'));

const feedEl = document.getElementById('feed');
const countEl = document.getElementById('postCount');
const dotEl = document.getElementById('statusDot');
const toastEl = document.getElementById('toast');

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function colourHashtags(text) {
  return text.replace(/(#\w+)/g, '<span class="hashtag">$1</span>');
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function persistSaved() {
  localStorage.setItem(SAVED_KEY, JSON.stringify([...savedUris]));
}

// ── Embed rendering ───────────────────────────────────────────────────────

function renderEmbed(embedJson) {
  if (!embedJson) return '';
  let embed;
  try { embed = JSON.parse(embedJson); } catch { return ''; }

  if (embed.type === 'images') {
    const cls = embed.images.length >= 2 ? 'embed-images two-up' : 'embed-images';
    const imgs = embed.images.map(img => {
      const src = img.thumb ? buildCdnUrl(img) : '';
      return src ? `<img src="${escHtml(src)}" alt="${escHtml(img.alt || '')}" loading="lazy">` : '';
    }).join('');
    return `<div class="${cls}">${imgs}</div>`;
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

  if (embed.type === 'quote') {
    return `<div class="embed-quote">💬 @${escHtml(embed.author_handle || '')}: ${escHtml(embed.text || '')}</div>`;
  }

  return '';
}

function buildCdnUrl(img) {
  return img.thumb || img.fullsize || '';
}

// ── Card rendering ────────────────────────────────────────────────────────

function renderCard(post) {
  const uri = post.uri;
  const saved = savedUris.has(uri);
  const avatarSrc = post.author_avatar || '';
  const displayName = post.author_display_name || post.author_handle;
  const embed = renderEmbed(post.embeds_json);

  const card = document.createElement('article');
  card.className = 'post-card';
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

// ── Save handler ──────────────────────────────────────────────────────────

async function handleSave(e) {
  const btn = e.currentTarget;
  const uri = btn.dataset.uri;
  if (btn.classList.contains('saved') || btn.classList.contains('saving')) return;

  btn.classList.add('saving');
  btn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });
    if (!res.ok) throw new Error(await res.text());
    savedUris.add(uri);
    persistSaved();
    btn.classList.remove('saving');
    btn.classList.add('saved');
    btn.textContent = 'Saved ✓';
    showToast('Saved to Blocks!');
  } catch (err) {
    btn.classList.remove('saving');
    btn.textContent = 'Save to Blocks';
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
    let post;
    try { post = JSON.parse(e.data); } catch { return; }
    const uri = post.uri;

    if (posts.has(uri)) {
      posts.set(uri, { ...posts.get(uri), ...post });
      updateCardCounts(post);
    } else {
      posts.set(uri, post);
      const card = renderCard(post);
      // Insert at top (after any newer posts already there)
      const firstCard = feedEl.firstElementChild;
      if (firstCard) {
        // Insert before cards with older timestamps
        let inserted = false;
        for (const existing of feedEl.children) {
          const existUri = existing.dataset.uri;
          const existPost = posts.get(existUri);
          if (existPost && new Date(existPost.indexed_at) < new Date(post.indexed_at)) {
            feedEl.insertBefore(card, existing);
            inserted = true;
            break;
          }
        }
        if (!inserted) feedEl.appendChild(card);
      } else {
        feedEl.appendChild(card);
      }
      updateCount();
    }
  };
}

connect();

// Refresh relative timestamps every minute
setInterval(() => {
  feedEl.querySelectorAll('time[datetime]').forEach(el => {
    el.textContent = relativeTime(el.getAttribute('datetime'));
  });
}, 60_000);
