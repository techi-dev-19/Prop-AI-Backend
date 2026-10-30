const pdfParse = require("pdf-parse");

/**
 * Download brochure PDF from Cloudinary
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function downloadBrochureFromCloudinary(url) {
  if (!url) {
    throw new Error("Brochure URL is required");
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download brochure: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

/**
 * Extract readable text from brochure PDF.
 *
 * @param {string} brochureUrl
 * @returns {Promise<object>}
 */
async function extractBrochureData(brochureUrl) {
  const pdfBuffer = await downloadBrochureFromCloudinary(brochureUrl);

  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error("Downloaded brochure is empty");
  }

  const pdfData = await pdfParse(pdfBuffer);

  const text = (pdfData.text || "").trim();

  if (!text) {
    throw new Error("No readable text found in brochure PDF");
  }

  return {
    text,
    pages: pdfData.numpages || 0,
  };
}

module.exports = {
  downloadBrochureFromCloudinary,
  extractBrochureData,
};
