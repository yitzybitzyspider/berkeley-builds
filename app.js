import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3/+esm';
import { SUPABASE_URL, SUPABASE_KEY, APP_VERSION } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TAGS = ['Class Tool', 'Career/Recruiting', 'Prompt or GPT', 'Startup Idea', 'Design/Creative', 'Just for Fun'];
const MAX_FILE_CHARS = 300000;
const app = document.getElementById('app');

const state = {
  session: null,
  posts: [],
  sort: 'new',          // 'new' | 'top'
  tag: null,            // null = all
  collabOnly: false,
  problemsOnly: false,
  openComments: new Set(),
  commentCache: {},     // postId -> comments[]
  fileCache: {},        // postId -> files[] (with content)
  pendingFiles: [],     // files staged in the share modal
  remixOf: null,        // post being remixed, while the share modal is open
  events: [],           // upcoming meetings
  view: 'feed',         // 'feed' | 'resources'
  deepLinkDone: false,
  loginError: null,
};

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function friendlyAuthError(desc) {
  if (!desc) return null;
  if (/database error|berkeley/i.test(desc)) {
    return 'Sign-in is limited to @berkeley.edu Google accounts. Try again with your Berkeley account.';
  }
  return desc;
}

function captureAuthErrorFromUrl() {
  for (const raw of [location.hash.slice(1), location.search.slice(1)]) {
    const p = new URLSearchParams(raw);
    if (p.get('error_description')) {
      state.loginError = friendlyAuthError(p.get('error_description'));
      history.replaceState(null, '', location.pathname);
      return;
    }
  }
}

// Markdown files render as sanitized HTML; everything else as preformatted text.
function renderDoc(filename, content) {
  if (/\.(md|markdown)$/i.test(filename) || !/\.[a-z0-9]+$/i.test(filename)) {
    try {
      return `<div class="md-body">${DOMPurify.sanitize(marked.parse(content))}</div>`;
    } catch (e) { /* fall through to pre */ }
  }
  return `<pre class="doc-pre">${esc(content)}</pre>`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function postSlug(p) {
  const s = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return (s || 'post') + '-' + p.id.slice(0, 8);
}

function postUrl(p) {
  return location.origin + location.pathname + '#p=' + postSlug(p);
}

function handleDeepLink() {
  if (state.deepLinkDone) return;
  const m = location.hash.match(/^#p=(?:.*-)?([0-9a-f]{8})$/);
  if (!m) return;
  const post = state.posts.find(p => p.id.startsWith(m[1]));
  if (!post) return;
  state.deepLinkDone = true;
  state.view = post.kind === 'resource' ? 'resources' : 'feed';
  render();
  if ((post.post_files ?? []).length) openContentModal(post);
  const card = app.querySelector(`.card[data-id="${post.id}"]`);
  if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); }
}

window.addEventListener('hashchange', () => { state.deepLinkDone = false; handleDeepLink(); });

/* ---------------- data ---------------- */

async function loadFeed() {
  const { data, error } = await supabase
    .from('posts')
    .select('*, profiles:profiles!posts_author_fkey(name, avatar_url), votes(user_id), comments(id), post_files(id, filename)')
    .order('created_at', { ascending: false });
  if (error) { console.error('loadFeed', error); return; }
  state.posts = data ?? [];
  await loadEvents();
  // Resolve remix sources with a plain second query (no PostgREST embed:
  // self-join embeds depend on the schema cache, which can lag migrations).
  const remixIds = [...new Set(state.posts.map(p => p.remix_of).filter(Boolean))];
  if (remixIds.length) {
    const { data: srcs } = await supabase.from('posts').select('id, title').in('id', remixIds);
    const byId = Object.fromEntries((srcs ?? []).map(s => [s.id, s]));
    state.posts.forEach(p => { p.remix_source = p.remix_of ? (byId[p.remix_of] ?? null) : null; });
  }
  // Reactions ("I want this" / "I'll help") via plain queries, same cache reasoning.
  const postIds = state.posts.map(p => p.id);
  let reactions = [];
  if (postIds.length) {
    const { data: rx } = await supabase.from('reactions').select('post_id, user_id, type').in('post_id', postIds);
    reactions = rx ?? [];
  }
  const helperIds = [...new Set(reactions.filter(r => r.type === 'help').map(r => r.user_id))];
  const helperNames = {};
  if (helperIds.length) {
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', helperIds);
    (profs ?? []).forEach(pr => { helperNames[pr.id] = pr.name; });
  }
  state.posts.forEach(p => {
    p.reactions = reactions.filter(r => r.post_id === p.id);
    p.helpers = p.reactions.filter(r => r.type === 'help').map(r => helperNames[r.user_id] ?? 'Someone');
  });
  render();
  handleDeepLink();
}

async function loadEvents() {
  const { data, error } = await supabase.from('events')
    .select('*')
    .gte('starts_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(5);
  if (error) { console.error('loadEvents', error); return; }
  state.events = data ?? [];
  const hostIds = [...new Set(state.events.map(ev => ev.host))];
  if (hostIds.length) {
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', hostIds);
    const names = Object.fromEntries((profs ?? []).map(p => [p.id, p.name]));
    state.events.forEach(ev => { ev.hostName = names[ev.host] ?? 'Someone'; });
  }
}

async function addEvent(fields) {
  const { error } = await supabase.from('events').insert({
    host: state.session.user.id,
    title: fields.title,
    starts_at: fields.starts_at,
    location: fields.location || null,
  });
  return error ? error.message : null;
}

async function deleteEvent(id) {
  if (!confirm('Cancel this meeting?')) return;
  await supabase.from('events').delete().eq('id', id);
  await loadEvents();
  render();
}

function gcalUrl(ev) {
  const fmt = d => new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const start = new Date(ev.starts_at);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title + ' (Berkeley Builds)',
    dates: fmt(start) + '/' + fmt(end),
    details: 'Hosted by ' + (ev.hostName ?? 'a classmate') + ' via Berkeley Builds',
  });
  if (ev.location) p.set('location', ev.location);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

