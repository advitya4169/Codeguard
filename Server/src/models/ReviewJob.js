import mongoose from 'mongoose';

const reviewJobSchema = new mongoose.Schema({
  repositoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repository', required: true },
  prNumber: { type: Number, required: true },
  commitSha: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['queued', 'processing', 'completed', 'failed'], 
    default: 'queued' 
  },
  summary: { type: String }, // A general AI summary of the PR
}, { timestamps: true });

export default mongoose.model('ReviewJob', reviewJobSchema);