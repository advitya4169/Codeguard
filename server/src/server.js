import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import githubRoutes from "./routes/githubRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import './workers/reviewWorker.js'; 
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { requireAuth } from "./middleware/authMiddleware.js"; 
dotenv.config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 5000;

// The local ngrok agent forwards requests over loopback. Trust only loopback
// proxies so direct clients cannot choose their IP through X-Forwarded-For.
app.set('trust proxy', 'loopback');

// Connect to Database
connectDB();

app.use(cors());
app.use(express.json({
  verify: (req, res, buffer) => {
    if (req.path === "/api/webhooks/github") {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));

// API Routes
app.use("/api/review", reviewRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/github", githubRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/dashboard", requireAuth, dashboardRoutes);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
