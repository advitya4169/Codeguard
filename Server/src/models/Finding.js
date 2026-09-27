import mongoose from 'mongoose';

const findingSchema = new mongoose.Schema({
  reviewJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewJob', required: true },
  category: { 
    type: String, 
    enum: ['bug', 'security', 'performance', 'code_quality', 'maintainability'] 
  },
  severity: { 
    type: String, 
    enum: ['critical', 'high', 'medium', 'low', 'suggestion'] 
  },
  filePath: { type: String, required: true },
  lineNumber: { type: Number },
  explanation: { type: String, required: true },
  suggestedFix: { type: String },
}, { timestamps: true });

export default mongoose.model('Finding', findingSchema);