async function loadComments(postId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*, profiles:profiles!comments_author_fkey(name, avatar_url)')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) { console.error('loadComments', error); return; }
  state.commentCache[postId] = data ?? [];
  render();
}

async function loadFiles(postId) {
  if (state.fileCache[postId]) return state.fileCache[postId];
  const { data, error } = await supabase
    .from('post_files')
    .select('*')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) { console.error('loadFiles', error); return []; }
  state.fileCache[postId] = data ?? [];
  return state.fileCache[postId];
}

async function toggleVote(post) {
  const me = state.session.user.id;
  const voted = post.votes.some(v => v.user_id === me);
  if (voted) {
    await supabase.from('votes').delete().eq('post_id', post.id).eq('user_id', me);
  } else {
    await supabase.from('votes').insert({ post_id: post.id, user_id: me });
  }
  await loadFeed();
}

async function quickAdd(kind, title) {
  const { error } = await supabase.from('posts').insert({
    author: state.session.user.id, title, kind,
  });
  if (error) { console.error('quickAdd', error); return; }
  await loadFeed();
}

async function toggleReaction(post, type) {
  const me = state.session.user.id;
  const mine = post.reactions.some(r => r.user_id === me && r.type === type);
  if (mine) {
    await supabase.from('reactions').delete()
      .eq('post_id', post.id).eq('user_id', me).eq('type', type);
  } else {
    await supabase.from('reactions').insert({ post_id: post.id, user_id: me, type });
  }
  await loadFeed();
}

async function attachToPost(postId, files) {
  if (!files.length) return null;
  const rows = files.map(f => ({ post_id: postId, filename: f.filename, content: f.content }));
  const { error } = await supabase.from('post_files').insert(rows);
  if (error) return error.message;
  delete state.fileCache[postId];
  await loadFeed();
  return null;
}

async function updatePost(id, fields) {
  const { error } = await supabase.from('posts').update({
    tagline: fields.tagline || null,
    link: fields.link || null,
    tag: fields.tag || null,
    kind: fields.kind,
    looking_for_collab: fields.collab,
    contact: fields.collab ? (fields.contact || null) : null,
  }).eq('id', id);
  return error ? error.message : null;
}

async function deleteFile(fileId, postId) {
  await supabase.from('post_files').delete().eq('id', fileId);
  delete state.fileCache[postId];
}

async function submitPost(fields) {
  const { data, error } = await supabase.from('posts').insert({
    author: state.session.user.id,
    title: fields.title,
    tagline: fields.tagline || null,
    link: fields.link || null,
    tag: fields.tag || null,
    kind: fields.kind,
    looking_for_collab: fields.collab,
    contact: fields.collab ? (fields.contact || null) : null,
    remix_of: state.remixOf,
  }).select().single();
  if (error) return error.message;
  if (state.pendingFiles.length) {
    const rows = state.pendingFiles.map(f => ({
      post_id: data.id, filename: f.filename, content: f.content,
    }));
    const { error: fileErr } = await supabase.from('post_files').insert(rows);
    if (fileErr) return 'Post created, but attaching content failed: ' + fileErr.message;
  }
  state.pendingFiles = [];
  state.remixOf = null;
  await loadFeed();
  return null;
}

async function deletePost(id) {
  if (!confirm('Delete this post? This can’t be undone.')) return;
  await supabase.from('posts').delete().eq('id', id);
  delete state.fileCache[id];
  await loadFeed();
}

async function addComment(postId, body) {
  const { error } = await supabase.from('comments')
    .insert({ post_id: postId, author: state.session.user.id, body });
  if (error) { console.error('addComment', error); return; }
  await loadComments(postId);
  await loadFeed();
}

async function deleteComment(id, postId) {
  await supabase.from('comments').delete().eq('id', id);
  await loadComments(postId);
  await loadFeed();
}

/* ---------------- views ---------------- */

