import mongoose from 'mongoose';

const repositorySchema = new mongoose.Schema({
  githubRepoId: { type: Number, required: true, unique: true },
  owner: { type: String, required: true }, // e.g., 'octocat'
  name: { type: String, required: true }, // e.g., 'Hello-World'
  fullName: { type: String, required: true }, // e.g., 'octocat/Hello-World'
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isHookActive: { type: Boolean, default: true },
}, { timestamps: true });

export default mongoose.model('Repository', repositorySchema);