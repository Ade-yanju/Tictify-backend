import QRCode from "qrcode";

export async function generateQRCode(text) {
  return await QRCode.toDataURL(text);
}