function loginView() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="bear">🐻</div>
        <h1>Berkeley Builds</h1>
        <p class="tagline">What Haas is building with AI. Share yours, find collaborators, don’t build the same thing twice.</p>
        <button class="google-btn" id="login-btn">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.4 44 30.2 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
          Sign in with Google
        </button>
        <p class="login-note">@berkeley.edu accounts only</p>
        ${state.loginError ? `<div class="login-error">${esc(state.loginError)}</div>` : ''}
      </div>
    </div>`;
  document.getElementById('login-btn').onclick = () => {
    try { if (location.hash.startsWith('#p=')) localStorage.setItem('bb-deeplink', location.hash); } catch (e) {}
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
  };
}

function visiblePosts() {
  let posts = state.view === 'resources'
    ? state.posts.filter(p => p.kind === 'resource')
    : state.posts.filter(p => p.kind !== 'resource');
  if (state.tag) posts = posts.filter(p => p.tag === state.tag);
  if (state.collabOnly) posts = posts.filter(p => p.looking_for_collab);
  if (state.problemsOnly) posts = posts.filter(p => p.kind === 'problem');
  if (state.sort === 'top') {
    posts.sort((a, b) => b.votes.length - a.votes.length || new Date(b.created_at) - new Date(a.created_at));
  }
  return posts;
}

function postCard(p) {
  const me = state.session.user.id;
  const voted = p.votes.some(v => v.user_id === me);
  const mine = p.author === me;
  const open = state.openComments.has(p.id);
  const comments = state.commentCache[p.id] ?? [];
  const author = p.profiles ?? {};
  const files = p.post_files ?? [];
  return `
  <div class="card ${p.kind === 'problem' ? 'card-problem' : ''}" data-id="${p.id}">
    <button class="vote ${voted ? 'voted' : ''}" data-act="vote" title="${p.kind === 'problem' ? (voted ? 'Remove me too' : 'Me too, I want this solved') : (voted ? 'Remove upvote' : 'Upvote')}">
      <span class="tri">▲</span><span class="count">${p.votes.length}</span>
    </button>
    <div class="card-body">
      <div class="card-title">${p.link
        ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a>`
        : esc(p.title)}</div>
      ${p.tagline ? `<div class="card-tagline">${esc(p.tagline)}</div>` : ''}
      ${files.length || mine ? `
      <div class="file-row">
        ${files.map(f => `<button class="file-chip" data-act="open-files" title="View content">📄 ${esc(f.filename)}</button>`).join('')}
        ${mine ? `<button class="linkish" data-act="add-content" title="Add files, a pitch, a link, tags, or collaborators to this post">＋ add details</button>` : ''}
      </div>` : ''}
      <div class="card-meta">
        ${p.tag ? `<span class="tag-pill">${esc(p.tag)}</span>` : ''}
        ${p.kind === 'find' ? `<span class="find-badge">🔎 Shared find</span>` : ''}
        ${p.kind === 'problem' ? `<span class="problem-badge">🙋 Problem to solve</span>` : ''}
        ${p.kind === 'wip' ? `<span class="wip-badge">🔨 In the works</span>` : ''}
        ${p.remix_source ? `<span class="remix-badge" title="Built on top of another post">🔁 remix of “${esc(p.remix_source.title)}”</span>` : ''}
        ${p.looking_for_collab ? `<span class="collab-badge">🤝 Looking for collaborators${p.contact ? ` · ${esc(p.contact)}` : ''}</span>` : ''}
        <span class="meta-author">
          ${author.avatar_url ? `<img src="${esc(author.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
          ${esc(author.name ?? 'Someone')}
        </span>
        <span>·</span><span>${timeAgo(p.created_at)}</span>
        <span>·</span>
        <button class="linkish" data-act="comments">${open ? 'Hide' : ''} ${p.comments.length} comment${p.comments.length === 1 ? '' : 's'}</button>
        <span>·</span><button class="linkish" data-act="remix" title="Start your own version from this post">🔁 remix</button>
        <span>·</span><button class="linkish" data-act="share" title="Copy a direct link to this post">🔗 share</button>
        ${mine ? `<span>·</span><button class="linkish danger" data-act="delete">delete</button>` : ''}
      </div>
      <div class="react-row">
        <button class="react-btn ${p.reactions.some(r => r.user_id === me && r.type === 'want') ? 'active' : ''}" data-act="want">🙋 I want this${(n => n ? ` · ${n}` : '')(p.reactions.filter(r => r.type === 'want').length)}</button>
        <button class="react-btn ${p.reactions.some(r => r.user_id === me && r.type === 'help') ? 'active' : ''}" data-act="help">🤝 I'll help${(n => n ? ` · ${n}` : '')(p.helpers.length)}</button>
        ${p.helpers.length ? `<span class="helpers" title="People who offered to help">Helping: ${esc(p.helpers.join(', '))}</span>` : ''}
      </div>
      ${open ? `
      <div class="comments">
        ${comments.map(c => `
          <div class="comment">
            ${c.profiles?.avatar_url ? `<img src="${esc(c.profiles.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
            <div>
              <span class="who">${esc(c.profiles?.name ?? 'Someone')}<span class="when">${timeAgo(c.created_at)}</span>
              ${c.author === me ? `<button class="linkish danger" data-act="del-comment" data-cid="${c.id}">delete</button>` : ''}</span>
              <div>${esc(c.body)}</div>
            </div>
          </div>`).join('')}
        <form class="comment-form" data-act="comment-form">
          <input type="text" name="body" maxlength="2000" placeholder="Add a comment…" required>
          <button type="submit">Post</button>
        </form>
      </div>` : ''}
    </div>
  </div>`;
}

function heroRow(p) {
  const me = state.session.user.id;
  const voted = p.votes.some(v => v.user_id === me);
  return `<div class="hero-row">
    <button class="hero-vote ${voted ? 'voted' : ''}" data-hero-vote="${p.id}" title="${p.kind === 'problem' ? 'Me too, I want this solved' : 'Cheer it on'}">▲ ${p.votes.length}</button>
    <span class="hero-title">${esc(p.title)}</span>
    ${p.helpers.length ? `<span class="hero-helpers" title="Helping: ${esc(p.helpers.join(', '))}">🤝 ${p.helpers.length}</span>` : ''}
    <span class="hero-author">${esc((p.profiles?.name ?? '').split(' ')[0])}</span>
  </div>`;
}

