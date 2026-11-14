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

const decisionSchema = new mongoose.Schema(
  {
    outcome: { type: String, enum: ['accepted', 'rejected'], required: true },
    reason: { type: String, required: true, trim: true },
    observations: { type: String, default: '', trim: true },
    responsibleId: { type: String, required: true },
    decidedAt: { type: Date, default: Date.now },
    approvedBudget: { type: Number, default: null, min: 0 },
    studySnapshot: { type: [String], default: [] },
    evaluation: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: false },
);

const operationRecordSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['production', 'income', 'cost'],
      required: true,
    },
    category: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, default: null, min: 0.001 },
    unit: { type: String, default: '', trim: true },
    occurredAt: { type: Date, required: true },
    createdById: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

const adjustmentSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    responsibleId: { type: String, default: null },
    targetDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ['pending', 'inProgress', 'completed', 'cancelled'],
      default: 'pending',
    },
    createdById: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
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
    approvedBudget: { type: Number, default: null, min: 0 },
    expenses: { type: [expenseSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    operationRecords: { type: [operationRecordSchema], default: [] },
    adjustments: { type: [adjustmentSchema], default: [] },
    progress: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    formulation: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

export default mongoose.model('Project', projectSchema);
