// ตัวอ่าน frontmatter และตัวตรวจเนื้อหา — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** ปีข้อสอบต้องเป็น พ.ศ. ในช่วงนี้ */
export const YEAR_MIN = 2540;
export const YEAR_MAX = 2700;

/** ไฟล์ชนิดนี้ห้ามอยู่ใน content/ เพื่อไม่ให้เผลออัปโหลดสำเนาข้อสอบของคนอื่น */
const BLOCKED_EXT = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.rar', '.7z']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
const IMAGE_WARN_BYTES = 500 * 1024;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TOPIC_KEYS = new Set([
  'title', 'level', 'subject', 'chapter', 'chapterTitle', 'order',
  'summary', 'status', 'tags', 'authors', 'exams',
]);
const EXAM_KEYS = new Set(['source', 'year', 'item', 'url', 'note', 'access']);
const ACCESS = new Set(['free', 'login', 'paid']);
/** draft = ร่าง ยังไม่มีครูหรือผู้เชี่ยวชาญตรวจทาน, reviewed = ตรวจทานแล้ว */
const STATUS = new Set(['draft', 'reviewed']);

// ---------------------------------------------------------------- YAML ย่อส่วน
// รองรับเฉพาะรูปแบบที่ใช้ใน frontmatter ของโปรเจกต์นี้:
//   key: ค่า | key: [a, b] | key: (ตามด้วยรายการ "- ค่า" หรือ "- key: ค่า")

export function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '') return '';
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function splitInline(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map(parseScalar);
}

const BLANK = /^\s*(#.*)?$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

/** ตัดคอมเมนต์ท้ายบรรทัด (" # ...") โดยไม่แตะเครื่องหมาย # ที่อยู่ในเครื่องหมายคำพูดหรือติดกับตัวอักษร เช่น ลิงก์ที่มี #หัวข้อ */
export function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

export function parseYaml(src) {
  const lines = src.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) { i++; continue; }
    const m = line.match(KEY_VALUE);
    if (!m) throw new Error(`บรรทัด frontmatter ไม่ถูกต้อง: "${line.trim()}"`);
    const key = m[1];
    const rest = stripComment(m[2] ?? '').trim();
    if (rest !== '') {
      data[key] = rest.startsWith('[') && rest.endsWith(']')
        ? splitInline(rest.slice(1, -1))
        : parseScalar(rest);
      i++;
      continue;
    }
    // รายการแบบหลายบรรทัด
    const items = [];
    let current = null;
    i++;
    while (i < lines.length && (/^\s+\S/.test(lines[i]) || BLANK.test(lines[i]))) {
      const l = lines[i];
      i++;
      if (BLANK.test(l)) continue;
      const dash = l.match(/^\s+-\s+(.*)$/);
      if (dash) {
        const content = stripComment(dash[1]).trim();
        const kv = content.match(KEY_VALUE);
        if (kv) {
          current = { [kv[1]]: parseScalar(kv[2] ?? '') };
          items.push(current);
        } else {
          current = null;
          items.push(parseScalar(content));
        }
      } else {
        const kv = l.match(/^\s+([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
        if (!kv || !current) throw new Error(`บรรทัดในรายการไม่ถูกต้อง: "${l.trim()}"`);
        current[kv[1]] = parseScalar(stripComment(kv[2] ?? ''));
      }
    }
    data[key] = items;
  }
  return data;
}

export function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) throw new Error('ไม่พบ frontmatter (บล็อก --- ... --- ที่ต้นไฟล์)');
  return { data: parseYaml(m[1]), body: m[2] ?? '' };
}

// ---------------------------------------------------------------- ตรวจข้อมูล

function checkUrl(u) {
  if (typeof u !== 'string' || u.trim() === '') return 'ต้องมี "url" ของหน้าต้นทาง';
  let parsed;
  try { parsed = new URL(u); } catch { return `url ไม่ถูกต้อง: ${u}`; }
  if (parsed.protocol !== 'https:') return `url ต้องขึ้นต้นด้วย https:// (ได้รับ ${u})`;
  return null;
}

