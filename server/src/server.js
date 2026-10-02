import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import githubRoutes from "./routes/githubRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
dotenv.config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to Database
connectDB();

app.use(cors());
app.use(express.json());

// API Routes
app.use("/api/review", reviewRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/github", githubRoutes);
app.use("/api/webhooks", webhookRoutes);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});