const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// PDF upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed."));
    }
  },
});

app.get("/", (req, res) => {
  res.json({
    project: "IntelliLearn AI",
    status: "Backend is running",
  });
});

/*
====================================================
EXISTING CHAT ENDPOINT
DO NOT CHANGE
====================================================
*/

app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required",
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: question,
    });

    res.json({
      question: question,
      answer: response.text,
    });
  } catch (error) {
    console.error("GEMINI ERROR:", error);

    res.status(500).json({
      error: error.message || "Failed to generate AI response",
    });
  }
});

/*
====================================================
NEW PDF UPLOAD ENDPOINT
====================================================
*/

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "PDF file is required",
      });
    }

    console.log("📄 Uploading PDF:", req.file.originalname);

    // Convert uploaded PDF buffer into a Blob
    const fileBlob = new Blob([req.file.buffer], {
      type: "application/pdf",
    });

    // Upload PDF to Gemini Files API
    const file = await ai.files.upload({
      file: fileBlob,
      config: {
        displayName: req.file.originalname,
      },
    });

    console.log("📤 Gemini file uploaded:", file.name);

    // Wait for Gemini to finish processing the PDF
    let fileInfo = await ai.files.get({
      name: file.name,
    });

    let attempts = 0;
    const maxAttempts = 60;

    while (fileInfo.state === "PROCESSING" && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      fileInfo = await ai.files.get({
        name: file.name,
      });

      attempts++;

      console.log(
        `⏳ PDF processing... ${attempts}s - ${fileInfo.state}`
      );
    }

    if (fileInfo.state === "FAILED") {
      return res.status(500).json({
        error: "Gemini failed to process the PDF.",
      });
    }

    if (fileInfo.state === "PROCESSING") {
      return res.status(408).json({
        error: "PDF processing is taking too long. Please try again.",
      });
    }

    console.log("✅ PDF processing complete:", fileInfo.state);

    res.json({
      success: true,
      message: "PDF uploaded successfully",
      fileName: file.name,
      fileUri: file.uri,
      mimeType: file.mimeType || "application/pdf",
      displayName: req.file.originalname,
      state: fileInfo.state,
    });
  } catch (error) {
    console.error("PDF UPLOAD ERROR:", error);

    res.status(500).json({
      error: error.message || "Failed to upload PDF",
    });
  }
});

// Multer/file upload errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "PDF file must be 50 MB or smaller.",
      });
    }

    return res.status(400).json({
      error: error.message,
    });
  }

  if (error) {
    return res.status(400).json({
      error: error.message || "Upload failed",
    });
  }

  next();
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 IntelliLearn backend running on port ${PORT}`);
});
