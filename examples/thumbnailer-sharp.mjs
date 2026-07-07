let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(message);
}

export async function thumbnailWithSharp(image) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    warnOnce("image-context-cascade: install sharp in your host app to enable thumbnail generation; falling back to placeholders.");
    return null;
  }

  try {
    const input = Buffer.from(image.data, "base64");
    const output = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 60, mozjpeg: false })
      .toBuffer();

    return {
      data: output.toString("base64"),
      mediaType: "image/jpeg",
    };
  } catch {
    return null;
  }
}

export default thumbnailWithSharp;