export function validateTopic(data, { level, subject, taxonomy }) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

  for (const k of ['title', 'chapterTitle', 'summary']) {
    if (!nonEmpty(data[k])) err(`ต้องมี "${k}" เป็นข้อความ`);
  }
  for (const k of ['chapter', 'order']) {
    if (!Number.isInteger(data[k]) || data[k] < 1) err(`"${k}" ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`);
  }

  const levelIds = taxonomy.levels.map((l) => l.id);
  if (!levelIds.includes(data.level)) {
    err(`level "${data.level}" ไม่อยู่ใน taxonomy (ใช้ได้: ${levelIds.join(', ')})`);
  } else if (data.level !== level) {
    err(`level ใน frontmatter ("${data.level}") ไม่ตรงกับโฟลเดอร์ ("${level}")`);
  }
  const subjectIds = taxonomy.subjects.map((s) => s.id);
  if (!subjectIds.includes(data.subject)) {
    err(`subject "${data.subject}" ไม่อยู่ใน taxonomy (ใช้ได้: ${subjectIds.join(', ')})`);
  } else if (data.subject !== subject) {
    err(`subject ใน frontmatter ("${data.subject}") ไม่ตรงกับโฟลเดอร์ ("${subject}")`);
  }

  if (data.status !== undefined && !STATUS.has(data.status)) {
    err(`"status" ต้องเป็น draft หรือ reviewed (ได้รับ "${data.status}")`);
  }

  for (const k of ['tags', 'authors']) {
    if (data[k] === undefined) continue;
    if (!Array.isArray(data[k]) || data[k].some((t) => !nonEmpty(t))) {
      err(`"${k}" ต้องเป็นรายการข้อความ เช่น [ความเร็ว, กราฟ]`);
    }
  }

  if (data.exams !== undefined) {
    if (!Array.isArray(data.exams)) {
      err('"exams" ต้องเป็นรายการ');
    } else {
      data.exams.forEach((e, i) => {
        const at = `exams[${i + 1}]`;
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          err(`${at}: ต้องเป็นชุดข้อมูล (source, year, url, ...)`);
          return;
        }
        if (!nonEmpty(e.source)) err(`${at}: ต้องมี "source" (ชื่อแหล่งข้อสอบ)`);
        if (!Number.isInteger(e.year) || e.year < YEAR_MIN || e.year > YEAR_MAX) {
          err(`${at}: "year" ต้องเป็นปี พ.ศ. (${YEAR_MIN}–${YEAR_MAX}) แต่ได้รับ "${e.year}"`);
        }
        const urlProblem = checkUrl(e.url);
        if (urlProblem) err(`${at}: ${urlProblem}`);
        if (e.access !== undefined && !ACCESS.has(e.access)) {
          err(`${at}: "access" ต้องเป็น free, login หรือ paid`);
        }
        for (const k of ['item', 'note']) {
          if (e[k] !== undefined && typeof e[k] !== 'string' && !Number.isInteger(e[k])) {
            err(`${at}: "${k}" ต้องเป็นข้อความ`);
          }
        }
        for (const k of Object.keys(e)) {
          if (!EXAM_KEYS.has(k)) warnings.push(`${at}: ไม่รู้จักฟิลด์ "${k}"`);
        }
      });
    }
  }

  for (const k of Object.keys(data)) {
    if (!TOPIC_KEYS.has(k)) warnings.push(`ไม่รู้จักฟิลด์ "${k}"`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- ตรวจรูปภาพในเนื้อหา

const IMG_MARKDOWN = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const IMG_HTML = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/** รูปต้องเป็นไฟล์ภาพที่อยู่ใน content/ เท่านั้น ไม่ลิงก์รูปจากเว็บอื่น (กันการส่งข้อมูลผู้เรียนออกนอกเว็บ) */
async function checkImages(body, file, contentDir) {
  const errors = [];
  const warnings = [];
  const text = body.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  const refs = [
    ...[...text.matchAll(IMG_MARKDOWN)].map((m) => ({ alt: m[1], src: m[2] })),
    ...[...text.matchAll(IMG_HTML)].map((m) => ({ alt: null, src: m[1] })),
  ];
  for (const { alt, src } of refs) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
      errors.push(`รูป "${src}": ต้องเป็นไฟล์ในโปรเจกต์ ไม่ใช่ลิงก์ภายนอก`);
      continue;
    }
    if (alt !== null && alt.trim() === '') {
      warnings.push(`รูป "${src}": ควรใส่คำอธิบายภาพ (alt) ในวงเล็บเหลี่ยม`);
    }
    let clean;
    try { clean = decodeURIComponent(src.split(/[?#]/)[0]); } catch { clean = src; }
    if (!IMAGE_EXT.has(extname(clean).toLowerCase())) {
      errors.push(`รูป "${src}": ต้องเป็นไฟล์ภาพ (${[...IMAGE_EXT].join(', ')})`);
      continue;
    }
    const target = resolve(dirname(file), clean);
    const rel = relative(contentDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      errors.push(`รูป "${src}": ต้องอยู่ภายในโฟลเดอร์ content/`);
      continue;
    }
    try { await access(target); } catch { errors.push(`รูป "${src}": ไม่พบไฟล์`); }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- สร้างดัชนี

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export async function buildIndex({ contentDir, taxonomy } = {}) {
  const errors = [];
  const warnings = [];
  if (!taxonomy) {
    taxonomy = JSON.parse(await readFile(join(contentDir, 'taxonomy.json'), 'utf8'));
  }
  const levelRank = new Map(taxonomy.levels.map((l, i) => [l.id, i]));
  const subjectRank = new Map(taxonomy.subjects.map((s, i) => [s.id, i]));

  const files = (await walk(contentDir)).sort();
  const topics = [];
  const positions = new Map();
  const chapterTitles = new Map();

  for (const file of files) {
    const rel = relative(contentDir, file).split(sep).join('/');
    const ext = extname(file).toLowerCase();

    if (BLOCKED_EXT.has(ext)) {
      errors.push(`${rel}: ไม่อนุญาตไฟล์ ${ext} ใน content/ — ข้อสอบของผู้อื่นให้ใส่เป็นลิงก์ใน exams แทนการเก็บสำเนา (ดู CONTRIBUTING.md)`);
      continue;
    }
    if (IMAGE_EXT.has(ext)) {
      const size = (await stat(file)).size;
      if (size > IMAGE_WARN_BYTES) {
        warnings.push(`${rel}: รูปใหญ่ ${(size / 1024).toFixed(0)} KB ควรย่อให้ไม่เกิน ${IMAGE_WARN_BYTES / 1024} KB (และต้องเป็นภาพที่วาด/ถ่ายเอง ไม่ใช่ภาพสแกนข้อสอบ)`);
      }
      continue;
    }
    if (ext !== '.md' || rel === 'README.md') continue;

    const parts = rel.split('/');
    if (parts.length !== 3) {
      errors.push(`${rel}: ไฟล์เนื้อหาต้องอยู่ที่ <level>/<subject>/<slug>.md`);
      continue;
    }
    const [level, subject, fileName] = parts;
    const slug = fileName.slice(0, -3);
    if (!SLUG_RE.test(slug)) {
      errors.push(`${rel}: ชื่อไฟล์ต้องเป็นตัวพิมพ์เล็ก ตัวเลข และขีดกลาง เช่น newtons-laws.md`);
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(await readFile(file, 'utf8'));
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
      continue;
    }
    const { data, body } = parsed;
    const result = validateTopic(data, { level, subject, taxonomy });
    result.errors.forEach((m) => errors.push(`${rel}: ${m}`));
    result.warnings.forEach((m) => warnings.push(`${rel}: ${m}`));
    if (body.trim() === '') errors.push(`${rel}: ไม่มีเนื้อหาหลังบล็อก frontmatter`);
    const images = await checkImages(body, file, contentDir);
    images.errors.forEach((m) => errors.push(`${rel}: ${m}`));
    images.warnings.forEach((m) => warnings.push(`${rel}: ${m}`));
    if (images.errors.length) continue;
    if (result.errors.length) continue;

    const posKey = `${level}/${subject}/${data.chapter}/${data.order}`;
    if (positions.has(posKey)) {
      errors.push(`${rel}: chapter ${data.chapter} order ${data.order} ซ้ำกับ ${positions.get(posKey)}`);
      continue;
    }
    positions.set(posKey, rel);

    const chapterKey = `${level}/${subject}/${data.chapter}`;
    if (chapterTitles.has(chapterKey) && chapterTitles.get(chapterKey) !== data.chapterTitle) {
      warnings.push(`${rel}: chapterTitle "${data.chapterTitle}" ไม่ตรงกับเรื่องอื่นในบทเดียวกัน ("${chapterTitles.get(chapterKey)}")`);
    } else {
      chapterTitles.set(chapterKey, data.chapterTitle);
    }

    const entry = {
      id: `${level}/${subject}/${slug}`,
      path: rel,
      title: data.title,
      level,
      subject,
      chapter: data.chapter,
      chapterTitle: data.chapterTitle,
      order: data.order,
      summary: data.summary,
      status: data.status ?? 'draft',
      tags: data.tags ?? [],
      exams: (data.exams ?? []).map((e) => ({
        source: e.source,
        year: e.year,
        ...(e.item !== undefined && e.item !== '' ? { item: String(e.item) } : {}),
        url: e.url,
        ...(e.note ? { note: e.note } : {}),
        ...(e.access ? { access: e.access } : {}),
      })),
    };
    if (data.authors?.length) entry.authors = data.authors;
    topics.push(entry);
  }

  topics.sort((a, b) =>
    levelRank.get(a.level) - levelRank.get(b.level)
    || subjectRank.get(a.subject) - subjectRank.get(b.subject)
    || a.chapter - b.chapter
    || a.order - b.order
    || a.id.localeCompare(b.id));

  return { index: { taxonomy, topics }, errors, warnings };
}