function heroPanel(kind, head, emptyText, placeholder) {
  const items = state.posts.filter(p => p.kind === kind)
    .sort((a, b) => b.votes.length - a.votes.length || new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 6);
  return `
  <div class="hero-panel">
    <div class="hero-head">${head}</div>
    ${items.length ? items.map(heroRow).join('') : `<div class="hero-empty">${emptyText}</div>`}
    <form class="quick-add" data-kind="${kind}">
      <input type="text" name="title" maxlength="100" required placeholder="${placeholder}">
      <button type="button" class="qa-attach" title="Add files, a link, or details">📎</button>
      <button type="submit">Add</button>
    </form>
  </div>`;
}

function feedView() {
  const posts = visiblePosts();
  const u = state.session.user;
  const meta = u.user_metadata ?? {};
  app.innerHTML = `
    <header>
      <div class="header-inner">
        <span class="logo">Berkeley <span class="gold">Builds</span> 🐻</span>
        <nav class="views">
          <button class="${state.view === 'feed' ? 'active' : ''}" data-view="feed">Builds</button>
          <button class="${state.view === 'resources' ? 'active' : ''}" data-view="resources">📚 Resources</button>
        </nav>
        <div class="header-spacer"></div>
        <button class="share-btn" id="new-post-btn">+ Share a build</button>
        ${meta.avatar_url ? `<img class="avatar" src="${esc(meta.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <button class="signout" id="signout-btn">Sign out</button>
      </div>
    </header>
    <main>
      ${state.view === 'resources' ? `
      <div class="res-intro">📚 The shelf: guides, docs, and links worth keeping. Anything posted as a Resource lives here instead of the feed.</div>
      ` : `${(() => {
        const ev = state.events[0];
        if (!ev) return `<div class="meet-banner meet-empty">📅 No meeting on the books. <button class="linkish" id="host-meeting">Host one</button></div>`;
        const when = new Date(ev.starts_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return `<div class="meet-banner">
          <span class="meet-main">📅 Next meeting: <b>${esc(ev.title)}</b> · ${esc(when)}${ev.location ? ` · ${/^https?:\/\//i.test(ev.location) ? `<a href="${esc(ev.location)}" target="_blank" rel="noopener">join link</a>` : esc(ev.location)}` : ''} · hosted by ${esc(ev.hostName)}</span>
          <span class="meet-actions">
            <a class="meet-cal" href="${gcalUrl(ev)}" target="_blank" rel="noopener">Add to calendar</a>
            <button class="linkish" id="host-meeting">host your own</button>
            ${ev.host === state.session.user.id ? `<button class="linkish danger" data-del-event="${ev.id}">cancel</button>` : ''}
          </span>
        </div>`;
      })()}
      <div class="hero">
        ${heroPanel('problem', '🙋 Problems worth solving', 'What do you wish someone would build? One line, no commitment.', 'I wish someone would solve…')}
        ${heroPanel('wip', '🔨 In the works', 'Working on something? Claim it here so nobody builds it twice.', 'I’m working on…')}
      </div>`}
      <div class="controls">
        <div class="sort-tabs">
          <button data-sort="new" class="${state.sort === 'new' ? 'active' : ''}">Newest</button>
          <button data-sort="top" class="${state.sort === 'top' ? 'active' : ''}">Top</button>
        </div>
        ${state.view === 'feed' ? `
        ${TAGS.map(t => `<button class="chip ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
        <button class="chip ${state.collabOnly ? 'active' : ''}" id="collab-filter">🤝 Wants collaborators</button>
        <button class="chip ${state.problemsOnly ? 'active' : ''}" id="problem-filter">🙋 Problems</button>` : ''}
      </div>
      <div id="feed">
        ${posts.length ? posts.map(postCard).join('')
          : `<div class="empty">${state.view === 'resources' ? 'The shelf is empty. Post something with the type “Resource” and it lands here.' : `Nothing here yet${state.tag || state.collabOnly ? ' for this filter' : ''}. Be the first to share what you’re building.`}</div>`}
      </div>
      <footer>Berkeley Builds v${APP_VERSION} · built by Haas students, for Haas students · <a href="share-kit.md" target="_blank" rel="noopener">Share Kit</a></footer>
    </main>
    <div id="modal-root"></div>`;

  document.getElementById('new-post-btn').onclick = () =>
    openPostModal(null, state.view === 'resources' ? { kind: 'resource' } : null);
  app.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { state.view = b.dataset.view; render(); });
  const hostBtn = document.getElementById('host-meeting');
  if (hostBtn) hostBtn.onclick = openMeetingModal;
  app.querySelectorAll('[data-del-event]').forEach(b => b.onclick = () => deleteEvent(b.dataset.delEvent));
  const avatarEl = app.querySelector('.avatar');
  if (avatarEl) {
    avatarEl.title = 'Change the name classmates see';
    avatarEl.style.cursor = 'pointer';
    avatarEl.onclick = async () => {
      const current = state.posts.find(p => p.author === u.id)?.profiles?.name
        ?? meta.full_name ?? meta.name ?? '';
      const name = prompt('Display name shown to classmates:', current);
      if (name === null) return;
      const trimmed = name.trim().slice(0, 80);
      if (!trimmed) return;
      await supabase.from('profiles').update({ name: trimmed }).eq('id', u.id);
      await loadFeed();
    };
  }
  app.querySelectorAll('.quick-add').forEach(form => {
    form.onsubmit = async e => {
      e.preventDefault();
      const input = form.elements.title;
      const title = input.value.trim();
      if (!title) return;
      const btn = form.querySelector('button[type="submit"]');
      if (btn.disabled) return;
      btn.disabled = true;
      await quickAdd(form.dataset.kind, title);
    };
    form.querySelector('.qa-attach').onclick = () =>
      openPostModal(null, { kind: form.dataset.kind, title: form.elements.title.value.trim() });
  });
  app.querySelectorAll('[data-hero-vote]').forEach(b => b.onclick = () => {
    const post = state.posts.find(p => p.id === b.dataset.heroVote);
    if (post) toggleVote(post);
  });
  document.getElementById('signout-btn').onclick = async () => { await supabase.auth.signOut(); };
  document.getElementById('collab-filter')?.addEventListener('click', () => { state.collabOnly = !state.collabOnly; render(); });
  document.getElementById('problem-filter')?.addEventListener('click', () => { state.problemsOnly = !state.problemsOnly; render(); });
  app.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { state.sort = b.dataset.sort; render(); });
  app.querySelectorAll('[data-tag]').forEach(b => b.onclick = () => {
    state.tag = state.tag === b.dataset.tag ? null : b.dataset.tag; render();
  });

  app.querySelectorAll('.card').forEach(card => {
    const post = state.posts.find(p => p.id === card.dataset.id);
    if (!post) return;
    card.querySelector('[data-act="vote"]').onclick = () => toggleVote(post);
    card.querySelectorAll('[data-act="open-files"]').forEach(b =>
      b.onclick = () => openContentModal(post));
    card.querySelector('[data-act="comments"]').onclick = () => {
      if (state.openComments.has(post.id)) state.openComments.delete(post.id);
      else { state.openComments.add(post.id); loadComments(post.id); }
      render();
    };
    card.querySelector('[data-act="remix"]').onclick = () => openPostModal(post);
    card.querySelector('[data-act="share"]').onclick = async e => {
      await navigator.clipboard.writeText(postUrl(post));
      e.target.textContent = '🔗 copied!';
      setTimeout(() => { e.target.textContent = '🔗 share'; }, 1500);
    };
    card.querySelector('[data-act="want"]').onclick = () => toggleReaction(post, 'want');
    card.querySelector('[data-act="help"]').onclick = () => toggleReaction(post, 'help');
    card.querySelector('[data-act="add-content"]')?.addEventListener('click', () => openEditModal(post));
    card.querySelector('[data-act="delete"]')?.addEventListener('click', () => deletePost(post.id));
    card.querySelectorAll('[data-act="del-comment"]').forEach(b =>
      b.onclick = () => deleteComment(b.dataset.cid, post.id));
    card.querySelector('[data-act="comment-form"]')?.addEventListener('submit', e => {
      e.preventDefault();
      const input = e.target.elements.body;
      const body = input.value.trim();
      if (body) { addComment(post.id, body); input.value = ''; }
    });
  });
}

