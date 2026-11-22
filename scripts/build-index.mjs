#!/usr/bin/env node
// ตรวจเนื้อหาใน content/ แล้วสร้าง content/index.json ให้หน้าเว็บใช้
//   node scripts/build-index.mjs            ตรวจ + สร้างดัชนี
//   node scripts/build-index.mjs --check    ตรวจอย่างเดียว (ใช้ใน CI)
//   --content <โฟลเดอร์>  --out <ไฟล์>      เปลี่ยนตำแหน่ง (ใช้ตอนทดสอบ)
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : fallback;
};
const contentDir = option('--content', join(root, 'content'));
const out = option('--out', join(contentDir, 'index.json'));

const { index, errors, warnings } = await buildIndex({ contentDir });

for (const w of warnings) console.warn(`⚠  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(`\nพบข้อผิดพลาด ${errors.length} รายการ`);
  process.exit(1);
}

const topicCount = index.topics.length;
const examCount = index.topics.reduce((n, t) => n + t.exams.length, 0);
if (checkOnly) {
  console.log(`✔ ตรวจผ่าน: ${topicCount} เรื่อง, ลิงก์ข้อสอบ ${examCount} รายการ`);
} else {
  await writeFile(out, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`✔ สร้าง ${out}: ${topicCount} เรื่อง, ลิงก์ข้อสอบ ${examCount} รายการ`);
}
