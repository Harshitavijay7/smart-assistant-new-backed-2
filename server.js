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

Used mainly for PDF requests.

If Gemini temporarily returns:
- 503 UNAVAILABLE
- 429 RESOURCE_EXHAUSTED

we retry automatically.

This does NOT change the normal Chat behavior.
====================================================
*/

async function generateWithRetry(request, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `🤖 Gemini generation attempt ${attempt + 1}/${maxRetries + 1}`
      );

      const response = await ai.models.generateContent(request);

      return response;
    } catch (error) {
      lastError = error;

      const errorText = JSON.stringify(error).toLowerCase();

      const isTemporaryError =
        errorText.includes("503") ||
        errorText.includes("unavailable") ||
        errorText.includes("high demand") ||
        errorText.includes("429") ||
        errorText.includes("resource_exhausted");

      if (!isTemporaryError || attempt === maxRetries) {
        throw error;
      }

      /*
      Exponential backoff:

      Attempt 1 fails → wait 2 seconds
      Attempt 2 fails → wait 4 seconds
      Attempt 3 fails → wait 8 seconds
      */

      const delay = Math.pow(2, attempt + 1) * 1000;

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
CHAT ENDPOINT
====================================================

NORMAL CHAT:

{
  "question": "What is AI?"
}

PDF CHAT:

{
  "question": "What is this PDF about?",
  "fileName": "files/xxxxx"
}

IMPORTANT:
Normal Chat continues using the existing behavior.
====================================================
*/

app.post("/ask", async (req, res) => {
  try {
    const { question, fileName } = req.body;

    /*
    ------------------------------------------------
    VALIDATE QUESTION
    ------------------------------------------------
    */

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required",
      });
    }

    /*
    ------------------------------------------------
    NORMAL CHAT
    ------------------------------------------------

    No PDF = existing behavior.

    DO NOT change this flow.
    ------------------------------------------------
    */

    if (!fileName) {
      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: question,
      });

      return res.json({
        question: question,
        answer: response.text,
      });
    }

    /*
    ------------------------------------------------
    PDF CHAT
    ------------------------------------------------
    */

    console.log("📚 PDF Chat requested");
    console.log("Gemini file:", fileName);

    /*
    Get Gemini file
    */

    const file = await ai.files.get({
      name: fileName,
    });

    if (!file) {
      return res.status(404).json({
        error: "PDF file was not found.",
      });
    }

    /*
    Check PDF processing state
    */

    if (file.state === "PROCESSING") {
      return res.status(409).json({
        error:
          "PDF is still being processed. Please try again shortly.",
      });
    }

    if (file.state === "FAILED") {
      return res.status(500).json({
        error: "Gemini failed to process this PDF.",
      });
    }

    /*
    Make sure URI exists
    */

    if (!file.uri) {
      return res.status(500).json({
        error: "PDF file URI is unavailable.",
      });
    }

    /*
    Create Gemini file part
    */

    const filePart = createPartFromUri(
      file.uri,
      file.mimeType || "application/pdf"
    );

    /*
    ------------------------------------------------
    PDF + QUESTION
    ------------------------------------------------

    Gemini receives:

    1. PDF
    2. User question
    ------------------------------------------------
    */

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
PDF UPLOAD ENDPOINT
====================================================
*/

app.post(
  "/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      /*
      Check file
      */

      if (!req.file) {
        return res.status(400).json({
          error: "PDF file is required",
        });
      }

      console.log(
        "📄 Uploading PDF:",
        req.file.originalname
      );

      /*
      Convert buffer to Blob
      */

      const fileBlob = new Blob(
        [req.file.buffer],
        {
          type: "application/pdf",
        }
      );

      /*
      Upload to Gemini Files API
      */

      const file = await ai.files.upload({
        file: fileBlob,

        config: {
          displayName: req.file.originalname,
        },
      });

      console.log(
        "📤 Gemini file uploaded:",
        file.name
      );

      /*
      Check Gemini processing state
      */

      let fileInfo = await ai.files.get({
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

        fileInfo = await ai.files.get({
          name: file.name,
        });

        attempts++;

        console.log(
          `⏳ PDF processing... ${attempts}s - ${fileInfo.state}`
        );
      }

      /*
      Processing failed
      */

      if (fileInfo.state === "FAILED") {
        return res.status(500).json({
          error:
            "Gemini failed to process the PDF.",
        });
      }

      /*
      Processing timeout
      */

      if (fileInfo.state === "PROCESSING") {
        return res.status(408).json({
          error:
            "PDF processing is taking too long. Please try again.",
        });
      }

      console.log(
        "✅ PDF processing complete:",
        fileInfo.state
      );

      /*
      Return PDF information
      */

      return res.json({
        success: true,

        message:
          "PDF uploaded successfully",

        fileName:
          file.name,

        fileUri:
          file.uri,

        mimeType:
          file.mimeType || "application/pdf",

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
    /*
    Multer errors
    */

    if (error instanceof multer.MulterError) {
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

    /*
    Other upload errors
    */

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
