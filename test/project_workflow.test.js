import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateFinancialEvaluation,
  evaluateDecision,
  getDecisionSnapshot,
  getDiagnosisCompletion,
  getPhaseTransitionError,
  getStudyCompletion,
  isDecisionCurrent,
} from '../src/utils/project_workflow.js';

function completeFormulation() {
  return {
    diagnosis: {
      economicSituation: 'Economía estable',
      socialDemographic: 'Población objetivo identificada',
      legalAspects: 'Normativa revisada',
      geographicLocation: 'Bogotá',
      rawMaterialAvailability: 'Proveedores disponibles',
      financingAvailability: 'Recursos propios',
      environmentalConditions: 'Impacto controlable',
    },
    market: {
      segment: 'Pequeñas empresas',
      need: 'Necesidad validada',
      marketSize: 'Mercado regional',
      competitors: 'Competencia identificada',
      price: '250.000',
      monthlyDemand: '100',
      channels: 'Venta directa',
    },
    technical: {
      location: 'Bogotá',
      process: 'Producción por lotes',
      technology: 'Equipos disponibles',
      resources: 'Insumos disponibles',
      capacity: '150',
      regulations: 'Requisitos revisados',
    },
    administrative: {
      organization: 'Estructura definida',
      responsibilities: 'Responsables asignados',
      staff: 'Equipo definido',
      legalForm: 'Sociedad por acciones simplificada',
      permits: 'Permisos identificados',
    },
    financial: {
      investment: '10.000.000',
      variableCost: '100.000',
      fixedCost: '5.000.000',
      horizon: '5',
      discountRate: '10,0',
    },
    environmental: {
      inputsAndOutputs: 'Insumos y residuos identificados',
      impacts: 'Impactos evaluados',
      mitigation: 'Medidas definidas',
      monitoring: 'Indicadores establecidos',
    },
  };
}

test('calculates localized Colombian currency and strict feasibility indicators', () => {
  const formulation = completeFormulation();
  const evaluation = calculateFinancialEvaluation(formulation);

  assert.equal(getStudyCompletion(formulation).complete, true);
  assert.equal(getDiagnosisCompletion(formulation).complete, true);
  assert.ok(evaluation);
  assert.ok(evaluation.netPresentValue >= 0);
  assert.ok(evaluation.internalRateOfReturn >= evaluation.annualDiscountRate);
  assert.ok(evaluation.simplePaybackYears <= evaluation.horizon);
  assert.equal(evaluateDecision(formulation).approved, true);
});

test('blocks acceptance when any required study or viability criterion fails', () => {
  const incomplete = completeFormulation();
  delete incomplete.environmental.monitoring;
  assert.equal(getStudyCompletion(incomplete).complete, false);
  assert.equal(evaluateDecision(incomplete).approved, false);

  const unviable = completeFormulation();
  unviable.market.price = '1';
  assert.equal(evaluateDecision(unviable).approved, false);
});

test('decision snapshot becomes stale when a diagnosis or study changes', () => {
  const formulation = completeFormulation();
  const decision = { studySnapshot: getDecisionSnapshot(formulation) };
  assert.equal(isDecisionCurrent(decision, formulation), true);

  formulation.diagnosis.financingAvailability = 'Crédito aprobado';
  assert.equal(isDecisionCurrent(decision, formulation), false);
});

test('requires sequential stages, complete studies, a current decision and evidence', () => {
  const formulation = completeFormulation();
  const project = {
    formulation: { lifecycle: { phase: 'idea' } },
    decisions: [],
    operationRecords: [],
  };

  assert.match(
    getPhaseTransitionError({ project, nextFormulation: {
      ...formulation,
      lifecycle: { phase: 'feasibility' },
    } }),
    /una etapa a la vez/,
  );

  project.formulation = { ...formulation, lifecycle: { phase: 'feasibility' } };
  assert.equal(
    getPhaseTransitionError({
      project,
      nextFormulation: { ...formulation, lifecycle: { phase: 'decision' } },
    }),
    null,
  );
  project.formulation = { ...formulation, lifecycle: { phase: 'decision' } };
  assert.match(
    getPhaseTransitionError({
      project,
      nextFormulation: { ...formulation, lifecycle: { phase: 'investment' } },
    }),
    /decisión de aceptación vigente/,
  );

  project.decisions.push({
    outcome: 'accepted',
    studySnapshot: getDecisionSnapshot(formulation),
  });
  assert.equal(
    getPhaseTransitionError({
      project,
      nextFormulation: { ...formulation, lifecycle: { phase: 'investment' } },
    }),
    null,
  );
  project.formulation = { ...formulation, lifecycle: { phase: 'investment' } };
  assert.match(
    getPhaseTransitionError({
      project,
      nextFormulation: { ...formulation, lifecycle: { phase: 'operation' } },
    }),
    /tarea o registra una compra/,
  );

  project.formulation = { ...formulation, lifecycle: { phase: 'operation' } };
  const evaluationStage = {
    ...formulation,
    lifecycle: { phase: 'evaluation' },
  };
  assert.match(
    getPhaseTransitionError({ project, nextFormulation: evaluationStage }),
    /ingreso real y un costo operativo real/,
  );
  project.operationRecords.push({ type: 'income' }, { type: 'cost' });
  assert.equal(
    getPhaseTransitionError({ project, nextFormulation: evaluationStage }),
    null,
  );
});
