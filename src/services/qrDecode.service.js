import { Jimp } from "jimp";
import jsQR from "jsqr";

/* =====================================================
   QR DECODE — pure JS (jimp + jsqr), no native modules,
   safe on Render's free tier. Used by the WhatsApp gate
   scanner to read QR codes out of guest photos.
   Never throws: returns the decoded string or null.
===================================================== */
export async function decodeQrFromImage(buffer) {
  try {
    if (!buffer || !buffer.length) return null;
    const image = await Jimp.fromBuffer(buffer);
    const { data, width, height } = image.bitmap;
    const decoded = jsQR(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width,
      height,
    );
    return decoded?.data || null;
  } catch (err) {
    console.error("QR DECODE ERROR:", err.message);
    return null;
  }
}
