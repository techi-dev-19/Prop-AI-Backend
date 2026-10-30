const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} = require("@google/genai");

const { downloadBrochureFromCloudinary } = require("./brochureExtractor");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

async function extractPropertyDataWithAI(brochureUrl) {
  if (!brochureUrl) {
    throw new Error("Brochure URL is required");
  }

  // ==========================================
  // 1. Download PDF from Cloudinary
  // ==========================================
  const pdfBuffer = await downloadBrochureFromCloudinary(brochureUrl);

  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error("Brochure PDF is empty");
  }

  console.log(
    `[brochure-ai] PDF downloaded successfully. Size: ${pdfBuffer.length} bytes`,
  );

  // ==========================================
  // 2. Upload PDF to Gemini Files API
  // ==========================================
  const uploadedFile = await ai.files.upload({
    file: new Blob([pdfBuffer], {
      type: "application/pdf",
    }),

    config: {
      mimeType: "application/pdf",
      displayName: "real-estate-brochure.pdf",
    },
  });

  console.log("[brochure-ai] Gemini file uploaded:", {
    name: uploadedFile?.name,
    uri: uploadedFile?.uri,
    mimeType: uploadedFile?.mimeType,
    sizeBytes: uploadedFile?.sizeBytes,
  });

  if (!uploadedFile?.uri) {
    throw new Error("Gemini file upload failed");
  }

  // ==========================================
  // 3. Ask Gemini to extract property data
  // ==========================================
  const prompt = `
You are an expert real estate brochure data extraction assistant.

Analyze the complete attached real estate brochure.

Extract all available property information.

IMPORTANT RULES:

1. Return ONLY valid JSON.
2. Do not return markdown.
3. Do not return explanations.
4. Never invent information.
5. If information is unavailable, return null.
6. amenities must always be an array.
7. parking must always be boolean.
8. budgetMin and budgetMax must be numbers or null.
9. sizeSqft must be a number or null.
10. Extract the RERA number exactly as written.
11. If multiple BHK configurations exist, preserve them as a string.
12. Extract city separately from location.
13. Read information from text, tables, images and other brochure sections.
14. Preserve the original meaning of the brochure.
15. Convert prices into plain numbers when possible.
16. Do not include currency symbols inside numeric fields.

Return exactly this JSON structure:

{
  "projectName": null,
  "builderName": null,
  "propertyType": null,
  "bhk": null,
  "location": null,
  "city": null,
  "budgetMin": null,
  "budgetMax": null,
  "sizeSqft": null,
  "amenities": [],
  "parking": false,
  "reraNumber": null,
  "nearbyMetro": null,
  "nearbySchool": null,
  "nearbyHospital": null,
  "mapsLink": null,
  "description": null
}
`;

  const response = await ai.models.generateContent({
    model: MODEL,

    contents: createUserContent([
      createPartFromUri(
        uploadedFile.uri,
        uploadedFile.mimeType || "application/pdf",
      ),
      prompt,
    ]),

    config: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  console.log("[brochure-ai] Gemini extraction response received");

  // ==========================================
  // 4. Parse Gemini JSON
  // ==========================================
  let extractedData;

  try {
    extractedData = JSON.parse(text);
  } catch (error) {
    console.error("[brochure-ai] Invalid Gemini JSON:", text);

    throw new Error("Gemini returned invalid JSON");
  }

  console.log("[brochure-ai] Extracted property data:", extractedData);

  return extractedData;
}

module.exports = {
  extractPropertyDataWithAI,
};
