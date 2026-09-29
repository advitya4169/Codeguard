import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not defined in the .env file.");
    }

    console.log("Mongo URI exists:", !!process.env.MONGODB_URI);
    console.log(
      "Mongo host:",
      process.env.MONGODB_URI.split("@")[1]?.split("/")[0]
    );

    const conn = await mongoose.connect(process.env.MONGODB_URI);

    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;