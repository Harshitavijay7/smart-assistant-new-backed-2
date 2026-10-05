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
GET GEMINI PDF
====================================================
*/

async function getPdfPart(fileName) {
  if (!fileName || !fileName.trim()) {
    const error = new Error(
      "PDF fileName is required"
    );

    error.statusCode = 400;

    throw error;
  }

  console.log("📄 Getting Gemini file:", fileName);

  const file = await ai.files.get({
    name: fileName,
  });

  if (!file) {
    const error = new Error(
      "PDF file was not found."
    );

    error.statusCode = 404;

    throw error;
  }

  if (file.state === "PROCESSING") {
    const error = new Error(
      "PDF is still being processed. Please try again shortly."
    );

    error.statusCode = 409;

    throw error;
  }

  if (file.state === "FAILED") {
    const error = new Error(
      "Gemini failed to process this PDF."
    );

    error.statusCode = 500;

    throw error;
  }

  if (!file.uri) {
    const error = new Error(
      "PDF file URI is unavailable."
    );

    error.statusCode = 500;

    throw error;
  }

  const filePart = createPartFromUri(
    file.uri,
    file.mimeType || "application/pdf"
  );

  return {
    file,
    filePart,
  };
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
        question,
        answer: response.text,
      });
    }

    /*
    PDF CHAT
    */

    console.log("📚 PDF Chat requested");

    const { file, filePart } =
      await getPdfPart(fileName);

    const response =
      await generateWithRetry({
        model: "gemini-3.6-flash",

        contents: [
          filePart,
          question,
        ],
      });

    console.log("✅ PDF answer generated");

    return res.json({
      question,
      answer: response.text,
      fileName: file.name,
    });

  } catch (error) {
    console.error("GEMINI ERROR:", error);

    return res.status(
      error.statusCode || 500
    ).json({
      error:
        error.message ||
        "Failed to generate AI response",
    });
  }
});

/*
====================================================
AI NOTES
====================================================
*/

app.post("/notes", async (req, res) => {
  try {
    const { fileName } = req.body;

    const { file, filePart } =
      await getPdfPart(fileName);

    console.log(
      "📝 Notes generation requested:",
      fileName
    );

    const notesPrompt = `
You are IntelliLearn AI, an educational study assistant.

Read the provided PDF carefully and create clear,
useful study notes based ONLY on the content of the PDF.

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
- Do not invent topics not supported by the PDF.
- Keep the notes exam-friendly.
- Prefer headings and bullet points.
- Keep explanations clear and easy to understand.
- Preserve important technical terminology.
`;

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

    return res.status(
      error.statusCode || 500
    ).json({
      error:
        error.message ||
        "Failed to generate notes",
    });
  }
});

/*
====================================================
MCQ GENERATOR
====================================================

Generates exactly 10 MCQs from the selected PDF.

Each MCQ contains:

- question
- 4 options
- correctAnswer
- explanation

====================================================
*/

