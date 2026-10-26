import mongoose from 'mongoose';

const githubAppOAuthStateSchema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  purpose: { type: String, enum: ['install', 'authorize'], required: true },
  installationId: { type: String },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

export default mongoose.model('GitHubAppOAuthState', githubAppOAuthStateSchema);
