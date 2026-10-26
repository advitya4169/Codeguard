import mongoose from 'mongoose';

const repositorySchema = new mongoose.Schema({
  githubRepoId: { type: Number, required: true, unique: true },
  owner: { type: String, required: true }, // e.g., 'octocat'
  name: { type: String, required: true }, // e.g., 'Hello-World'
  fullName: { type: String, required: true }, // e.g., 'octocat/Hello-World'
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Set only for repositories explicitly connected through a verified GitHub App installation.
  installationId: { type: String },
  // Only repositories explicitly connected through the authenticated API flow
  // are eligible for webhook processing. Legacy records default to false.
  isConnected: { type: Boolean, default: false },
  isHookActive: { type: Boolean, default: true },
}, { timestamps: true });

export default mongoose.model('Repository', repositorySchema);
