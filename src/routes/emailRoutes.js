const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const c = require("../controllers/emailController");
const templates = require("../controllers/emailTemplateController");

router.use(authenticate, roleGuard("broker", "admin"));
router.get("/status", c.status);
router.get("/templates", templates.list);
router.post("/templates", templates.create);
router.put("/templates/:id", templates.update);
router.delete("/templates/:id", templates.remove);
router.get("/replies", c.listReplies);
router.get("/replies/:id", c.getThread);
router.post("/replies/:id/reply", c.replyToThread);
module.exports = router;
