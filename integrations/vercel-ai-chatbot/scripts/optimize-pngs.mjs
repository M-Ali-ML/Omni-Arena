// Shrinks the captured screenshots so committing them stays cheap.
//
// Chromium writes 24-bit PNGs; a 2560x1600 retina shot of a mostly-flat UI is
// around a megabyte of that. Re-encoding as a quantised palette PNG keeps text
// crisp (the UI has few distinct colours) at a fraction of the bytes. Run as
// the last step of `npm run screenshots`, or on its own after editing a shot.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = fileURLToPath(
  new URL("../../../docs/images/integrations/vercel-ai-chatbot", import.meta.url),
);

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.warn(
    "sharp is not installed, leaving the PNGs unoptimised. " +
      "Run `npm install` in integrations/vercel-ai-chatbot.",
  );
  process.exit(0);
}

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

const files = (await readdir(outputDir)).filter((file) => file.endsWith(".png"));
files.sort();

for (const file of files) {
  const target = path.join(outputDir, file);
  const original = await readFile(target);
  const optimised = await sharp(original)
    .png({ compressionLevel: 9, effort: 10, palette: true, quality: 90 })
    .toBuffer();

  if (optimised.length < original.length) {
    await writeFile(target, optimised);
  }
  const { size } = await stat(target);
  console.log(`${file}  ${kb(original.length)} -> ${kb(size)}`);
}
