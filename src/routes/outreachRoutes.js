const express = require("express");
const router = express.Router();

const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const validate = require("../middlewares/validate");
const c = require("../controllers/campaignController");
const { listJobsQuerySchema } = require("../validators/campaignValidators");

router.use(authenticate, roleGuard("broker", "admin"));

router.get("/summary", c.summary);
router.get("/jobs", validate(listJobsQuerySchema), c.jobs);

module.exports = router;
