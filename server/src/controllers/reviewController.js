
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is not defined in .env");
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function generateReview(prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "You are a senior software engineer. Review code for bugs, security vulnerabilities, performance issues, and code quality. Give clear, actionable feedback.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
      });

      const review = completion.choices[0]?.message?.content;

      if (!review) {
        throw new Error("Groq returned an empty response");
      }

      return review;
    } catch (error) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      const isRetryable = retryableStatuses.includes(error.status);

      if (!isRetryable || attempt === retries - 1) {
        throw error;
      }

      const delay = 2000 * Math.pow(2, attempt);

      console.log(
        `Groq request failed (${error.status}). Retrying in ${
          delay / 1000
        } seconds...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Code review failed after all retry attempts");
}

export const analyzeCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({
        error: "Valid code string is required in the request body.",
      });
    }

    const prompt = `
Review the following code as a senior software engineer.

Analyze it for:
- Bugs
- Security vulnerabilities
- Performance issues
- Code quality
- Possible improvements

Be specific and actionable. Do not invent issues.
Explain the problem and suggest how to fix it.

Code to review:
\`\`\`
${code}
\`\`\`
`;

    const reviewText = await generateReview(prompt);

    return res.status(200).json({
      review: reviewText,
    });
  } catch (error) {
    console.error("Error generating review:", error.message);

    return res.status(500).json({
      error: "An error occurred while generating the code review.",
      details: error.message,
    });
  }
};
