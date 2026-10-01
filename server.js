const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.get("/", (req, res) => {
  res.json({
    project: "IntelliLearn AI",
    status: "Backend is running",
  });
});

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

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 IntelliLearn backend running on port ${PORT}`);
});