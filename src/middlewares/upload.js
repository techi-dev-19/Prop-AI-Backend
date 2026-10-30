const multer = require("multer");

const ApiError = require("../utils/ApiError");

// Files memory mein rahengi.
// Controller/service inhe Cloudinary ya kisi storage par upload karega.
const storage = multer.memoryStorage();

/* =========================
   CSV UPLOAD
========================= */

const csvFileFilter = (req, file, cb) => {
  const filename = String(file.originalname || "").toLowerCase();
  const isCsv = filename.endsWith(".csv") || file.mimetype === "text/csv";
  const isXlsx = filename.endsWith(".xlsx") || file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  if (!isCsv && !isXlsx) {
    return cb(ApiError.badRequest("Upload a .csv or .xlsx file. Legacy .xls files are not supported; save them as .xlsx first."));
  }

  cb(null, true);
};

const uploadCsv = multer({
  storage,
  fileFilter: csvFileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

/* =========================
   BROCHURE + PROPERTY IMAGES
========================= */

const brochureFileFilter = (req, file, cb) => {
  const isPdf =
    file.mimetype === "application/pdf" ||
    file.originalname.toLowerCase().endsWith(".pdf");

  const isImage = file.mimetype.startsWith("image/");

  // Brochure PDF
  if (file.fieldname === "brochure") {
    if (!isPdf) {
      return cb(ApiError.badRequest("Brochure must be a PDF file"));
    }

    return cb(null, true);
  }

  // Property images
  if (file.fieldname === "images") {
    if (!isImage) {
      return cb(
        ApiError.badRequest("Property images must be valid image files"),
      );
    }

    return cb(null, true);
  }

  return cb(
    ApiError.badRequest('Invalid upload field. Use "brochure" or "images"'),
  );
};

const uploadBrochure = multer({
  storage,
  fileFilter: brochureFileFilter,
  limits: {
    // Supports large real-estate collateral and high-resolution property images.
    fileSize: 30 * 1024 * 1024,

    // Maximum number of files
    files: 11,
  },
});


const uploadImage = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
    if (!allowed.has(String(file.mimetype || '').toLowerCase())) {
      return cb(ApiError.badRequest('Image must be JPG, PNG, WebP, GIF or AVIF.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

module.exports = {
  uploadImage,
  uploadCsv,
  uploadBrochure,
};
