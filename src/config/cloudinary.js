import { v2 as cloudinary } from "cloudinary";

/* Reads CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
   (or a single CLOUDINARY_URL, which the SDK picks up automatically). */
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_URL,
);

export default cloudinary;
