import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import githubRoutes from "./routes/githubRoutes.js";

dotenv.config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to Database
connectDB();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/review", reviewRoutes);

// Health Check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// API Routes
app.use("/api/review", reviewRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/review", reviewRoutes);
app.use("/api/github", githubRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});