// หน้าเว็บแบบ static: อ่าน content/index.json แล้วแสดงรายการเรื่องและหน้าเนื้อหา
// ข้อมูลจากดัชนีทุกชิ้นใส่ผ่าน textContent เสมอ ส่วนเนื้อหา Markdown ผ่าน DOMPurify ก่อนแสดง
(() => {
  'use strict';

  const main = document.getElementById('main');
  const state = {
    config: { siteName: 'คลังความรู้ ม.ปลาย', repoUrl: '' },
    index: null,
    filters: { q: '', level: 'all', subject: 'all' },
    token: 0,
    firstRoute: true,
  };
  const ACCESS_LABEL = { login: 'ต้องล็อกอิน', paid: 'มีค่าใช้จ่าย' };

  // ---------------------------------------------------------------- ตัวช่วย
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ใช้ต่อได้แม้เก็บไม่ได้ */ }
    },
  };
  const getDone = () => store.get('sl.done', {});
  function toggleDone(id) {
    const done = getDone();
    if (done[id]) delete done[id]; else done[id] = true;
    store.set('sl.done', done);
    return Boolean(done[id]);
  }

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined && c !== false) node.append(c);
    }
    return node;
  }

  const safeHttps = (u) => typeof u === 'string' && u.startsWith('https://');
  const nameOf = (list, id) => (list.find((x) => x.id === id) || { name: id }).name;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- Markdown + สูตร
  function stripFrontmatter(text) {
    return text.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  }

  function renderMarkdown(md) {
    if (!window.marked || !window.DOMPurify) {
      return `<pre class="plain">${escapeHtml(md)}</pre>`;
    }
    // เก็บสูตรไว้ก่อน เพราะ marked จะตีความ _ และ * ในสูตรผิด
    const math = [];
    const stash = (src, display) => `@@MATH${math.push({ src, display }) - 1}@@`;
    const pattern = /(```[\s\S]*?```|`[^`\n]+`)|\$\$([\s\S]+?)\$\$|\$([^\s$](?:[^\n$]*?[^\s$])?)\$/g;
    const prepared = md.replace(pattern, (whole, code, block, inline) => {
      if (code) return whole;
      return block !== undefined ? stash(block.trim(), true) : stash(inline, false);
    });
    const html = window.DOMPurify.sanitize(window.marked.parse(prepared, { gfm: true }));
    return html.replace(/@@MATH(\d+)@@/g, (_, i) => {
      const { src, display } = math[Number(i)];
      if (window.katex) {
        try {
          return window.katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore' });
        } catch { /* ตกไปแสดงเป็นข้อความ */ }
      }
      return escapeHtml(display ? `$$${src}$$` : `$${src}$`);
    });
  }

  // ---------------------------------------------------------------- โหลดข้อมูล
  async function loadData() {
    try {
      const r = await fetch('assets/config.json');
      if (r.ok) Object.assign(state.config, await r.json());
    } catch { /* ใช้ค่าเริ่มต้น */ }
    const r = await fetch('content/index.json');
    if (!r.ok) throw new Error(`โหลด content/index.json ไม่ได้ (${r.status})`);
    state.index = await r.json();
  }

  function setupChrome() {
    document.querySelectorAll('[data-site-name]').forEach((n) => { n.textContent = state.config.siteName; });
    const link = document.getElementById('repo-link');
    if (link && safeHttps(state.config.repoUrl)) {
      link.href = state.config.repoUrl;
      link.hidden = false;
    }
  }

  // ---------------------------------------------------------------- หน้าแรก
  function matches(t) {
    const f = state.filters;
    if (f.level !== 'all' && t.level !== f.level) return false;
    if (f.subject !== 'all' && t.subject !== f.subject) return false;
    const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = [t.title, t.summary, t.chapterTitle, ...t.tags].join(' ').toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  }

  function card(t, done) {
    const meta = h('div', { class: 'meta' },
      t.status === 'draft' ? h('span', { class: 'badge' }, 'ร่าง รอตรวจทาน') : null,
      t.exams.length ? h('span', { class: 'badge' }, `ข้อสอบ ${t.exams.length}`) : null,
      done[t.id] ? h('span', { class: 'badge ok' }, '✓ เรียนแล้ว') : null);
    return h('li', { class: 'card' },
      h('a', { class: 'card-link', href: `#/t/${t.id}` }, t.title),
      h('p', null, t.summary),
      meta);
  }

  function renderResults(container) {
    const { taxonomy, topics } = state.index;
    const done = getDone();
    const list = topics.filter(matches);
    container.replaceChildren();

    if (topics.length === 0) {
      container.append(h('p', { class: 'muted' }, 'ยังไม่มีเนื้อหา — เริ่มเพิ่มเรื่องแรกได้ตาม CONTRIBUTING.md'));
      return;
    }
    const doneCount = topics.filter((t) => done[t.id]).length;
    container.append(h('p', { class: 'muted', role: 'status' },
      list.length === 0
        ? 'ไม่พบเรื่องที่ตรงกับคำค้น'
        : `แสดง ${list.length} จาก ${topics.length} เรื่อง · เรียนแล้ว ${doneCount} เรื่อง`));

    const groups = new Map();
    for (const t of list) {
      const key = `${t.level}/${t.subject}`;
      if (!groups.has(key)) groups.set(key, { level: t.level, subject: t.subject, chapters: new Map() });
      const g = groups.get(key);
      if (!g.chapters.has(t.chapter)) g.chapters.set(t.chapter, { title: t.chapterTitle, items: [] });
      g.chapters.get(t.chapter).items.push(t);
    }
    for (const g of groups.values()) {
      const section = h('section', { class: 'group' },
        h('h2', null, `${nameOf(taxonomy.levels, g.level)} · ${nameOf(taxonomy.subjects, g.subject)}`));
      for (const [num, ch] of g.chapters) {
        section.append(
          h('h3', null, `บทที่ ${num} ${ch.title}`),
          h('ul', { class: 'cards' }, ch.items.map((t) => card(t, done))));
      }
      container.append(section);
    }
  }

  function chipGroup(label, key, options, results) {
    const buttons = options.map((o) => h('button', {
      type: 'button',
      class: 'chip',
      'data-id': o.id,
      'aria-pressed': String(state.filters[key] === o.id),
      onclick: () => {
        state.filters[key] = o.id;
        buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === o.id)));
        renderResults(results);
      },
    }, o.name));
    return h('div', { class: 'chips', role: 'group', 'aria-label': label },
      h('span', { class: 'chips-label', 'aria-hidden': 'true' }, label), buttons);
  }

  function renderHome() {
    state.token += 1;
    document.title = state.config.siteName;
    const { taxonomy } = state.index;
    const results = h('div', { id: 'results' });
    const search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: 'ค้นหา เช่น นิวตัน, ความเร่ง, กราฟ',
      'aria-label': 'ค้นหาเรื่อง',
      autocomplete: 'off',
      value: state.filters.q,
      oninput: (e) => { state.filters.q = e.target.value; renderResults(results); },
    });
    main.replaceChildren(
      h('section', { class: 'hero' },
        h('h1', null, 'เรียนรายเรื่อง ม.4 สายวิทย์-คณิตขึ้นไป'),
        h('p', null, 'สรุปเนื้อหา ตัวอย่าง แบบฝึกหัดพร้อมเฉลย และลิงก์ไปยังข้อสอบจริงที่เกี่ยวข้อง จัดเป็นรายเรื่อง เรียนต่อเนื่องหรือกระโดดไปเรื่องที่ต้องการได้'),
        search),
      h('div', { class: 'filters' },
        chipGroup('ระดับ', 'level', [{ id: 'all', name: 'ทั้งหมด' }, ...taxonomy.levels], results),
        chipGroup('วิชา', 'subject', [{ id: 'all', name: 'ทั้งหมด' }, ...taxonomy.subjects], results)),
      results);
    renderResults(results);
  }

  // ---------------------------------------------------------------- หน้าเรื่อง
  function examsSection(topic) {
    const section = h('section', { class: 'exams', 'aria-labelledby': 'exams-h' },
      h('h2', { id: 'exams-h' }, 'ข้อสอบจริงที่เกี่ยวข้อง'));
    if (!topic.exams.length) {
      section.append(h('p', { class: 'muted' },
        'ยังไม่มีลิงก์ข้อสอบสำหรับเรื่องนี้ — ช่วยเสนอลิงก์ได้ตามวิธีใน CONTRIBUTING.md'));
    } else {
      const rows = topic.exams.map((e) => h('tr', null,
        h('td', null, e.source),
        h('td', null, String(e.year)),
        h('td', null, e.item || '–'),
        h('td', null, e.note || ''),
        h('td', null,
          safeHttps(e.url)
            ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, 'เปิดที่ต้นทาง ↗')
            : '—',
          e.access && ACCESS_LABEL[e.access] ? [' ', h('span', { class: 'badge' }, ACCESS_LABEL[e.access])] : null)));
      section.append(h('div', { class: 'table-wrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            ['แหล่ง', 'ปี (พ.ศ.)', 'ข้อ', 'หมายเหตุ', 'ลิงก์'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, rows))));
    }
    section.append(h('p', { class: 'note' },
      'ข้อสอบเป็นลิขสิทธิ์ของเจ้าของข้อสอบ เว็บนี้เก็บเฉพาะลิงก์ไปยังหน้าต้นทาง ไม่ได้เก็บสำเนา'));
    return section;
  }

  function pagerLink(topic, cls, label) {
    if (!topic) return null;
    return h('a', { class: cls, href: `#/t/${topic.id}` }, h('small', null, label), topic.title);
  }

  async function renderTopic(id) {
    const token = ++state.token;
    const { taxonomy, topics } = state.index;
    const topic = topics.find((t) => t.id === id);
    if (!topic) { renderNotFound(); return; }

    document.title = `${topic.title} · ${state.config.siteName}`;
    main.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'กำลังโหลด…'));

    let markdown;
    try {
      const r = await fetch(`content/${topic.path}`);
      if (!r.ok) throw new Error(String(r.status));
      markdown = stripFrontmatter(await r.text());
    } catch (e) {
      if (token !== state.token) return;
      main.replaceChildren(
        h('p', { class: 'error' }, `โหลดเนื้อหาไม่สำเร็จ (${e.message})`),
        h('p', null, h('a', { href: '#/' }, '← กลับหน้าแรก')));
      return;
    }
    if (token !== state.token) return;

    const siblings = topics.filter((t) => t.level === topic.level && t.subject === topic.subject);
    const pos = siblings.findIndex((t) => t.id === topic.id);
    const isDone = Boolean(getDone()[topic.id]);
    const doneLabel = (on) => (on ? '✓ เรียนแล้ว' : 'ทำเครื่องหมายว่าเรียนแล้ว');

    const article = h('article', { class: 'prose' });
    article.innerHTML = renderMarkdown(markdown);
    article.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/i.test(a.getAttribute('href'))) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });

    main.replaceChildren(
      h('nav', { class: 'crumbs', 'aria-label': 'เส้นทาง' }, h('ol', null,
        h('li', null, h('a', { href: '#/' }, 'หน้าแรก')),
        h('li', null, nameOf(taxonomy.levels, topic.level)),
        h('li', null, nameOf(taxonomy.subjects, topic.subject)),
        h('li', null, `บทที่ ${topic.chapter} ${topic.chapterTitle}`))),
      h('header', { class: 'topic-head' },
        h('h1', null, topic.title),
        h('p', { class: 'lead' }, topic.summary),
        h('button', {
          type: 'button',
          class: 'btn',
          'aria-pressed': String(isDone),
          onclick: (e) => {
            const on = toggleDone(topic.id);
            e.currentTarget.setAttribute('aria-pressed', String(on));
            e.currentTarget.textContent = doneLabel(on);
          },
        }, doneLabel(isDone))),
      topic.status === 'draft'
        ? h('p', { class: 'draft-note', role: 'note' },
          'เนื้อหาเรื่องนี้เป็นฉบับร่าง ยังรอครูหรือผู้เชี่ยวชาญตรวจทาน หากพบจุดผิดพลาด ช่วยแจ้งผ่านหน้า Issues ของโปรเจกต์')
        : null,
      article,
      examsSection(topic),
      h('nav', { class: 'pager', 'aria-label': 'เรื่องก่อนหน้าและถัดไป' },
        pagerLink(siblings[pos - 1], 'prev', '← เรื่องก่อนหน้า'),
        pagerLink(siblings[pos + 1], 'next', 'เรื่องถัดไป →')));
  }

  function renderNotFound() {
    state.token += 1;
    document.title = `ไม่พบหน้านี้ · ${state.config.siteName}`;
    main.replaceChildren(
      h('h1', null, 'ไม่พบหน้านี้'),
      h('p', null, h('a', { href: '#/' }, '← กลับหน้าแรก')));
  }

  // ---------------------------------------------------------------- เริ่มทำงาน
  function route() {
    const m = location.hash.match(/^#\/t\/(.+)$/);
    if (m) {
      let id = null;
      try { id = decodeURIComponent(m[1]); } catch { /* ลิงก์เสีย */ }
      if (id === null) renderNotFound(); else renderTopic(id);
    } else {
      renderHome();
    }
    if (state.firstRoute) {
      state.firstRoute = false;
    } else {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  }

  (async function init() {
    try {
      await loadData();
    } catch (e) {
      main.replaceChildren(
        h('p', { class: 'error' }, 'โหลดข้อมูลไม่สำเร็จ'),
        h('p', { class: 'muted' }, `${e.message} — ถ้าเปิดไฟล์ตรงๆ ให้รัน npm run dev แล้วเปิด http://localhost:8080`));
      return;
    }
    setupChrome();
    window.addEventListener('hashchange', route);
    route();
  })();
})();
