const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const { uploadBufferToCloudinary } = require('../services/cloudinaryUpload');

const ALLOWED_FOLDERS = new Set(['properties/images', 'templates/whatsapp', 'templates/email']);

const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Image file is required (field name: image).');
  const folderInput = String(req.body?.folder || 'properties/images');
  const folder = ALLOWED_FOLDERS.has(folderInput) ? folderInput : 'properties/images';
  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, { folder, resourceType: 'image' });
    return new ApiResponse(201, { url: uploaded.secure_url, publicId: uploaded.public_id, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes }, 'Image uploaded to Cloudinary').send(res);
  } catch (err) {
    throw new ApiError(502, err?.message || 'Image upload failed. Check Cloudinary configuration.');
  }
});

module.exports = { uploadImage };
