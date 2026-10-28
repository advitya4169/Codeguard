import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is required. Set it in the service environment.');
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    throw error;
  }
};

export default connectDB;
