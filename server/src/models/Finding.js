import mongoose from 'mongoose';

const findingSchema = new mongoose.Schema({
  reviewJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewJob', required: true },
  title: { type: String, trim: true },
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
  diffContext: {
    type: [{
      lineType: { type: String, enum: ['context', 'added', 'removed'], required: true },
      oldLineNumber: { type: Number, min: 0 },
      newLineNumber: { type: Number, min: 0 },
      code: { type: String, required: true, maxlength: 1000 },
      isTarget: { type: Boolean, default: false },
      truncated: { type: Boolean, default: false },
    }],
    default: undefined,
  },
  explanation: { type: String, required: true },
  suggestedFix: { type: String },
}, { timestamps: true });

export default mongoose.model('Finding', findingSchema);
