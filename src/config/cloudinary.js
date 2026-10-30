const cloudinary = require("cloudinary").v2;

console.log("========== CLOUDINARY CONFIG ==========");
console.log("Cloud Name:", process.env.CLOUDINARY_CLOUD_NAME);
console.log(
  "API Key:",
  process.env.CLOUDINARY_API_KEY
    ? `${process.env.CLOUDINARY_API_KEY.slice(0, 4)}****`
    : "MISSING",
);
console.log(
  "API Secret:",
  process.env.CLOUDINARY_API_SECRET ? "****LOADED****" : "MISSING",
);
console.log("=======================================");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
