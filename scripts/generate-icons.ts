/**
 * Generates the favicon set in public/ from the Kataster brand sources.
 * Source of truth: brand/kataster-favicon.svg (tab icon), brand/kataster-icon-source.svg
 * (rounded app icon), brand/kataster-apple-touch-source.svg (square, no radius).
 * Run: bun run icons
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const ROOT = process.cwd();
const BRAND = join(ROOT, "brand");
const OUT = join(ROOT, "public");

const png = (svg: string, size: number) =>
  sharp(join(BRAND, svg), { density: 384 }).resize(size, size).png();

async function main() {
  await mkdir(OUT, { recursive: true });
  await copyFile(join(BRAND, "kataster-favicon.svg"), join(OUT, "favicon.svg"));

  await png("kataster-favicon.svg", 16).toFile(join(OUT, "favicon-16.png"));
  await png("kataster-favicon.svg", 32).toFile(join(OUT, "favicon-32.png"));
  await png("kataster-apple-touch-source.svg", 180).toFile(join(OUT, "apple-touch-icon.png"));
  await png("kataster-icon-source.svg", 192).toFile(join(OUT, "icon-192.png"));
  await png("kataster-icon-source.svg", 512).toFile(join(OUT, "icon-512.png"));

  const icoSources = await Promise.all(
    [16, 32, 48].map((s) => png("kataster-favicon.svg", s).toBuffer()),
  );
  await writeFile(join(OUT, "favicon.ico"), await pngToIco(icoSources));
  console.log("[icons] wrote favicon set to public/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
