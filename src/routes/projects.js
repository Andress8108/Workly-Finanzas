import { Router } from 'express';
import Project from '../models/Project.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import ContactRequest from '../models/ContactRequest.js';
import ProjectMemberRequest from '../models/ProjectMemberRequest.js';
import Notification from '../models/Notification.js';
import Document from '../models/Document.js';
import { sendPushNotification } from '../services/push_notifications.js';
import fs from 'node:fs/promises';
import { upload, uploadToImageKit } from '../services/file_storage.js';
import { normalizeTags, validateProjectDates } from '../utils/project_rules.js';
import { getAvailableBudget } from '../utils/budget_rules.js';
import {
  calculateFinancialEvaluation,
  evaluateDecision,
  getDecisionSnapshot,
  getDiagnosisCompletion,
  getPhaseTransitionError,
  getStudyCompletion,
  hasFinancialOperationEvidence,
  isDecisionCurrent,
  PROJECT_PHASES,
} from '../utils/project_workflow.js';

const router = Router();
const formatCopAmount = (amount) =>
  `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(amount)}`;

function getInvestmentGateError(project) {
  const phase = project.formulation?.lifecycle?.phase;
  if (!phase) return null;
  const phaseIndex = PROJECT_PHASES.indexOf(phase);
  const investmentIndex = PROJECT_PHASES.indexOf('investment');
  if (phaseIndex < investmentIndex) {
    return 'El proyecto debe tener una decisión aprobada antes de registrar gastos de inversión.';
  }
  const latestDecision = project.decisions?.at(-1);
  if (
    latestDecision?.outcome !== 'accepted' ||
    !isDecisionCurrent(latestDecision, project.formulation)
  ) {
    return 'La decisión de aceptación no está vigente; vuelve a evaluarla antes de continuar.';
  }
  return null;
}

async function hasExecutionEvidence(project) {
  if (project.expenses?.some((expense) => expense.status === 'completed')) {
    return true;
  }
  return Boolean(await Task.exists({ projectId: project.id, status: 'done' }));
}

async function notifyProjectMembers(project, actorId, type, title, body, expenseId) {
  const memberIds = [...new Set([project.leadId, ...project.memberIds])]
    .filter((memberId) => memberId !== actorId);
  if (memberIds.length === 0) return;

  const members = await User.find({ _id: { $in: memberIds } }).select('_id fcmTokens');
  const notifications = await Notification.insertMany(
    members.map((member) => ({
      userId: member._id,
      type,
      title,
      body,
      projectId: project.id,
      relatedUserId: actorId,
    })),
  );
  await Promise.all(
    members.map((member, index) =>
      sendPushNotification(
        member.fcmTokens?.map(({ token }) => token) || [],
        notifications[index],
        {
          notificationId: notifications[index].id,
          type,
          projectId: project.id,
          expenseId,
        },
      ),
    ),
  );
}

async function projectsWithProgress(projects) {
  const ids = projects.map((project) => project._id.toString());
  const tasks = await Task.find({ projectId: { $in: ids } }).select('projectId submissionUrl');
  const progressByProject = new Map();
  for (const id of ids) {
    const projectTasks = tasks.filter((task) => task.projectId === id);
    const submitted = projectTasks.filter((task) => task.submissionUrl).length;
    progressByProject.set(id, projectTasks.length === 0 ? 0 : Math.round((submitted / projectTasks.length) * 100));
  }
  return projects.map((project) => ({
    ...project.toObject(),
    progress: progressByProject.get(project._id.toString()) ?? 0,
  }));
}

