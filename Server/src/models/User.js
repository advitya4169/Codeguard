import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  githubId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  email: { type: String },
  avatarUrl: { type: String },
  accessToken: { type: String }, // Required later to post reviews to GitHub
}, { timestamps: true });

export default mongoose.model('User', userSchema);