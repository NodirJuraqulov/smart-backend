import multer from "multer";
import { ApiError } from "@/utils/ApiError";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },

  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new ApiError("Faqat JPEG/PNG rasm qabul qilinadi", 400));
      return;
    }
    cb(null, true);
  },
});
