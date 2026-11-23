// Завантажує фото з Unsplash (за наявності кешу — бере з .cache/), нарізає потрібні кадри
// та стискає їх у AVIF / WebP / JPEG різних ширин → public/img/.
// Також генерує іконки сайту з public/favicon.svg. Запуск: npm run photos
import sharp from "sharp";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache");
const out = path.join(root, "public", "img");

// Усі фото — за ліцензією Unsplash (https://unsplash.com/license): безкоштовно, у т.ч. комерційно, без обов'язкової атрибуції.
const SOURCES = {
  hero: { photo: "1585747860715-2ba37e788b70" },
  razor: { photo: "1599351431202-1e0f0137899a" },
  scissors: { photo: "1647140655214-e4a2d914971f" },
  tools: { photo: "1621605815971-fbc98d665033" },
  chair: { photo: "1621645582931-d1d3e6564943" },
  row: { photo: "1536520002442-39764a41e987" },
  shave: { photo: "1503951914875-452162b0f3f1" },
};

// Кадри: [назва, джерело, ширина/висота-співвідношення, ширини, позиція кропу]
const CROPS = [
  { name: "hero-wide", src: "hero", ratio: 16 / 9, widths: [1024, 1600, 2200], position: "centre" },
  { name: "hero-tall", src: "hero", ratio: 4 / 5, widths: [480, 800], position: "centre" },
  { name: "razor", src: "razor", ratio: 4 / 5, widths: [480, 800, 1200], position: "attention" },
  { name: "scissors", src: "scissors", ratio: 4 / 5, widths: [480, 800, 1200], position: "centre" },
  { name: "tools", src: "tools", ratio: 3 / 2, widths: [480, 800, 1200], position: "centre" },
  { name: "chair", src: "chair", ratio: 4 / 5, widths: [480, 800, 1200], position: "centre" },
  { name: "row", src: "row", ratio: 4 / 5, widths: [480, 800, 1200], position: "attention" },
  { name: "shave", src: "shave", ratio: 3 / 2, widths: [480, 800, 1200], position: "centre" },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function original(key) {
  const file = path.join(cache, `${SOURCES[key].photo}.jpg`);
  if (!(await exists(file))) {
    const url = `https://images.unsplash.com/photo-${SOURCES[key].photo}?w=2400&q=85&fm=jpg`;
    console.log("завантажую", url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });

for (const crop of CROPS) {
  const file = await original(crop.src);
  const meta = await sharp(file).metadata();
  // Спершу вирізаємо потрібне співвідношення сторін з оригіналу, потім масштабуємо до кожної ширини.
  let cw = meta.width;
  let ch = Math.round(cw / crop.ratio);
  if (ch > meta.height) {
    ch = meta.height;
    cw = Math.round(ch * crop.ratio);
  }
  for (const w of crop.widths) {
    const h = Math.round(w / crop.ratio);
    const base = () =>
      sharp(file).rotate().resize({
        width: w,
        height: h,
        fit: "cover",
        position: crop.position === "attention" ? sharp.strategy.attention : crop.position,
      });
    const stem = path.join(out, `${crop.name}-${w}`);
    await base().avif({ quality: 52, effort: 6 }).toFile(`${stem}.avif`);
    await base().webp({ quality: 74, effort: 6 }).toFile(`${stem}.webp`);
    await base().jpeg({ quality: 76, mozjpeg: true, progressive: true }).toFile(`${stem}.jpg`);
  }
  console.log("готово", crop.name, `(кадр ${cw}×${ch} з ${meta.width}×${meta.height})`);
}

// ——— іконки з favicon.svg ———
const svg = await readFile(path.join(root, "public", "favicon.svg"));
const png = (size) => sharp(svg, { density: Math.ceil((72 * size) / 64) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
await writeFile(path.join(root, "public", "apple-touch-icon.png"), await png(180));
await writeFile(path.join(root, "public", "icon-192.png"), await png(192));
await writeFile(path.join(root, "public", "icon-512.png"), await png(512));

// favicon.ico з двох PNG (32 і 16): заголовок ICONDIR + записи ICONDIRENTRY + самі PNG.
const sizes = [32, 16];
const pngs = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // тип: іконка
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0);
  e.writeUInt8(s, 1);
  e.writeUInt16LE(1, 4); // площини
  e.writeUInt16LE(32, 6); // біт на піксель
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
await writeFile(path.join(root, "public", "favicon.ico"), Buffer.concat([header, ...entries, ...pngs]));
console.log("іконки готові");
