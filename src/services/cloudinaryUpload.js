const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");

function uploadBufferToCloudinary(
  buffer,
  { folder = "properties", resourceType = "auto", publicId } = {},
) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        ...(publicId ? { public_id: publicId } : {}),
      },
      (error, result) => {
        if (error) {
          console.error("========== CLOUDINARY ERROR ==========");
          console.error("STATUS:", error.http_code);
          console.error("MESSAGE:", error.message);
          console.error("FULL ERROR:", error);
          console.error("======================================");

          return reject(error);
        }

        resolve(result);
      },
    );

    uploadStream.on("error", (streamError) => {
      console.error("========== CLOUDINARY STREAM ERROR ==========");
      console.error(streamError);
      console.error("==============================================");

      reject(streamError);
    });

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

module.exports = {
  uploadBufferToCloudinary,
};
