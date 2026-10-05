const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const {
  GoogleGenAI,
  createPartFromUri,
} = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/*
====================================================
PDF UPLOAD CONFIGURATION
====================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 50 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed."));
    }
  },
});

/*
====================================================
GEMINI GENERATION WITH RETRY
====================================================
*/

async function generateWithRetry(request, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🤖 Gemini generation attempt ${
          attempt + 1
        }/${maxRetries + 1}`
      );

      const response =
        await ai.models.generateContent(request);

      return response;
    } catch (error) {
      lastError = error;

      const errorText =
        JSON.stringify(error).toLowerCase();

      const isTemporaryError =
        errorText.includes("503") ||
        errorText.includes("unavailable") ||
        errorText.includes("high demand") ||
        errorText.includes("429") ||
        errorText.includes("resource_exhausted");

      if (
        !isTemporaryError ||
        attempt === maxRetries
      ) {
        throw error;
      }

      const delay =
        Math.pow(2, attempt + 1) * 1000;

      console.log(
        `⏳ Gemini temporarily unavailable. Retrying in ${
          delay / 1000
        } seconds...`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, delay)
      );
    }
  }

  throw lastError;
}

/*
====================================================
HOME
====================================================
*/

app.get("/", (req, res) => {
  res.json({
    project: "IntelliLearn AI",
    status: "Backend is running",
  });
});

/*
====================================================
NORMAL CHAT + PDF CHAT
====================================================
*/

app.post("/ask", async (req, res) => {
  try {
    const { question, fileName } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required",
      });
    }

    /*
    NORMAL CHAT
    */

    if (!fileName) {
      const response =
        await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: question,
        });

      return res.json({
        question: question,
        answer: response.text,
      });
    }

    /*
    PDF CHAT
    */

    console.log("📚 PDF Chat requested");
    console.log("Gemini file:", fileName);

    const file = await ai.files.get({
      name: fileName,
    });

    if (!file) {
      return res.status(404).json({
        error: "PDF file was not found.",
      });
    }

    if (file.state === "PROCESSING") {
      return res.status(409).json({
        error:
          "PDF is still being processed. Please try again shortly.",
      });
    }

    if (file.state === "FAILED") {
      return res.status(500).json({
        error:
          "Gemini failed to process this PDF.",
      });
    }

    if (!file.uri) {
      return res.status(500).json({
        error: "PDF file URI is unavailable.",
      });
    }

    const filePart = createPartFromUri(
      file.uri,
      file.mimeType || "application/pdf"
    );

    const response = await generateWithRetry({
      model: "gemini-3.6-flash",

      contents: [
        filePart,
        question,
      ],
    });

    console.log("✅ PDF answer generated");

    return res.json({
      question: question,
      answer: response.text,
      fileName: file.name,
    });

  } catch (error) {
    console.error("GEMINI ERROR:", error);

    return res.status(500).json({
      error:
        error.message ||
        "Failed to generate AI response",
    });
  }
});

/*
====================================================
AI NOTES ENDPOINT
====================================================

Request:

{
  "fileName": "files/XXXXXXXX"
}

Response:

{
  "success": true,
  "fileName": "files/XXXXXXXX",
  "notes": "..."
}

====================================================
*/

app.post("/notes", async (req, res) => {
  try {
    const { fileName } = req.body;

    /*
    Validate fileName
    */

    if (!fileName || !fileName.trim()) {
      return res.status(400).json({
        error:
          "PDF fileName is required",
      });
    }

    console.log("📝 Notes generation requested");
    console.log("Gemini file:", fileName);

    /*
    Get Gemini PDF
    */

    const file = await ai.files.get({
      name: fileName,
    });

    if (!file) {
      return res.status(404).json({
        error:
          "PDF file was not found.",
      });
    }

    /*
    Check processing state
    */

    if (file.state === "PROCESSING") {
      return res.status(409).json({
        error:
          "PDF is still being processed. Please try again shortly.",
      });
    }

    if (file.state === "FAILED") {
      return res.status(500).json({
        error:
          "Gemini failed to process this PDF.",
      });
    }

    /*
    Check URI
    */

    if (!file.uri) {
      return res.status(500).json({
        error:
          "PDF file URI is unavailable.",
      });
    }

    /*
    Create Gemini PDF part
    */

    const filePart = createPartFromUri(
      file.uri,
      file.mimeType || "application/pdf"
    );

    /*
    Notes generation prompt
    */

    const notesPrompt = `
You are IntelliLearn AI, an educational study assistant.

Read the provided PDF carefully and create clear, useful study notes based ONLY on the content of the PDF.

Follow this structure:

# Study Notes

## 1. Overview
Give a short explanation of what the document/course/topic is about.

## 2. Important Topics
List the major topics covered in the PDF.

## 3. Detailed Notes
Explain each major topic using clear headings and concise points.

## 4. Important Definitions
List important definitions and their meanings.

## 5. Important Concepts
Explain concepts that are important for understanding or exams.

## 6. Examples
Include examples mentioned or explained in the PDF.

## 7. Quick Revision
Give a short revision section containing the most important points to remember.

Rules:
- Use information from the PDF.
- Do not invent topics that are not supported by the PDF.
- Keep the notes exam-friendly.
- Prefer headings and bullet points.
- Keep explanations clear and easy to understand.
- Preserve important technical terminology from the PDF.
- Do not mention that you are an AI.
`;

    /*
    Generate notes with retry protection
    */

    const response =
      await generateWithRetry({
        model: "gemini-3.6-flash",

        contents: [
          filePart,
          notesPrompt,
        ],
      });

    console.log(
      "✅ Notes generated successfully"
    );

    return res.json({
      success: true,
      fileName: file.name,
      notes: response.text,
    });

  } catch (error) {
    console.error(
      "NOTES GENERATION ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Failed to generate notes",
    });
  }
});

/*
====================================================
PDF UPLOAD ENDPOINT
====================================================
*/

app.post(
  "/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "PDF file is required",
        });
      }

      console.log(
        "📄 Uploading PDF:",
        req.file.originalname
      );

      const fileBlob = new Blob(
        [req.file.buffer],
        {
          type: "application/pdf",
        }
      );

      const file =
        await ai.files.upload({
          file: fileBlob,

          config: {
            displayName:
              req.file.originalname,
          },
        });

      console.log(
        "📤 Gemini file uploaded:",
        file.name
      );

      let fileInfo =
        await ai.files.get({
          name: file.name,
        });

      let attempts = 0;
      const maxAttempts = 60;

      while (
        fileInfo.state === "PROCESSING" &&
        attempts < maxAttempts
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000)
        );

        fileInfo =
          await ai.files.get({
            name: file.name,
          });

        attempts++;

        console.log(
          `⏳ PDF processing... ${attempts}s - ${fileInfo.state}`
        );
      }

      if (fileInfo.state === "FAILED") {
        return res.status(500).json({
          error:
            "Gemini failed to process the PDF.",
        });
      }

      if (
        fileInfo.state === "PROCESSING"
      ) {
        return res.status(408).json({
          error:
            "PDF processing is taking too long. Please try again.",
        });
      }

      console.log(
        "✅ PDF processing complete:",
        fileInfo.state
      );

      return res.json({
        success: true,

        message:
          "PDF uploaded successfully",

        fileName:
          file.name,

        fileUri:
          file.uri,

        mimeType:
          file.mimeType ||
          "application/pdf",

        displayName:
          req.file.originalname,

        state:
          fileInfo.state,
      });

    } catch (error) {
      console.error(
        "PDF UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Failed to upload PDF",
      });
    }
  }
);

/*
====================================================
UPLOAD ERROR HANDLER
====================================================
*/

app.use(
  (error, req, res, next) => {
    if (
      error instanceof multer.MulterError
    ) {
      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          error:
            "PDF file must be 50 MB or smaller.",
        });
      }

      return res.status(400).json({
        error: error.message,
      });
    }

    if (error) {
      return res.status(400).json({
        error:
          error.message ||
          "Upload failed",
      });
    }

    next();
  }
);

/*
====================================================
START SERVER
====================================================
*/

const PORT =
  process.env.PORT || 5000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🚀 IntelliLearn backend running on port ${PORT}`
    );
  }
);
