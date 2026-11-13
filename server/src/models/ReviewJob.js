import mongoose from 'mongoose';

const reviewJobSchema = new mongoose.Schema({
  repositoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repository', required: true },
  prNumber: { type: Number, required: true },
  commitSha: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['queued', 'processing', 'completed', 'failed', 'stale'],
    default: 'queued' 
  },
  summary: { type: String }, // A general AI summary of the PR
  githubPublicationStatus: {
    type: String,
    enum: ['pending', 'published', 'duplicate', 'stale', 'failed', 'uncertain', 'not_needed'],
  },
  githubPublicationId: { type: Number },
  githubPublicationUrl: { type: String },
  githubPublishedAt: { type: Date },
}, { timestamps: true });

// A single persisted review represents one PR head revision in one repository.
reviewJobSchema.index(
  { repositoryId: 1, prNumber: 1, commitSha: 1 },
  { unique: true }
);

export default mongoose.model('ReviewJob', reviewJobSchema);