/* ---------------- content viewer ---------------- */

async function openContentModal(post) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal modal-wide"><div class="doc-loading">Loading content…</div></div>
    </div>`;
  document.getElementById('overlay').onclick = e => { if (e.target.id === 'overlay') root.innerHTML = ''; };

  const files = await loadFiles(post.id);
  const modal = root.querySelector('.modal');
  if (!modal) return;
  modal.innerHTML = `
    <div class="doc-header">
      <div>
        <h2>${esc(post.title)}</h2>
        <div class="doc-sub">${esc(post.tagline)}</div>
      </div>
      <button class="btn-secondary" id="doc-close">Close</button>
    </div>
    ${files.length ? files.map((f, i) => `
      <div class="doc-file">
        <div class="doc-file-bar">
          <span class="doc-filename">📄 ${esc(f.filename)}</span>
          <span class="doc-actions">
            <button class="btn-secondary btn-sm" data-copy="${i}">Copy</button>
            <button class="btn-secondary btn-sm" data-dl="${i}">Download</button>
          </span>
        </div>
        ${renderDoc(f.filename, f.content)}
      </div>`).join('')
      : `<div class="empty">No content attached.</div>`}`;
  document.getElementById('doc-close').onclick = () => { root.innerHTML = ''; };
  modal.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    await navigator.clipboard.writeText(files[+b.dataset.copy].content);
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  modal.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {
    const f = files[+b.dataset.dl];
    downloadText(f.filename, f.content);
  });
}


/* ---------------- share-kit parser ---------------- */

function parseShareKit(text) {
  const out = { fields: {}, files: [] };
  const grab = label => {
    const m = text.match(new RegExp('^[ \\t>*_-]*(?:\\*\\*|__)?' + label + '(?:\\*\\*|__)?[ \\t]*:[ \\t]*(.+)$', 'im'));
    return m ? m[1].trim().replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, '').trim() : '';
  };
  out.fields.title = grab('Title');
  out.fields.tagline = grab('Pitch') || grab('Tagline');
  let link = grab('Link');
  if (/leave blank|^none$|^n\/a$|^-$/i.test(link)) link = '';
  out.fields.link = /^https?:\/\//i.test(link) ? link : '';
  const whose = grab('Whose') || grab('Kind');
  out.fields.kind = /resource|guide|reference/i.test(whose) ? 'resource'
    : /problem|solve|need|ask/i.test(whose) ? 'problem'
    : (/working|progress|wip/i.test(whose) ? 'wip'
    : (/find|else/i.test(whose) ? 'find' : 'original'));
  const tagRaw = grab('Tag');
  out.fields.tag = TAGS.find(t => t.toLowerCase() === tagRaw.toLowerCase())
    || (tagRaw && TAGS.find(t => t.toLowerCase().includes(tagRaw.toLowerCase())))
    || (tagRaw && TAGS.find(t => tagRaw.toLowerCase().includes(t.toLowerCase())))
    || '';
  const collab = grab('Collab') || grab('Collaborators');
  out.fields.collab = /^y/i.test(collab);
  const cm = collab.match(/contact[ \t]*:[ \t]*(.+)/i);
  out.fields.contact = cm ? cm[1].trim() : '';
  // Files: a filename line (optionally bold or a heading), then a fenced block.
  const fileRx = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*|__)?(?:File[ \t]*:[ \t]*)?([\w][\w .()-]{0,110}\.[A-Za-z0-9]{1,8})(?:\*\*|__)?[ \t]*\n+(`{3,4})[^\n]*\n([\s\S]*?)\n\2(?=\s|$)/g;
  let m;
  while ((m = fileRx.exec(text))) {
    out.files.push({ filename: m[1].trim(), content: m[3] });
  }
  return out;
}

