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

IMPORTANT:

Normal Chat:
{
  "question": "What is AI?"
}

continues using the existing behavior.

PDF Chat:
{
  "question": "What is this PDF about?",
  "fileName": "files/xxxxx"
}

uses the uploaded PDF as context.
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

    If no PDF is supplied, this is the same
    behavior as the existing working Chat.
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
    Get the uploaded Gemini file
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
        error: "Gemini failed to process this PDF.",
      });
    }

    /*
    Make sure Gemini returned a URI
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
    Ask Gemini using:
    
    PDF + user question
    */

    const response = await ai.models.generateContent({
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
        error.message || "Failed to generate AI response",
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
      Convert uploaded buffer to Blob
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
      Return PDF information to frontend
      */

      return res.json({
        success: true,

        message:
          "PDF uploaded successfully",

        fileName: file.name,

        fileUri: file.uri,

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