router.get('/', async (req, res) => {
  try {
    const projects = await Project.find({
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    }).sort({ createdAt: -1 });
    res.json(await projectsWithProgress(projects));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, $or: [{ leadId: req.user.id }, { memberIds: req.user.id }] });
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json((await projectsWithProgress([project]))[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/expenses', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    res.json(project.expenses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/expenses', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });

    const investmentError = getInvestmentGateError(project);
    if (investmentError) return res.status(409).json({ error: investmentError });

    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    const justification = typeof req.body.justification === 'string' ? req.body.justification.trim() : '';
    const amount = Number(req.body.amount);
    if (!description || !justification || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Indica qué se comprará, su justificación y un monto válido' });
    }
    if (amount > getAvailableBudget(project)) {
      return res.status(409).json({ error: 'El monto solicitado supera el presupuesto disponible' });
    }

    const updatedProject = await Project.findOneAndUpdate(
      {
        _id: project._id,
        $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
      },
      {
        $push: {
          expenses: {
            description,
            justification,
            requestedAmount: amount,
            requestedById: req.user.id,
          },
        },
      },
      { new: true, runValidators: true },
    );
    if (!updatedProject) {
      return res.status(409).json({
        error: 'El proyecto cambió; vuelve a cargarlo e intenta de nuevo',
      });
    }
    const expense = updatedProject.expenses[updatedProject.expenses.length - 1];

    await notifyProjectMembers(
      updatedProject,
      req.user.id,
      'expenseRequest',
      'Solicitud de gasto',
      `Se solicitaron ${formatCopAmount(amount)} para ${description}`,
      expense.id,
    );
    res.status(201).json(expense);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/expenses/:expenseId/review', async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, leadId: req.user.id });
    if (!project) return res.status(403).json({ error: 'Sólo el líder del proyecto puede revisar gastos' });
    const investmentError = getInvestmentGateError(project);
    if (investmentError) return res.status(409).json({ error: investmentError });
    const expense = project.expenses.id(req.params.expenseId);
    if (!expense || expense.status !== 'pending') {
      return res.status(409).json({ error: 'La solicitud ya no está pendiente' });
    }
    if (typeof req.body.approved !== 'boolean') {
      return res.status(400).json({ error: 'Indica si la solicitud fue aprobada o rechazada' });
    }

    const approved = req.body.approved;
    const reviewNote = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const update = {
      $set: {
        'expenses.$.status': approved ? 'approved' : 'rejected',
        'expenses.$.approvedAmount': approved ? expense.requestedAmount : 0,
        'expenses.$.reviewedById': req.user.id,
        'expenses.$.reviewedAt': new Date(),
        'expenses.$.reviewNote': reviewNote,
      },
    };
    if (approved) update.$inc = { reservedBudget: expense.requestedAmount };

    const updateFilter = {
      _id: project._id,
      leadId: req.user.id,
      expenses: { $elemMatch: { _id: expense._id, status: 'pending' } },
    };
    if (approved) {
      updateFilter.$expr = {
        $lte: [
          {
            $add: [
              { $ifNull: ['$spent', 0] },
              { $ifNull: ['$reservedBudget', 0] },
              expense.requestedAmount,
            ],
          },
          { $ifNull: ['$budget', 0] },
        ],
      };
    }

    const updatedProject = await Project.findOneAndUpdate(updateFilter, update, { new: true });
    if (!updatedProject) {
      const currentProject = await Project.findById(project._id);
      const currentExpense = currentProject?.expenses.id(req.params.expenseId);
      if (currentExpense?.status !== 'pending') {
        return res.status(409).json({ error: 'La solicitud ya fue revisada' });
      }
      return res.status(409).json({ error: 'No hay presupuesto disponible suficiente para aprobar este gasto' });
    }

    const updatedExpense = updatedProject.expenses.id(req.params.expenseId);
    await notifyProjectMembers(
      updatedProject,
      req.user.id,
      'expenseUpdate',
      approved ? 'Gasto aprobado' : 'Solicitud de gasto rechazada',
      approved
        ? `Se aprobaron ${expense.requestedAmount} para ${expense.description}`
        : `Se rechazó la solicitud para ${expense.description}`,
      expense.id,
    );
    res.json(updatedExpense);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/expenses/:expenseId/receipt', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    const investmentError = getInvestmentGateError(project);
    if (investmentError) return res.status(409).json({ error: investmentError });
    const expense = project.expenses.id(req.params.expenseId);
    if (!expense || expense.status !== 'approved') {
      return res.status(409).json({ error: 'Sólo puedes registrar compras de gastos aprobados' });
    }

    const actualAmount = Number(req.body.actualAmount);
    const receiptDocumentIds = Array.isArray(req.body.receiptDocumentIds)
      ? [...new Set(req.body.receiptDocumentIds.filter((id) => typeof id === 'string'))]
      : [];
    if (!Number.isFinite(actualAmount) || actualAmount <= 0 || actualAmount > expense.approvedAmount) {
      return res.status(400).json({ error: 'El monto pagado debe ser mayor que cero y no superar el monto aprobado' });
    }
    if (receiptDocumentIds.length === 0) {
      return res.status(400).json({ error: 'Adjunta al menos una factura o recibo' });
    }

    const receiptCount = await Document.countDocuments({
      _id: { $in: receiptDocumentIds },
      projectId: project.id,
      tags: `gasto-${expense.id}`,
    });
    if (receiptCount !== receiptDocumentIds.length) {
      return res.status(400).json({
        error: 'Uno o más comprobantes no están asociados a esta solicitud de gasto',
      });
    }

    const updatedProject = await Project.findOneAndUpdate(
      {
        _id: project._id,
        $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
        expenses: {
          $elemMatch: {
            _id: expense._id,
            status: 'approved',
            approvedAmount: { $gte: actualAmount },
          },
        },
      },
      {
        $set: {
          'expenses.$.status': 'completed',
          'expenses.$.actualAmount': actualAmount,
          'expenses.$.receiptDocumentIds': receiptDocumentIds,
          'expenses.$.completedAt': new Date(),
        },
        $inc: {
          spent: actualAmount,
          reservedBudget: -expense.approvedAmount,
        },
      },
      { new: true },
    );
    if (!updatedProject) {
      return res.status(409).json({ error: 'El gasto ya fue registrado o cambió el monto aprobado' });
    }

    const updatedExpense = updatedProject.expenses.id(req.params.expenseId);
    await notifyProjectMembers(
      updatedProject,
      req.user.id,
      'expenseUpdate',
      'Compra registrada',
      `Se registró un gasto de ${formatCopAmount(actualAmount)} para ${expense.description}`,
      expense.id,
    );
    res.json(updatedExpense);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/avatar', upload.single('file'), async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, leadId: req.user.id });
    if (!project) {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ error: 'Sólo el líder puede cambiar la foto del proyecto' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    project.avatarUrl = await uploadToImageKit(req.file, 'workly/projects');
    await project.save();
    res.json(project);
  } catch (err) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/member-requests', async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, leadId: req.user.id });
    if (!project) return res.status(403).json({ error: 'Sólo el líder puede invitar contactos' });
    const recipient = await User.findById(req.body.userId).select('name displayName fcmTokens');
    if (!recipient) return res.status(404).json({ error: 'Contacto no encontrado' });
    if (recipient.id === req.user.id || project.memberIds.includes(recipient.id)) {
      return res.status(400).json({ error: 'El contacto ya pertenece al proyecto' });
    }
    const connected = await ContactRequest.findOne({
      status: 'accepted',
      $or: [
        { requesterId: req.user.id, recipientId: recipient._id },
        { requesterId: recipient._id, recipientId: req.user.id },
      ],
    });
    if (!connected) return res.status(403).json({ error: 'Sólo puedes invitar a tus contactos' });
    const existing = await ProjectMemberRequest.findOne({
      projectId: project._id,
      requesterId: req.user.id,
      recipientId: recipient._id,
      status: 'pending',
    });
    if (existing) return res.status(409).json({ error: 'Ya enviaste esta solicitud' });
    const request = await ProjectMemberRequest.findOneAndUpdate(
      { projectId: project._id, requesterId: req.user.id, recipientId: recipient._id },
      { status: 'pending' },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const requester = await User.findById(req.user.id).select('name displayName');
    const notification = await Notification.create({
      userId: recipient._id,
      type: 'projectMemberRequest',
      title: 'Invitación a un proyecto',
      body: `${requester?.displayName || requester?.name || 'Un contacto'} quiere agregarte a ${project.title}`,
      projectId: project.id,
      relatedUserId: req.user.id,
    });
    await sendPushNotification(
      recipient.fcmTokens?.map(({ token }) => token) || [],
      notification,
      { notificationId: notification.id, type: notification.type, projectId: project.id, relatedUserId: req.user.id },
    );
    res.status(201).json({ request, notification });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/member-requests/:projectId', async (req, res) => {
  try {
    const request = await ProjectMemberRequest.findOne({
      projectId: req.params.projectId,
      recipientId: req.user.id,
      requesterId: req.query.requesterId,
      status: 'pending',
    }).populate('projectId', 'title description avatarUrl').populate('requesterId', 'name email avatarUrl');
    if (!request) return res.status(404).json({ error: 'La solicitud ya no está disponible' });
    res.json(request);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/member-requests/:projectId/respond', async (req, res) => {
  try {
    const accepted = req.body.accepted === true;
    const request = await ProjectMemberRequest.findOne({
      projectId: req.params.projectId,
      recipientId: req.user.id,
      requesterId: req.body.requesterId,
      status: 'pending',
    });
    if (!request) return res.status(404).json({ error: 'La solicitud ya no está disponible' });
    if (accepted) {
      const project = await Project.findById(request.projectId);
      if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
      if (!project.memberIds.includes(req.user.id)) {
        project.memberIds.push(req.user.id);
        await project.save();
      }
    }
    request.status = accepted ? 'accepted' : 'rejected';
    await request.save();
    res.json({ message: accepted ? 'Te uniste al proyecto' : 'Invitación rechazada' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const startDate = req.body.startDate ? new Date(req.body.startDate) : null;
    const endDate = req.body.endDate ? new Date(req.body.endDate) : null;
    const dateError = validateProjectDates(startDate, endDate, {
      requireFutureDates: true,
    });
    if (dateError) return res.status(400).json({ error: dateError });
    const budget = Number(req.body.budget ?? 0);
    if (!Number.isFinite(budget) || budget < 0) {
      return res.status(400).json({ error: 'El presupuesto debe ser un monto válido y no negativo' });
    }
    const formulation = req.body.formulation &&
      typeof req.body.formulation === 'object' &&
      !Array.isArray(req.body.formulation)
      ? { ...req.body.formulation }
      : {};
    const lifecycle = formulation.lifecycle &&
      typeof formulation.lifecycle === 'object' &&
      !Array.isArray(formulation.lifecycle)
      ? { ...formulation.lifecycle }
      : {};
    formulation.lifecycle = { ...lifecycle, phase: 'idea' };

    const project = new Project({
      ...req.body,
      leadId: req.user.id,
      memberIds: [req.user.id],
      status: 'planning',
      tags: normalizeTags(req.body.tags || req.body.tagsText || ''),
      budget,
      spent: 0,
      reservedBudget: 0,
      approvedBudget: null,
      expenses: [],
      decisions: [],
      operationRecords: [],
      adjustments: [],
      formulation,
    });
    await project.save();
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/decisions', async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, leadId: req.user.id });
    if (!project) {
      return res.status(403).json({ error: 'Sólo el líder puede registrar la decisión del proyecto' });
    }
    if (project.formulation?.lifecycle?.phase !== 'decision') {
      return res.status(409).json({ error: 'Lleva el proyecto a la etapa de decisión antes de registrar el resultado' });
    }

    const outcome = req.body.outcome;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const observations = typeof req.body.observations === 'string'
      ? req.body.observations.trim()
      : '';
    if (!['accepted', 'rejected'].includes(outcome) || reason.length < 5) {
      return res.status(400).json({ error: 'Selecciona aceptar o rechazar e indica una justificación de al menos cinco caracteres' });
    }

    const result = evaluateDecision(project.formulation);
    if (
      !result.evaluation ||
      !getDiagnosisCompletion(project.formulation).complete ||
      !getStudyCompletion(project.formulation).complete
    ) {
      return res.status(409).json({
        error: 'Completa el diagnóstico, los cinco estudios y los datos financieros antes de registrar una decisión',
      });
    }
    if (outcome === 'accepted' && !result.approved) {
      return res.status(409).json({
        error: `No se puede aprobar el proyecto: ${result.errors.join(' ')}`,
      });
    }

    let approvedBudget = null;
    if (outcome === 'accepted') {
      approvedBudget = Number(req.body.approvedBudget);
      if (
        !Number.isFinite(approvedBudget) ||
        approvedBudget < result.evaluation.initialInvestment ||
        approvedBudget < project.spent + project.reservedBudget
      ) {
        return res.status(400).json({
          error: 'El presupuesto aprobado debe cubrir la inversión inicial y los compromisos registrados',
        });
      }
    }

    project.decisions.push({
      outcome,
      reason,
      observations,
      responsibleId: req.user.id,
      decidedAt: new Date(),
      approvedBudget,
      studySnapshot: getDecisionSnapshot(project.formulation),
      evaluation: result.evaluation,
    });
    if (outcome === 'accepted') {
      project.approvedBudget = approvedBudget;
      project.budget = approvedBudget;
    } else {
      project.approvedBudget = null;
      if (project.status === 'active') project.status = 'onHold';
    }
    await project.save();
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/operations', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    const investmentError = getInvestmentGateError(project);
    if (investmentError) return res.status(409).json({ error: investmentError });
    if (
      PROJECT_PHASES.indexOf(project.formulation?.lifecycle?.phase) <
      PROJECT_PHASES.indexOf('operation')
    ) {
      return res.status(409).json({ error: 'Lleva el proyecto a operación antes de registrar resultados reales' });
    }

    const type = req.body.type;
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : '';
    const description = typeof req.body.description === 'string'
      ? req.body.description.trim()
      : '';
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : null;
    const amount = req.body.amount == null ? 0 : Number(req.body.amount);
    const quantity = req.body.quantity == null ? null : Number(req.body.quantity);
    const unit = typeof req.body.unit === 'string' ? req.body.unit.trim() : '';

    if (
      !['production', 'income', 'cost'].includes(type) ||
      !category ||
      !description ||
      !occurredAt ||
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getTime() > Date.now()
    ) {
      return res.status(400).json({ error: 'Completa el tipo, la categoría, la descripción y una fecha real válida' });
    }
    if (type === 'production' && (!Number.isFinite(quantity) || quantity <= 0 || !unit)) {
      return res.status(400).json({ error: 'Registra una cantidad y una unidad de producción o servicio válidas' });
    }
    if (
      type !== 'production' &&
      (!Number.isFinite(amount) || amount < 0 ||
        (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) ||
        (quantity != null && !unit))
    ) {
      return res.status(400).json({ error: 'Indica un monto igual o mayor que cero y, si registras cantidad, también su unidad' });
    }

    project.operationRecords.push({
      type,
      category,
      description,
      amount: type === 'production' ? 0 : amount,
      quantity,
      unit,
      occurredAt,
      createdById: req.user.id,
    });
    await project.save();
    res.status(201).json(project.operationRecords.at(-1));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/adjustments', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    const phaseIndex = PROJECT_PHASES.indexOf(project.formulation?.lifecycle?.phase);
    if (
      phaseIndex < PROJECT_PHASES.indexOf('evaluation') ||
      !hasFinancialOperationEvidence(project.operationRecords)
    ) {
      return res.status(409).json({ error: 'Registra ingresos y costos reales y evalúa el proyecto antes de proponer ajustes' });
    }

    const description = typeof req.body.description === 'string'
      ? req.body.description.trim()
      : '';
    const responsibleId = typeof req.body.responsibleId === 'string'
      ? req.body.responsibleId
      : null;
    const targetDate = req.body.targetDate ? new Date(req.body.targetDate) : null;
    if (!description) {
      return res.status(400).json({ error: 'Describe el ajuste que se va a realizar' });
    }
    if (
      responsibleId &&
      ![project.leadId, ...project.memberIds].includes(responsibleId)
    ) {
      return res.status(400).json({ error: 'El responsable debe pertenecer al proyecto' });
    }
    if (targetDate && !Number.isFinite(targetDate.getTime())) {
      return res.status(400).json({ error: 'La fecha objetivo no es válida' });
    }

    project.adjustments.push({
      description,
      responsibleId,
      targetDate,
      status: 'pending',
      createdById: req.user.id,
    });
    await project.save();
    res.status(201).json(project.adjustments.at(-1));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/adjustments/:adjustmentId', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    const adjustment = project.adjustments.id(req.params.adjustmentId);
    const statuses = ['pending', 'inProgress', 'completed', 'cancelled'];
    if (!adjustment) return res.status(404).json({ error: 'No se encontró el ajuste' });
    if (!statuses.includes(req.body.status)) {
      return res.status(400).json({ error: 'El estado del ajuste no es válido' });
    }
    adjustment.status = req.body.status;
    adjustment.completedAt = req.body.status === 'completed' ? new Date() : null;
    await project.save();
    res.json(adjustment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/formulation', async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      $or: [{ leadId: req.user.id }, { memberIds: req.user.id }],
    });
    if (!project) {
      return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    }
    if (
      !req.body.formulation ||
      typeof req.body.formulation !== 'object' ||
      Array.isArray(req.body.formulation)
    ) {
      return res.status(400).json({ error: 'La formulación no es válida' });
    }
    if (
      project.formulation?.lifecycle?.phase &&
      typeof req.body.formulation.lifecycle?.phase !== 'string'
    ) {
      return res.status(400).json({
        error: 'La formulación debe conservar la etapa actual del proyecto',
      });
    }
    const executionEvidence = await hasExecutionEvidence(project);
    const transitionError = getPhaseTransitionError({
      project,
      nextFormulation: req.body.formulation,
      hasExecutionEvidence: executionEvidence,
    });
    if (transitionError) return res.status(409).json({ error: transitionError });

    const nextPhase = req.body.formulation.lifecycle?.phase;
    if (
      PROJECT_PHASES.indexOf(nextPhase) >= PROJECT_PHASES.indexOf('investment')
    ) {
      const latestDecision = project.decisions?.at(-1);
      if (
        latestDecision?.outcome === 'accepted' &&
        !isDecisionCurrent(latestDecision, req.body.formulation)
      ) {
        return res.status(409).json({
          error: 'Los estudios cambiaron después de la aprobación. Regresa a decisión y vuelve a evaluar el proyecto.',
        });
      }
    }
    project.formulation = req.body.formulation;
    project.markModified('formulation');
    await project.save();
    res.json({ formulation: project.formulation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const current = await Project.findOne({ _id: req.params.id, leadId: req.user.id });
    if (!current) return res.status(403).json({ error: 'Sólo el líder puede editar el proyecto' });
    const requestedMembers = [...new Set(req.body.memberIds || current.memberIds)];
    const currentMembers = new Set([current.leadId, ...current.memberIds]);
    if (requestedMembers.some((memberId) => !currentMembers.has(memberId))) {
      return res.status(403).json({ error: 'Los nuevos miembros deben unirse mediante una invitación' });
    }
    const memberIds = requestedMembers;
    const nextLeadId = req.body.leadId || current.leadId;
    if (!memberIds.includes(nextLeadId)) return res.status(400).json({ error: 'El líder debe pertenecer al proyecto' });
    const validMembers = await User.countDocuments({ _id: { $in: memberIds } });
    if (validMembers !== memberIds.length) return res.status(400).json({ error: 'Hay miembros inválidos' });

    const startDate = req.body.startDate ? new Date(req.body.startDate) : current.startDate;
    const endDate = req.body.endDate === undefined ? current.endDate : req.body.endDate ? new Date(req.body.endDate) : null;
    const dateError = validateProjectDates(startDate, endDate);
    if (dateError) return res.status(400).json({ error: dateError });
    const budget = Number(req.body.budget ?? current.budget);
    if (!Number.isFinite(budget) || budget < current.spent + current.reservedBudget) {
      return res.status(409).json({
        error: 'El presupuesto no puede quedar por debajo de los gastos registrados y aprobados',
      });
    }
    if (current.approvedBudget != null && budget !== current.approvedBudget) {
      return res.status(409).json({
        error: 'Para cambiar el presupuesto aprobado, registra una nueva decisión de aceptación',
      });
    }
    const requestedStatus = req.body.status ?? current.status;
    if (
      requestedStatus === 'active' &&
      requestedStatus !== current.status &&
      current.formulation?.lifecycle?.phase
    ) {
      const investmentError = getInvestmentGateError(current);
      if (
        investmentError ||
        PROJECT_PHASES.indexOf(current.formulation.lifecycle.phase) <
          PROJECT_PHASES.indexOf('investment')
      ) {
        return res.status(409).json({
          error: investmentError ??
            'Lleva el proyecto a inversión antes de marcarlo como activo',
        });
      }
    }
    if (
      requestedStatus === 'completed' &&
      requestedStatus !== current.status &&
      current.formulation?.lifecycle?.phase &&
      (PROJECT_PHASES.indexOf(current.formulation.lifecycle.phase) <
        PROJECT_PHASES.indexOf('evaluation') ||
        !hasFinancialOperationEvidence(current.operationRecords))
    ) {
      return res.status(409).json({
        error: 'Evalúa los resultados reales del proyecto antes de marcarlo como completado',
      });
    }

    const editableFields = { ...req.body };
    delete editableFields.spent;
    delete editableFields.reservedBudget;
    delete editableFields.expenses;
    delete editableFields.approvedBudget;
    delete editableFields.decisions;
    delete editableFields.operationRecords;
    delete editableFields.adjustments;
    delete editableFields.formulation;
    const project = await Project.findOneAndUpdate({
      _id: req.params.id,
      leadId: req.user.id,
      $expr: {
        $lte: [
          {
            $add: [
              { $ifNull: ['$spent', 0] },
              { $ifNull: ['$reservedBudget', 0] },
            ],
          },
          budget,
        ],
      },
    }, {
      ...editableFields,
      leadId: nextLeadId,
      memberIds,
      startDate,
      endDate,
      budget,
      tags: req.body.tags ? normalizeTags(req.body.tags) : current.tags,
    }, {
      new: true,
      runValidators: true,
    });
    if (!project) {
      return res.status(409).json({
        error: 'El presupuesto no puede quedar por debajo de los gastos registrados y aprobados',
      });
    }
    res.json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Project.findOneAndDelete({ _id: req.params.id, leadId: req.user.id });
    if (!deleted) return res.status(404).json({ error: 'Proyecto no encontrado' });
    await Task.deleteMany({ projectId: req.params.id });
    const { Objective } = await import('../models/Objective.js');
    await Objective.deleteMany({ projectId: req.params.id });
    res.json({ message: 'Proyecto eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/objectives', async (req, res) => {
  try {
    const accessible = await Project.findOne({ _id: req.params.id, $or: [{ leadId: req.user.id }, { memberIds: req.user.id }] });
    if (!accessible) return res.status(403).json({ error: 'No tienes acceso a este proyecto' });
    const { Objective } = await import('../models/Objective.js');
    const objectives = await Objective.find({ projectId: req.params.id });
    res.json(objectives);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