/* ---------------- share modal ---------------- */

function renderPendingFiles() {
  const box = document.getElementById('pending-files');
  if (!box) return;
  box.innerHTML = state.pendingFiles.map((f, i) => `
    <span class="pending-chip">📄 ${esc(f.filename)} <span class="pending-size">(${Math.ceil(f.content.length / 1000)}k)</span>
      <button type="button" class="pending-x" data-rm="${i}" title="Remove">✕</button>
    </span>`).join('');
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    state.pendingFiles.splice(+b.dataset.rm, 1);
    renderPendingFiles();
  });
}

function stageFile(filename, content, errBox) {
  if (!content.trim()) return;
  if (content.length > MAX_FILE_CHARS) {
    errBox.textContent = `${filename} is too big (${content.length} chars, max ${MAX_FILE_CHARS}). Text files only.`;
    return;
  }
  state.pendingFiles.push({ filename, content });
  errBox.textContent = '';
  renderPendingFiles();
}

async function openPostModal(remixSource = null, preset = null) {
  state.pendingFiles = [];
  state.remixOf = remixSource?.id ?? null;
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <h2>${remixSource ? 'Remix this build' : 'Share a build'}</h2>
        ${remixSource ? `<div class="remix-note">🔁 Starting from <b>${esc(remixSource.title)}</b>. Its content is preloaded below: change what you want, credit stays automatic.</div>` : ''}
        <form id="post-form">
          <div class="field">
            <input type="text" name="title" maxlength="100" required class="big-input" placeholder="Name it. That’s the only required field.">
          </div>
          <div class="field">
            <div class="hint">Add the actual stuff (optional): drop files anywhere on this window, upload, or paste below. Pasting a <a href="share-kit.md" target="_blank" rel="noopener">Share Kit</a> reply (<button type="button" class="linkish" id="copy-kit">copy the kit</button>) from Claude or ChatGPT fills the whole form for you.</div>
            <textarea id="smart-paste" rows="4" placeholder="Paste your prompt, doc, instructions, or your assistant’s Share Kit reply…"></textarea>
            <div class="kit-actions">
              <button type="button" class="btn-secondary btn-sm" id="smart-add">Add paste</button>
              <input type="file" id="file-input" multiple accept=".md,.markdown,.txt,.json,.csv,.js,.py,.html,.xml,.yaml,.yml,.toml">
              <span class="kit-status" id="kit-status"></span>
            </div>
            <div id="pending-files" class="pending-wrap"></div>
          </div>
          <details class="more-options">
            <summary>More options: pitch, link, tag, type, collaborators</summary>
            <div class="field" style="margin-top:.7rem">
              <label>One-line pitch</label>
              <input type="text" name="tagline" maxlength="240" placeholder="What it does and who it’s for">
            </div>
            <div class="field">
              <label>Link</label>
              <input type="url" name="link" placeholder="https://… (repo, GPT, demo, app)">
            </div>
            <div class="field">
              <label>Tag</label>
              <select name="tag">
                <option value="">No tag</option>
                ${TAGS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>What is this?</label>
              <div class="radio-row">
                <label class="radio-opt"><input type="radio" name="kind" value="original" checked> My build</label>
                <label class="radio-opt"><input type="radio" name="kind" value="wip"> 🔨 Working on it (in progress)</label>
                <label class="radio-opt"><input type="radio" name="kind" value="find"> 🔎 Someone else’s find</label>
                <label class="radio-opt"><input type="radio" name="kind" value="problem"> 🙋 A problem I want solved</label>
                <label class="radio-opt"><input type="radio" name="kind" value="resource"> 📚 A resource (guide, doc, or link worth keeping)</label>
              </div>
            </div>
            <div class="field check-row">
              <input type="checkbox" name="collab" id="collab-check">
              <label for="collab-check" style="margin:0">🤝 I’m looking for collaborators</label>
            </div>
            <div class="field" id="contact-field" style="display:none">
              <label>How should people reach you?</label>
              <input type="text" name="contact" maxlength="120" placeholder="e.g. Slack @yitzy, or email">
            </div>
          </details>
          <div class="form-error" id="form-error"></div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="cancel-btn">Cancel</button>
            <button type="submit" class="btn-primary">Post it</button>
          </div>
        </form>
      </div>
    </div>`;
  const overlay = document.getElementById('overlay');
  const errBox = document.getElementById('form-error');
  const form = document.getElementById('post-form');
  overlay.onclick = e => { if (e.target === overlay) { root.innerHTML = ''; state.remixOf = null; } };
  document.getElementById('cancel-btn').onclick = () => { root.innerHTML = ''; state.remixOf = null; };
  document.getElementById('collab-check').onchange = e => {
    document.getElementById('contact-field').style.display = e.target.checked ? '' : 'none';
  };
  document.getElementById('copy-kit').onclick = async e => {
    const btn = e.target;
    const kit = await fetch('share-kit.md').then(r => r.text());
    await navigator.clipboard.writeText(kit);
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = 'copy the kit'; }, 1500);
  };
  document.getElementById('file-input').onchange = async e => {
    for (const file of e.target.files) {
      const text = await file.text();
      stageFile(file.name, text, errBox);
    }
    e.target.value = '';
  };
  // Smart paste: a Share Kit reply fills the form; anything else becomes a content file.
  document.getElementById('smart-add').onclick = () => {
    const raw = document.getElementById('smart-paste').value;
    const status = document.getElementById('kit-status');
    if (!raw.trim()) { status.textContent = 'Paste something first.'; return; }
    const looksLikeKit = /^[ \t>*_-]*(?:\*\*|__)?Title(?:\*\*|__)?[ \t]*:/im.test(raw)
      && /^[ \t>*_-]*(?:\*\*|__)?(?:Pitch|Tagline|Tag|Whose|Collab)(?:\*\*|__)?[ \t]*:/im.test(raw);
    if (looksLikeKit) {
      const { fields, files } = parseShareKit(raw);
      if (fields.title) form.title.value = fields.title.slice(0, 100);
      if (fields.tagline) form.tagline.value = fields.tagline.slice(0, 240);
      if (fields.link) form.link.value = fields.link;
      form.tag.value = fields.tag || '';
      form.kind.value = fields.kind;
      form.collab.checked = fields.collab;
      document.getElementById('contact-field').style.display = fields.collab ? '' : 'none';
      if (fields.contact) form.contact.value = fields.contact.slice(0, 120);
      files.forEach(fl => stageFile(fl.filename, fl.content, errBox));
      document.querySelector('.more-options').open = true;
      status.textContent = `Share Kit read: form filled${files.length ? `, ${files.length} file${files.length > 1 ? 's' : ''} staged` : ''}. Review, then Post it.`;
    } else {
      const base = (form.title.value.trim() || 'content')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'content';
      stageFile(base + '.md', raw, errBox);
      status.textContent = 'Added as a content file.';
    }
    document.getElementById('smart-paste').value = '';
  };
  const modalEl = root.querySelector('.modal');
  modalEl.addEventListener('dragover', e => { e.preventDefault(); modalEl.classList.add('dragging'); });
  modalEl.addEventListener('dragleave', () => modalEl.classList.remove('dragging'));
  modalEl.addEventListener('drop', async e => {
    e.preventDefault(); modalEl.classList.remove('dragging');
    for (const file of e.dataTransfer.files) {
      const text = await file.text();
      stageFile(file.name, text, errBox);
    }
  });
  if (preset) {
    if (preset.title) form.title.value = preset.title.slice(0, 100);
    if (preset.kind) {
      form.kind.value = preset.kind;
      document.querySelector('.more-options').open = true;
    }
  }
  if (remixSource) {
    form.title.value = `${remixSource.title} (remix)`.slice(0, 100);
    if (remixSource.tagline) form.tagline.value = remixSource.tagline;
    form.tag.value = remixSource.tag || '';
    const srcFiles = await loadFiles(remixSource.id);
    srcFiles.forEach(fl => stageFile(fl.filename, fl.content, errBox));
  }
  form.onsubmit = async e => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting…';
    const err = await submitPost({
      title: form.title.value.trim(),
      tagline: form.tagline.value.trim(),
      link: form.link.value.trim(),
      tag: form.tag.value,
      kind: form.kind.value,
      collab: form.collab.checked,
      contact: form.contact.value.trim(),
    });
    if (err) {
      errBox.textContent = err;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Post it';
    } else {
      root.innerHTML = '';
    }
  };
}



/* ---------------- host a meeting ---------------- */

function openMeetingModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <h2>Host a meeting</h2>
        <form id="meeting-form">
          <div class="field">
            <input type="text" name="title" maxlength="100" required class="big-input" placeholder="e.g. Live coding session">
          </div>
          <div class="field">
            <label>When</label>
            <input type="datetime-local" name="when" required>
          </div>
          <div class="field">
            <label>Where (optional)</label>
            <input type="text" name="location" maxlength="200" placeholder="Room, or a Zoom/Meet link">
          </div>
          <div class="form-error" id="meeting-error"></div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="meeting-cancel">Cancel</button>
            <button type="submit" class="btn-primary">Put it on the board</button>
          </div>
        </form>
      </div>
    </div>`;
  const overlay = document.getElementById('overlay');
  overlay.onclick = e => { if (e.target === overlay) root.innerHTML = ''; };
  document.getElementById('meeting-cancel').onclick = () => { root.innerHTML = ''; };
  document.getElementById('meeting-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    const err = await addEvent({
      title: f.title.value.trim(),
      starts_at: new Date(f.when.value).toISOString(),
      location: f.location.value.trim(),
    });
    if (err) {
      document.getElementById('meeting-error').textContent = err;
      btn.disabled = false;
    } else {
      root.innerHTML = '';
      await loadEvents();
      render();
    }
  };
}

