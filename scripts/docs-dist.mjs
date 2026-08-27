// docs/dist — реальный артефакт собранного сайта.
// nuxi generate (Docus) пишет сайт в .output/public и дополнительно создаёт
// docs/dist как СИМЛИНК на него — а симлинк выглядит как «пустой каталог»
// при проверках по размеру (du -sb → 0) и не попадает в git-деливер.
// Этот шаг заменяет симлинк реальной копией — docs/dist становится настоящим
// каталогом с файлами, который коммитится. Запускать из docs/ ПОСЛЕ generate.
import { rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
cpSync('.output/public', 'dist', { recursive: true });
console.log('docs/dist: real directory created from .output/public');

// GitHub Pages project site lives under /schedjs/ (repo schedjs/schedjs).
// Docus/Nuxt emit two root-absolute URLs that ignore app.baseURL:
//   1) index.html meta-refresh home redirect (`url=/docs/introduction`)
//   2) `<link rel="icon" href="/favicon.ico">` on every page
// Without the base they hit the org root → 404 (redirect loop / broken icon).
const BASE = '/schedjs/';

// 1) home → first docs page redirect
const indexFile = 'dist/index.html';
const indexHtml = readFileSync(indexFile, 'utf8');
writeFileSync(indexFile, indexHtml.replace('url=/docs/', `url=${BASE}docs/`));

// 2) favicon link on every html page
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.html') && !ent.name.startsWith('_')) {
      const html = readFileSync(p, 'utf8');
      if (html.includes('href="/favicon.ico"')) {
        writeFileSync(p, html.split('href="/favicon.ico"').join(`href="${BASE}favicon.ico"`));
      }
    }
  }
}
walk('dist');
console.log(`baseURL fixes applied (redirect → ${BASE}docs/…, favicon → ${BASE}favicon.ico)`);
