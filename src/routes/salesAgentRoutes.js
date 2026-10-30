const express = require("express");
const multer = require("multer");
const router = express.Router();

const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const controller = require("../controllers/salesAgentController");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

router.use(authenticate, roleGuard("broker", "builder", "admin"));

router.get("/", controller.getConfig);
router.put("/", controller.updateConfig);
router.post("/reset", controller.resetDefaults);
router.post("/test-chat", controller.testChat);
router.post("/upload", upload.single("file"), controller.uploadMedia);

module.exports = router;
