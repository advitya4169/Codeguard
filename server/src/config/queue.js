
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const redisConnection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    maxRetriesPerRequest: null,
  }
);

// Log when Redis successfully connects
redisConnection.on("connect", () => {
  console.log("Connected to Redis Container");
});

// Log when Redis is ready to accept commands
redisConnection.on("ready", () => {
  console.log("Redis is ready");
});

// Log connection errors
redisConnection.on("error", (error) => {
  console.error("Redis connection error:", error.message);
});

export const reviewQueue = new Queue("code-review-queue", {
  connection: redisConnection,
});
