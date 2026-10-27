import mongoose from 'mongoose';

const installationSchema = new mongoose.Schema({
  installationId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountId: { type: String, required: true },
  accountLogin: { type: String, required: true },
  accountName: { type: String },
  accountType: { type: String, required: true },
  status: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
    required: true,
  },
}, { timestamps: true });

export default mongoose.model('Installation', installationSchema);
