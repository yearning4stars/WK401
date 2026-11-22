import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildIndex, parseFrontmatter, parseYaml, stripComment,
} from '../scripts/lib.mjs';

const taxonomy = {
  levels: [{ id: 'm4', name: 'ม.4' }, { id: 'm5', name: 'ม.5' }],
  subjects: [{ id: 'physics', name: 'ฟิสิกส์' }, { id: 'math', name: 'คณิตศาสตร์' }],
};

const topic = (overrides = {}, extra = '') => {
  const base = {
    title: 'เรื่องทดสอบ',
    level: 'm4',
    subject: 'physics',
    chapter: 1,
    chapterTitle: 'บทแรก',
    order: 1,
    summary: 'สรุป',
    ...overrides,
  };
  const lines = Object.entries(base).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n${extra}---\n\nเนื้อหา\n`;
};

/** สร้างโฟลเดอร์ content ชั่วคราวจากแผนที่ path -> เนื้อไฟล์ */
async function withContent(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'student-library-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const build = (files) => withContent(files, (contentDir) => buildIndex({ contentDir, taxonomy }));
const has = (errors, text) => errors.some((e) => e.includes(text));

// ------------------------------------------------------------------ parser

test('parseYaml: ค่าเดี่ยว รายการในบรรทัดเดียว และรายการแบบหลายบรรทัด', () => {
  const data = parseYaml([
    'title: "ชื่อ: มีโคลอน"',
    'chapter: 3',
    'flag: true',
    'tags: [ความเร็ว, "กราฟ, v-t"]',
    'exams:',
    '  - source: สอวน.',
    '    year: 2566',
    '    url: https://example.org/a#part',
    '  - source: อีกแหล่ง',
    '    year: 2565',
  ].join('\n'));
  assert.equal(data.title, 'ชื่อ: มีโคลอน');
  assert.equal(data.chapter, 3);
  assert.equal(data.flag, true);
  assert.deepEqual(data.tags, ['ความเร็ว', 'กราฟ, v-t']);
  assert.equal(data.exams.length, 2);
  assert.equal(data.exams[0].url, 'https://example.org/a#part');
  assert.equal(data.exams[1].year, 2565);
});

test('parseYaml: ข้ามคอมเมนต์ และตัดคอมเมนต์ท้ายบรรทัด แต่ไม่ตัด # ในลิงก์', () => {
  const data = parseYaml([
    '# คอมเมนต์ทั้งบรรทัด',
    'level: m4      # m4 | m5 | m6',
    'url: https://example.org/x#y',
    'exams: []',
  ].join('\n'));
  assert.equal(data.level, 'm4');
  assert.equal(data.url, 'https://example.org/x#y');
  assert.deepEqual(data.exams, []);
  assert.equal(stripComment('"a # b" # c').trim(), '"a # b"');
});

test('parseYaml: บรรทัดผิดรูปแบบต้อง throw', () => {
  assert.throws(() => parseYaml('นี่ไม่ใช่ key'), /ไม่ถูกต้อง/);
});

test('parseFrontmatter: แยกเนื้อหา และ throw เมื่อไม่มี frontmatter', () => {
  const { data, body } = parseFrontmatter('---\ntitle: ก\n---\nสวัสดี\n');
  assert.equal(data.title, 'ก');
  assert.equal(body.trim(), 'สวัสดี');
  assert.throws(() => parseFrontmatter('ไม่มี frontmatter'), /frontmatter/);
});

// ------------------------------------------------------------------ ดัชนี

test('buildIndex: เนื้อหาถูกต้อง ผ่านและเรียงตามระดับ วิชา บท ลำดับ', async () => {
  const exams = 'exams:\n  - source: ตัวอย่าง\n    year: 2566\n    item: ข้อ 3\n    url: https://example.org/exam\n    access: login\n';
  const { index, errors } = await build({
    'm4/physics/b-second.md': topic({ order: 2, title: 'สอง' }),
    'm4/physics/a-first.md': topic({ order: 1, title: 'หนึ่ง' }, exams),
    'm4/physics/c-chapter2.md': topic({ chapter: 2, order: 1, chapterTitle: 'บทสอง', title: 'สาม' }),
    'm4/math/limits.md': topic({ subject: 'math', title: 'คณิต' }),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    index.topics.map((t) => t.id),
    ['m4/physics/a-first', 'm4/physics/b-second', 'm4/physics/c-chapter2', 'm4/math/limits'],
  );
  const first = index.topics[0];
  assert.equal(first.status, 'draft');
  assert.deepEqual(first.exams, [
    { source: 'ตัวอย่าง', year: 2566, item: 'ข้อ 3', url: 'https://example.org/exam', access: 'login' },
  ]);
});

test('buildIndex: ปฏิเสธลิงก์ข้อสอบที่ไม่ใช่ https หรือปีไม่ใช่ พ.ศ.', async () => {
  const bad = 'exams:\n  - source: ก\n    year: 2023\n    url: http://example.org/exam\n  - source: ข\n    year: 2566\n    url: ไม่ใช่ลิงก์\n  - source: ค\n    year: 2566\n';
  const { errors } = await build({ 'm4/physics/x.md': topic({}, bad) });
  assert.ok(has(errors, 'exams[1]: "year" ต้องเป็นปี พ.ศ.'), errors.join('\n'));
  assert.ok(has(errors, 'exams[1]: url ต้องขึ้นต้นด้วย https://'), errors.join('\n'));
  assert.ok(has(errors, 'exams[2]: url ไม่ถูกต้อง'), errors.join('\n'));
  assert.ok(has(errors, 'exams[3]: ต้องมี "url"'), errors.join('\n'));
});

test('buildIndex: ห้ามมีไฟล์ PDF/Word ใน content', async () => {
  const { errors } = await build({
    'm4/physics/x.md': topic(),
    'm4/physics/exam-2566.pdf': '%PDF-1.4',
    'm4/physics/exam.docx': 'x',
  });
  assert.ok(has(errors, 'exam-2566.pdf: ไม่อนุญาตไฟล์ .pdf'), errors.join('\n'));
  assert.ok(has(errors, 'exam.docx: ไม่อนุญาตไฟล์ .docx'), errors.join('\n'));
});

test('buildIndex: level/subject ไม่ตรงโฟลเดอร์ หรือไม่อยู่ใน taxonomy', async () => {
  const { errors } = await build({
    'm4/physics/wrong-level.md': topic({ level: 'm5' }),
    'm4/physics/unknown-subject.md': topic({ subject: 'art' }),
  });
  assert.ok(has(errors, 'level ใน frontmatter ("m5") ไม่ตรงกับโฟลเดอร์ ("m4")'), errors.join('\n'));
  assert.ok(has(errors, 'subject "art" ไม่อยู่ใน taxonomy'), errors.join('\n'));
});

test('buildIndex: ฟิลด์ที่จำเป็นขาด ลำดับซ้ำ ชื่อไฟล์ผิด และตำแหน่งไฟล์ผิด', async () => {
  const noChapterTitle = topic().replace(/chapterTitle: .*\n/, '');
  const { errors } = await build({
    'm4/physics/missing.md': noChapterTitle,
    'm4/physics/dup-a.md': topic(),
    'm4/physics/dup-b.md': topic(),
    'm4/physics/ชื่อไทย.md': topic({ order: 5 }),
    'm4/physics/deep/nested.md': topic({ order: 6 }),
    'm4/physics/empty.md': '---\ntitle: x\n---\n',
  });
  assert.ok(has(errors, 'missing.md: ต้องมี "chapterTitle"'), errors.join('\n'));
  assert.ok(has(errors, 'dup-b.md: chapter 1 order 1 ซ้ำกับ m4/physics/dup-a.md'), errors.join('\n'));
  assert.ok(has(errors, 'ชื่อไฟล์ต้องเป็นตัวพิมพ์เล็ก'), errors.join('\n'));
  assert.ok(has(errors, 'ไฟล์เนื้อหาต้องอยู่ที่ <level>/<subject>/<slug>.md'), errors.join('\n'));
  assert.ok(has(errors, 'empty.md: ต้องมี "title"') || has(errors, 'empty.md:'), errors.join('\n'));
});

test('buildIndex: status ต้องเป็น draft หรือ reviewed', async () => {
  const { errors, index } = await build({
    'm4/physics/ok.md': topic({ status: 'reviewed' }),
    'm4/physics/bad.md': topic({ status: 'done', order: 2 }),
  });
  assert.ok(has(errors, 'bad.md: "status" ต้องเป็น draft หรือ reviewed'), errors.join('\n'));
  assert.equal(index.topics.find((t) => t.id === 'm4/physics/ok').status, 'reviewed');
});

test('buildIndex: ฟิลด์ที่ไม่รู้จักเป็นแค่คำเตือน ไม่ทำให้ตรวจไม่ผ่าน', async () => {
  const { errors, warnings } = await build({ 'm4/physics/x.md': topic({ hello: 'world' }) });
  assert.deepEqual(errors, []);
  assert.ok(has(warnings, 'ไม่รู้จักฟิลด์ "hello"'));
});
