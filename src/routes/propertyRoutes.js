const express = require("express");
const router = express.Router();

const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const validate = require("../middlewares/validate");
const { uploadCsv, uploadBrochure } = require("../middlewares/upload");

const {
  previewImport,
  confirmImport,
  uploadBrochureAndImages,
  createProperty,
  listProperties,
  getProperty,
  updateProperty,
  deleteProperty,
  bulkDeleteProperties,
  exportProperties,
} = require("../controllers/propertyController");

const {
  createPropertySchema,
  updatePropertySchema,
  listPropertiesQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  importConfirmSchema,
} = require("../validators/propertyValidators");

router.use(authenticate);

router.post(
  "/brochure",
  uploadBrochure.fields([
    {
      name: "brochure",
      maxCount: 1,
    },
    {
      name: "images",
      maxCount: 10,
    },
  ]),
  uploadBrochureAndImages,
);

// IMPORTANT: specific/static paths (import/*, export, bulk-delete) must be
// registered BEFORE the generic "/:id" route below, otherwise Express would
// match e.g. GET /export against the "/:id" handler with id="export".

// Write access: builders and admins only.
router.post(
  "/import/preview",
  // roleGuard('builder', 'admin'),
  uploadCsv.single("file"),
  previewImport,
);
router.post(
  "/import/confirm",
  // roleGuard('builder', 'admin'),
  validate(importConfirmSchema),
  confirmImport,
);
router.get("/export", roleGuard("builder", "admin"), exportProperties);
router.post(
  "/bulk-delete",
  // roleGuard('builder', 'admin'),
  validate(bulkDeleteSchema),
  bulkDeleteProperties,
);
router.post(
  "/",
  // roleGuard('builder', 'admin'),
  validate(createPropertySchema),
  createProperty,
);

// Read access: builders (own inventory), admins (any), AND brokers (read-only,
// active listings only) — brokers need this to browse/match properties for leads.
router.get(
  "/",
  // roleGuard('builder', 'admin', 'broker'),
  validate(listPropertiesQuerySchema),
  listProperties,
);
router.get(
  "/:id",
  // roleGuard('builder', 'admin', 'broker'),
  validate(idParamSchema),
  getProperty,
);

router.patch(
  "/:id",
  // roleGuard('builder', 'admin'),
  validate(updatePropertySchema),
  updateProperty,
);
router.delete(
  "/:id",
  // roleGuard('builder', 'admin'),
  validate(idParamSchema),
  deleteProperty,
);

module.exports = router;
