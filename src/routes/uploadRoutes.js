const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const { uploadImage } = require('../middlewares/upload');
const controller = require('../controllers/uploadController');
router.post('/image', authenticate, uploadImage.single('image'), controller.uploadImage);
module.exports = router;
