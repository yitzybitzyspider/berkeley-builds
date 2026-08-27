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
  openComments: new Set(),
  commentCache: {},     // postId -> comments[]
  fileCache: {},        // postId -> files[] (with content)
  pendingFiles: [],     // files staged in the share modal
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

/* ---------------- data ---------------- */

async function loadFeed() {
  const { data, error } = await supabase
    .from('posts')
    .select('*, profiles:profiles!posts_author_fkey(name, avatar_url), votes(user_id), comments(id), post_files(id, filename)')
    .order('created_at', { ascending: false });
  if (error) { console.error('loadFeed', error); return; }
  state.posts = data ?? [];
  render();
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

async function submitPost(fields) {
  const { data, error } = await supabase.from('posts').insert({
    author: state.session.user.id,
    title: fields.title,
    tagline: fields.tagline,
    link: fields.link || null,
    tag: fields.tag,
    kind: fields.kind,
    looking_for_collab: fields.collab,
    contact: fields.collab ? (fields.contact || null) : null,
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
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
  };
}

function visiblePosts() {
  let posts = [...state.posts];
  if (state.tag) posts = posts.filter(p => p.tag === state.tag);
  if (state.collabOnly) posts = posts.filter(p => p.looking_for_collab);
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
  <div class="card" data-id="${p.id}">
    <button class="vote ${voted ? 'voted' : ''}" data-act="vote" title="${voted ? 'Remove upvote' : 'Upvote'}">
      <span class="tri">▲</span><span class="count">${p.votes.length}</span>
    </button>
    <div class="card-body">
      <div class="card-title">${p.link
        ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a>`
        : esc(p.title)}</div>
      <div class="card-tagline">${esc(p.tagline)}</div>
      ${files.length ? `
      <div class="file-row">
        ${files.map(f => `<button class="file-chip" data-act="open-files" title="View content">📄 ${esc(f.filename)}</button>`).join('')}
      </div>` : ''}
      <div class="card-meta">
        <span class="tag-pill">${esc(p.tag)}</span>
        ${p.kind === 'find' ? `<span class="find-badge">🔎 Shared find</span>` : ''}
        ${p.looking_for_collab ? `<span class="collab-badge">🤝 Looking for collaborators${p.contact ? ` · ${esc(p.contact)}` : ''}</span>` : ''}
        <span class="meta-author">
          ${author.avatar_url ? `<img src="${esc(author.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
          ${esc(author.name ?? 'Someone')}
        </span>
        <span>·</span><span>${timeAgo(p.created_at)}</span>
        <span>·</span>
        <button class="linkish" data-act="comments">${open ? 'Hide' : ''} ${p.comments.length} comment${p.comments.length === 1 ? '' : 's'}</button>
        ${mine ? `<span>·</span><button class="linkish danger" data-act="delete">delete</button>` : ''}
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

function feedView() {
  const posts = visiblePosts();
  const u = state.session.user;
  const meta = u.user_metadata ?? {};
  app.innerHTML = `
    <header>
      <div class="header-inner">
        <span class="logo">Berkeley <span class="gold">Builds</span> 🐻</span>
        <div class="header-spacer"></div>
        <button class="share-btn" id="new-post-btn">+ Share a build</button>
        ${meta.avatar_url ? `<img class="avatar" src="${esc(meta.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <button class="signout" id="signout-btn">Sign out</button>
      </div>
    </header>
    <main>
      <div class="controls">
        <div class="sort-tabs">
          <button data-sort="new" class="${state.sort === 'new' ? 'active' : ''}">Newest</button>
          <button data-sort="top" class="${state.sort === 'top' ? 'active' : ''}">Top</button>
        </div>
        ${TAGS.map(t => `<button class="chip ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
        <button class="chip ${state.collabOnly ? 'active' : ''}" id="collab-filter">🤝 Wants collaborators</button>
      </div>
      <div id="feed">
        ${posts.length ? posts.map(postCard).join('')
          : `<div class="empty">Nothing here yet${state.tag || state.collabOnly ? ' for this filter' : ''}. Be the first to share what you’re building.</div>`}
      </div>
      <footer>Berkeley Builds v${APP_VERSION} · built by Haas students, for Haas students</footer>
    </main>
    <div id="modal-root"></div>`;

  document.getElementById('new-post-btn').onclick = openPostModal;
  document.getElementById('signout-btn').onclick = async () => { await supabase.auth.signOut(); };
  document.getElementById('collab-filter').onclick = () => { state.collabOnly = !state.collabOnly; render(); };
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

function openPostModal() {
  state.pendingFiles = [];
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <h2>Share a build</h2>
        <form id="post-form">
          <div class="field">
            <label>Title</label>
            <input type="text" name="title" maxlength="100" required placeholder="e.g. The Resume System">
          </div>
          <div class="field">
            <label>One-line pitch</label>
            <input type="text" name="tagline" maxlength="240" required placeholder="What it does and who it's for, in one sentence">
          </div>
          <div class="field">
            <label>Link (optional)</label>
            <input type="url" name="link" placeholder="https://…">
            <div class="hint">Demo, GPT link, repo, deck. Ideas with no link are welcome too.</div>
          </div>
          <div class="field">
            <label>Content (optional, this is the good part)</label>
            <div class="hint" style="margin-bottom:.4rem">Attach the actual thing: Claude Project instructions, a prompt, a system doc. Classmates can read, copy, and download it right in the feed.</div>
            <input type="file" id="file-input" multiple accept=".md,.markdown,.txt,.json,.csv,.js,.py,.html,.xml,.yaml,.yml,.toml">
            <div id="pending-files" class="pending-wrap"></div>
            <details class="paste-details">
              <summary>Or paste content directly</summary>
              <input type="text" id="paste-name" placeholder="Name it, e.g. system-prompt.md" maxlength="120" style="margin:.4rem 0">
              <textarea id="paste-body" rows="6" placeholder="Paste your prompt, instructions, or doc here…"></textarea>
              <button type="button" class="btn-secondary btn-sm" id="paste-add" style="margin-top:.4rem">Add to post</button>
            </details>
          </div>
          <div class="field">
            <label>Whose is it?</label>
            <div class="radio-row">
              <label class="radio-opt"><input type="radio" name="kind" value="original" checked> My build</label>
              <label class="radio-opt"><input type="radio" name="kind" value="find"> Someone else's find (a repo, app, or doc worth sharing)</label>
            </div>
          </div>
          <div class="field">
            <label>Tag</label>
            <select name="tag" required>
              ${TAGS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
            </select>
          </div>
          <div class="field check-row">
            <input type="checkbox" name="collab" id="collab-check">
            <label for="collab-check" style="margin:0">🤝 I’m looking for collaborators</label>
          </div>
          <div class="field" id="contact-field" style="display:none">
            <label>How should people reach you?</label>
            <input type="text" name="contact" maxlength="120" placeholder="e.g. Slack @yitzy, or email">
          </div>
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
  overlay.onclick = e => { if (e.target === overlay) root.innerHTML = ''; };
  document.getElementById('cancel-btn').onclick = () => { root.innerHTML = ''; };
  document.getElementById('collab-check').onchange = e => {
    document.getElementById('contact-field').style.display = e.target.checked ? '' : 'none';
  };
  document.getElementById('file-input').onchange = async e => {
    for (const file of e.target.files) {
      const text = await file.text();
      stageFile(file.name, text, errBox);
    }
    e.target.value = '';
  };
  document.getElementById('paste-add').onclick = () => {
    const name = document.getElementById('paste-name').value.trim() || 'untitled.md';
    const body = document.getElementById('paste-body').value;
    if (!body.trim()) { errBox.textContent = 'Paste some content first.'; return; }
    stageFile(name, body, errBox);
    document.getElementById('paste-name').value = '';
    document.getElementById('paste-body').value = '';
  };
  document.getElementById('post-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const err = await submitPost({
      title: f.title.value.trim(),
      tagline: f.tagline.value.trim(),
      link: f.link.value.trim(),
      tag: f.tag.value,
      kind: f.kind.value,
      collab: f.collab.checked,
      contact: f.contact.value.trim(),
    });
    if (err) errBox.textContent = err;
    else root.innerHTML = '';
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
  if (session && !hadSession) { state.loginError = null; loadFeed(); }
  else render();
});

const { data: { session } } = await supabase.auth.getSession();
state.session = session;
if (session) await loadFeed();
else render();
