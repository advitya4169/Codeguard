import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

if (!process.env.GEMINI_API_KEY) {
  console.error("CRITICAL: GEMINI_API_KEY is not defined in .env");
  process.exit(1);
}

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function generateReview(prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await genAI.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
      });

      return response.text;
    } catch (error) {
      if (error.status === 503 && attempt < retries - 1) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`Gemini unavailable. Retrying in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

export const analyzeCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string" || !code.trim()) {
      return res.status(400).json({
        error: "Valid code string is required in the request body.",
      });
    }

    const prompt = `You are a senior software engineer performing a code review.
                    Analyze the following code for:
                    - Bugs
                    - Security vulnerabilities
                    - Performance issues
                    - Code quality
                    - Possible improvements
                    Provide clear and actionable feedback.
                    Code to review:
                    \`\`\`
                    ${code}
                    \`\`\`
                    `;

    const reviewText = await generateReview(prompt);

    return res.status(200).json({ review: reviewText });
  } catch (error) {
    console.error("Error generating review:", error);
    return res.status(500).json({
      error: "An error occurred while generating the code review.",
      details: error.message,
    });
  }
};