app.post("/mcqs", async (req, res) => {
  try {
    const { fileName } = req.body;

    const { file, filePart } =
      await getPdfPart(fileName);

    console.log(
      "❓ MCQ generation requested:",
      fileName
    );

    const mcqPrompt = `
You are IntelliLearn AI, an educational exam-preparation assistant.

Read the provided PDF carefully.

Generate EXACTLY 10 multiple-choice questions
based ONLY on the information contained in the PDF.

The questions should test important concepts,
definitions, facts, examples, and understanding
from the PDF.

Return ONLY valid JSON.
Do not use markdown.
Do not add explanations outside the JSON.

Use exactly this structure:

{
  "mcqs": [
    {
      "question": "Question text",
      "options": [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      "correctAnswer": "Option A",
      "explanation": "Short explanation of why this is correct."
    }
  ]
}

Rules:
- Generate exactly 10 questions.
- Every question must have exactly 4 options.
- Only ONE option must be correct.
- correctAnswer must exactly match one of the four options.
- Questions must be based on the PDF.
- Do not invent information.
- Avoid duplicate questions.
- Mix easy, medium, and difficult questions.
- Keep questions useful for university exam preparation.
- Keep explanations short and clear.
`;

    const response =
      await generateWithRetry({
        model: "gemini-3.6-flash",

        contents: [
          filePart,
          mcqPrompt,
        ],
      });

    const rawText =
      response.text.trim();

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      console.error(
        "MCQ JSON PARSE ERROR:",
        parseError
      );

      return res.status(500).json({
        error:
          "Gemini generated an invalid MCQ format. Please try again.",
        rawResponse: rawText,
      });
    }

    if (
      !parsed.mcqs ||
      !Array.isArray(parsed.mcqs) ||
      parsed.mcqs.length !== 10
    ) {
      return res.status(500).json({
        error:
          "Gemini did not generate exactly 10 MCQs. Please try again.",
      });
    }

    console.log(
      "✅ 10 MCQs generated successfully"
    );

    return res.json({
      success: true,
      fileName: file.name,
      mcqs: parsed.mcqs,
    });

  } catch (error) {
    console.error(
      "MCQ GENERATION ERROR:",
      error
    );

    return res.status(
      error.statusCode || 500
    ).json({
      error:
        error.message ||
        "Failed to generate MCQs",
    });
  }
});

/*
====================================================
FLASHCARD GENERATOR
====================================================

Generates exactly 10 flashcards.

Each card contains:

- front
- back

====================================================
*/

app.post(
  "/flashcards",
  async (req, res) => {
    try {
      const { fileName } = req.body;

      const { file, filePart } =
        await getPdfPart(fileName);

      console.log(
        "🗂️ Flashcard generation requested:",
        fileName
      );

      const flashcardPrompt = `
You are IntelliLearn AI, an educational study assistant.

Read the provided PDF carefully.

Generate EXACTLY 10 useful flashcards
based ONLY on information contained in the PDF.

The flashcards should focus on:
- important definitions
- important concepts
- important facts
- key terminology
- important relationships
- exam-relevant information

Return ONLY valid JSON.
Do not use markdown.
Do not add explanations outside the JSON.

Use exactly this structure:

{
  "flashcards": [
    {
      "front": "Question or concept",
      "back": "Correct answer or explanation"
    }
  ]
}

Rules:
- Generate exactly 10 flashcards.
- Every flashcard must have a front and a back.
- Keep the front concise.
- Keep the answer clear and useful for revision.
- Base every flashcard on the PDF.
- Do not invent information.
- Avoid duplicate flashcards.
- Prioritize exam-relevant content.
`;

      const response =
        await generateWithRetry({
          model: "gemini-3.6-flash",

          contents: [
            filePart,
            flashcardPrompt,
          ],
        });

      const rawText =
        response.text.trim();

      let parsed;

      try {
        parsed = JSON.parse(rawText);
      } catch (parseError) {
        console.error(
          "FLASHCARD JSON PARSE ERROR:",
          parseError
        );

        return res.status(500).json({
          error:
            "Gemini generated an invalid flashcard format. Please try again.",
          rawResponse: rawText,
        });
      }

      if (
        !parsed.flashcards ||
        !Array.isArray(
          parsed.flashcards
        ) ||
        parsed.flashcards.length !== 10
      ) {
        return res.status(500).json({
          error:
            "Gemini did not generate exactly 10 flashcards. Please try again.",
        });
      }

      console.log(
        "✅ 10 flashcards generated successfully"
      );

      return res.json({
        success: true,
        fileName: file.name,
        flashcards:
          parsed.flashcards,
      });

    } catch (error) {
      console.error(
        "FLASHCARD GENERATION ERROR:",
        error
      );

      return res.status(
        error.statusCode || 500
      ).json({
        error:
          error.message ||
          "Failed to generate flashcards",
      });
    }
  }
);

/*
====================================================
PDF UPLOAD
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

      if (
        fileInfo.state === "FAILED"
      ) {
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
