import express from "express";
import multer from "multer";
import cloudinary, { cloudinaryConfigured } from "../config/cloudinary.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) =>
    file.mimetype?.startsWith("image/")
      ? cb(null, true)
      : cb(new Error("Only image files are allowed")),
});

/* POST /api/uploads/banner — organizer-only, returns { url } */
router.post(
  "/banner",
  authenticate,
  authorize("organizer"),
  upload.single("image"),
  async (req, res) => {
    try {
      if (!cloudinaryConfigured) {
        return res.status(503).json({
          message: "Image uploads not configured (Cloudinary credentials missing)",
        });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No image provided" });
      }

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "tictify/banners", resource_type: "image" },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
        stream.end(req.file.buffer);
      });

      return res.json({ url: result.secure_url });
    } catch (err) {
      console.error("BANNER UPLOAD ERROR:", err.message);
      return res.status(500).json({ message: "Upload failed" });
    }
  },
);

export default router;