/* ---------------- add-details editor (own posts) ---------------- */

async function openEditModal(post) {
  state.pendingFiles = [];
  const existing = await loadFiles(post.id);
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <h2>Add to “${esc(post.title)}”</h2>
        <form id="edit-form">
          <div class="field">
            <label>Content</label>
            <div id="existing-files" class="pending-wrap">
              ${existing.map(f => `<span class="pending-chip">📄 ${esc(f.filename)}
                <button type="button" class="pending-x" data-delfile="${f.id}" title="Remove this file">✕</button></span>`).join('')}
            </div>
            <input type="file" id="edit-file-input" multiple accept=".md,.markdown,.txt,.json,.csv,.js,.py,.html,.xml,.yaml,.yml,.toml">
            <textarea id="edit-paste" rows="3" placeholder="Or paste content to attach…"></textarea>
            <div class="kit-actions">
              <button type="button" class="btn-secondary btn-sm" id="edit-paste-add">Add paste</button>
              <span class="kit-status" id="edit-status"></span>
            </div>
            <div id="pending-files" class="pending-wrap"></div>
          </div>
          <div class="field">
            <label>One-line pitch</label>
            <input type="text" name="tagline" maxlength="240" value="${esc(post.tagline ?? '')}" placeholder="What it does and who it’s for">
          </div>
          <div class="field">
            <label>Link</label>
            <input type="url" name="link" value="${esc(post.link ?? '')}" placeholder="https://…">
          </div>
          <div class="field">
            <label>Tag</label>
            <select name="tag">
              <option value="">No tag</option>
              ${TAGS.map(t => `<option value="${esc(t)}" ${post.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>What is this?</label>
            <div class="radio-row">
              <label class="radio-opt"><input type="radio" name="kind" value="original" ${post.kind === 'original' ? 'checked' : ''}> My build</label>
              <label class="radio-opt"><input type="radio" name="kind" value="wip" ${post.kind === 'wip' ? 'checked' : ''}> 🔨 Working on it</label>
              <label class="radio-opt"><input type="radio" name="kind" value="find" ${post.kind === 'find' ? 'checked' : ''}> 🔎 Someone else’s find</label>
              <label class="radio-opt"><input type="radio" name="kind" value="problem" ${post.kind === 'problem' ? 'checked' : ''}> 🙋 A problem I want solved</label>
              <label class="radio-opt"><input type="radio" name="kind" value="resource" ${post.kind === 'resource' ? 'checked' : ''}> 📚 A resource</label>
            </div>
          </div>
          <div class="field check-row">
            <input type="checkbox" name="collab" id="edit-collab" ${post.looking_for_collab ? 'checked' : ''}>
            <label for="edit-collab" style="margin:0">🤝 I’m looking for collaborators</label>
          </div>
          <div class="field" id="edit-contact-field" style="display:${post.looking_for_collab ? '' : 'none'}">
            <label>How should people reach you?</label>
            <input type="text" name="contact" maxlength="120" value="${esc(post.contact ?? '')}" placeholder="e.g. Slack @yitzy, or email">
          </div>
          <div class="form-error" id="edit-error"></div>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="edit-cancel">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>`;
  const overlay = document.getElementById('overlay');
  const errBox = document.getElementById('edit-error');
  const form = document.getElementById('edit-form');
  overlay.onclick = e => { if (e.target === overlay) root.innerHTML = ''; };
  document.getElementById('edit-cancel').onclick = () => { root.innerHTML = ''; };
  document.getElementById('edit-collab').onchange = e => {
    document.getElementById('edit-contact-field').style.display = e.target.checked ? '' : 'none';
  };
  root.querySelectorAll('[data-delfile]').forEach(b => b.onclick = async () => {
    await deleteFile(b.dataset.delfile, post.id);
    b.closest('.pending-chip').remove();
  });
  document.getElementById('edit-file-input').onchange = async e => {
    for (const file of e.target.files) {
      const text = await file.text();
      stageFile(file.name, text, errBox);
    }
    e.target.value = '';
  };
  document.getElementById('edit-paste-add').onclick = () => {
    const body = document.getElementById('edit-paste').value;
    if (!body.trim()) { document.getElementById('edit-status').textContent = 'Paste something first.'; return; }
    const base = post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'content';
    stageFile(base + '.md', body, errBox);
    document.getElementById('edit-paste').value = '';
    document.getElementById('edit-status').textContent = 'Staged. Hits the post when you Save.';
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    let err = await updatePost(post.id, {
      tagline: form.tagline.value.trim(),
      link: form.link.value.trim(),
      tag: form.tag.value,
      kind: form.kind.value,
      collab: form.collab.checked,
      contact: form.contact.value.trim(),
    });
    if (!err) err = await attachToPost(post.id, state.pendingFiles);
    if (err) {
      errBox.textContent = err;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    } else {
      state.pendingFiles = [];
      root.innerHTML = '';
      await loadFeed();
    }
  };
}

function render() {
  if (!state.session) loginView();
  else feedView();
}

/* ---------------- boot ---------------- */

captureAuthErrorFromUrl();

supabase.auth.onAuthStateChange((_event, session) => {
  const hadSession = !!state.session;
  state.session = session;
  if (session && !hadSession) {
    state.loginError = null;
    try {
      const dl = localStorage.getItem('bb-deeplink');
      if (dl) { localStorage.removeItem('bb-deeplink'); history.replaceState(null, '', location.pathname + dl); state.deepLinkDone = false; }
    } catch (e) {}
    loadFeed();
  }
  else if (!session && hadSession) render();
  // Token refreshes and tab-refocus events change nothing visible: leave the
  // DOM alone so open modals and half-typed forms survive.
});

const { data: { session } } = await supabase.auth.getSession();
state.session = session;
if (session) await loadFeed();
else render();
