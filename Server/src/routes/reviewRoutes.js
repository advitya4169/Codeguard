import express from "express";
import { analyzeCode } from "../controllers/reviewController.js";

const router = express.Router();

router.post("/", analyzeCode);

export default router;