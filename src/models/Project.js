import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    justification: { type: String, required: true, trim: true },
    requestedAmount: { type: Number, required: true, min: 0.01 },
    approvedAmount: { type: Number, default: 0, min: 0 },
    actualAmount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'completed'],
      default: 'pending',
    },
    requestedById: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    reviewedById: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    receiptDocumentIds: { type: [String], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

const projectSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    avatarUrl: { type: String, default: null },
    description: { type: String, default: '' },
    area: { type: String, default: null },
    status: {
      type: String,
      enum: ['planning', 'active', 'onHold', 'completed', 'cancelled'],
      default: 'planning',
    },
    leadId: { type: String, required: true },
    memberIds: { type: [String], default: [] },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    budget: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    reservedBudget: { type: Number, default: 0 },
    expenses: { type: [expenseSchema], default: [] },
    progress: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    formulation: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

export default mongoose.model('Project', projectSchema);
