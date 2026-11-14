export const PROJECT_PHASES = [
  'idea',
  'diagnosis',
  'profile',
  'prefeasibility',
  'feasibility',
  'decision',
  'investment',
  'operation',
  'evaluation',
  'adjustments',
];

export const DIAGNOSIS_FIELDS = [
  'economicSituation',
  'socialDemographic',
  'legalAspects',
  'geographicLocation',
  'rawMaterialAvailability',
  'financingAvailability',
  'environmentalConditions',
];

export const REQUIRED_STUDIES = {
  market: [
    'segment',
    'need',
    'marketSize',
    'competitors',
    'price',
    'monthlyDemand',
    'channels',
  ],
  technical: [
    'location',
    'process',
    'technology',
    'resources',
    'capacity',
    'regulations',
  ],
  administrative: [
    'organization',
    'responsibilities',
    'staff',
    'legalForm',
    'permits',
  ],
  financial: [
    'investment',
    'variableCost',
    'fixedCost',
    'horizon',
    'discountRate',
  ],
  environmental: ['inputsAndOutputs', 'impacts', 'mitigation', 'monitoring'],
};

const REQUIRED_FINANCIAL_INPUTS = [
  ['market', 'price', { min: 0, exclusiveMin: true }],
  ['market', 'monthlyDemand', { min: 0 }],
  ['technical', 'capacity', { min: 0, exclusiveMin: true }],
  ['financial', 'investment', { min: 0, exclusiveMin: true }],
  ['financial', 'variableCost', { min: 0 }],
  ['financial', 'fixedCost', { min: 0 }],
  ['financial', 'horizon', { min: 1, max: 100, integer: true }],
  ['financial', 'discountRate', { min: 0, max: 1000 }],
];

function section(formulation, key) {
  const value = formulation?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function parseLocalizedNumber(input, preferDecimalSeparator = false) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input !== 'string') return null;

  const value = input.trim().replace(/\s/g, '');
  if (!value || !/^[+-]?[0-9.,]+$/.test(value)) return null;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  let normalized;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const separatorIndex = value.lastIndexOf(decimalSeparator);
    const integer = value.slice(0, separatorIndex);
    const fraction = value.slice(separatorIndex + 1);
    if (
      value.split(decimalSeparator).length !== 2 ||
      !/^\d+$/.test(fraction) ||
      (integer.includes(groupingSeparator) &&
        !hasValidGroups(integer, groupingSeparator))
    ) {
      return null;
    }
    normalized =
      `${integer.replaceAll(groupingSeparator, '')}.${fraction}`;
  } else {
    const separator = lastComma >= 0 ? ',' : '.';
    const separatorIndex = lastComma >= 0 ? lastComma : lastDot;
    if (separatorIndex < 0) {
      normalized = value;
    } else {
      const integer = value.slice(0, separatorIndex);
      const fraction = value.slice(separatorIndex + 1);
      const count = value.split(separator).length - 1;
      if (!/^\d+$/.test(fraction)) return null;
      if (
        !preferDecimalSeparator &&
        (count > 1 || fraction.length === 3)
      ) {
        if (!hasValidGroups(value, separator)) return null;
        normalized = value.replaceAll(separator, '');
      } else {
        if (count > 1) return null;
        normalized = `${integer}.${fraction}`;
      }
    }
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidGroups(value, separator) {
  const unsigned = value.replace(/^[+-]/, '');
  const groups = unsigned.split(separator);
  return groups.length > 1 &&
    groups[0].length > 0 &&
    groups[0].length <= 3 &&
    /^\d+$/.test(groups[0]) &&
    groups.slice(1).every((group) => group.length === 3 && /^\d+$/.test(group));
}

export function getStudyCompletion(formulation) {
  const missing = [];
  for (const [study, fields] of Object.entries(REQUIRED_STUDIES)) {
    const values = section(formulation, study);
    for (const field of fields) {
      const value = values[field];
      if (value == null || String(value).trim() === '') {
        missing.push(`${study}.${field}`);
      }
    }
  }

  for (const [study, field, rules] of REQUIRED_FINANCIAL_INPUTS) {
    const parsed = parseLocalizedNumber(
      section(formulation, study)[field],
      study === 'financial' && field === 'discountRate',
    );
    if (
      parsed == null ||
      parsed < rules.min ||
      (rules.exclusiveMin && parsed === rules.min) ||
      (rules.max != null && parsed > rules.max) ||
      (rules.integer && !Number.isInteger(parsed))
    ) {
      const key = `${study}.${field}`;
      if (!missing.includes(key)) missing.push(key);
    }
  }

  const evaluation = calculateFinancialEvaluation(formulation);
  if (!evaluation) {
    for (const [study, field] of REQUIRED_FINANCIAL_INPUTS) {
      if (!missing.includes(`${study}.${field}`)) {
        const value = section(formulation, study)[field];
        const parsed = parseLocalizedNumber(
          value,
          study === 'financial' && field === 'discountRate',
        );
        if (parsed == null) missing.push(`${study}.${field}`);
      }
    }
  }
  return { complete: missing.length === 0, missing };
}

export function getDiagnosisCompletion(formulation) {
  const values = section(formulation, 'diagnosis');
  const missing = DIAGNOSIS_FIELDS.filter(
    (field) => String(values[field] ?? '').trim().length === 0,
  );
  return { complete: missing.length === 0, missing };
}

export function calculateFinancialEvaluation(
  formulation,
  { demandChange = 0, priceChange = 0, costChange = 0 } = {},
) {
  const parsed = new Map();
  for (const [study, field, rules] of REQUIRED_FINANCIAL_INPUTS) {
    const value = parseLocalizedNumber(
      section(formulation, study)[field],
      study === 'financial' && field === 'discountRate',
    );
    if (
      value == null ||
      value < rules.min ||
      (rules.exclusiveMin && value === rules.min) ||
      (rules.max != null && value > rules.max) ||
      (rules.integer && !Number.isInteger(value))
    ) {
      return null;
    }
    parsed.set(`${study}.${field}`, value);
  }

  const price = parsed.get('market.price') * (1 + priceChange);
  const demand = parsed.get('market.monthlyDemand') * (1 + demandChange);
  const capacity = parsed.get('technical.capacity');
  const units = Math.min(demand, capacity);
  const variableCost = parsed.get('financial.variableCost') * (1 + costChange);
  const fixedCost = parsed.get('financial.fixedCost') * (1 + costChange);
  const annualRevenue = price * units * 12;
  const annualOperatingCosts = (variableCost * units + fixedCost) * 12;
  const annualCashFlow = annualRevenue - annualOperatingCosts;
  const initialInvestment = parsed.get('financial.investment');
  const horizon = parsed.get('financial.horizon');
  const annualDiscountRate = parsed.get('financial.discountRate') / 100;

  const netPresentValue = calculateNpv(
    initialInvestment,
    annualCashFlow,
    horizon,
    annualDiscountRate,
  );
  const internalRateOfReturn = calculateIrr(
    initialInvestment,
    annualCashFlow,
    horizon,
  );
  const simplePaybackYears =
    annualCashFlow > 0 ? initialInvestment / annualCashFlow : null;
  const presentValueOfBenefits = presentValue(
    annualRevenue,
    horizon,
    annualDiscountRate,
  );
  const presentValueOfOperatingCosts = presentValue(
    annualOperatingCosts,
    horizon,
    annualDiscountRate,
  );
  const costBenefitRatio =
    initialInvestment + presentValueOfOperatingCosts > 0
      ? presentValueOfBenefits /
        (initialInvestment + presentValueOfOperatingCosts)
      : null;

  if (
    ![
      netPresentValue,
      annualRevenue,
      annualOperatingCosts,
      annualCashFlow,
      presentValueOfBenefits,
      presentValueOfOperatingCosts,
    ].every(Number.isFinite)
  ) {
    return null;
  }

  return {
    netPresentValue,
    internalRateOfReturn,
    simplePaybackYears,
    costBenefitRatio,
    initialInvestment,
    annualRevenue,
    annualOperatingCosts,
    annualCashFlow,
    horizon,
    annualDiscountRate,
  };
}

function calculateNpv(investment, annualCashFlow, horizon, rate) {
  let value = -investment;
  for (let year = 1; year <= horizon; year++) {
    value += annualCashFlow / (1 + rate) ** year;
  }
  return value;
}

function presentValue(annualAmount, horizon, rate) {
  let value = 0;
  for (let year = 1; year <= horizon; year++) {
    value += annualAmount / (1 + rate) ** year;
  }
  return value;
}

function calculateIrr(investment, annualCashFlow, horizon) {
  if (annualCashFlow <= 0) return null;
  const valueAt = (rate) => calculateNpv(investment, annualCashFlow, horizon, rate);
  let low = -0.999999;
  if (valueAt(low) < 0) return null;
  let high = 1;
  while (valueAt(high) > 0 && high < 1_000_000) high = high * 2 + 1;
  if (valueAt(high) > 0) return null;
  for (let iteration = 0; iteration < 100; iteration++) {
    const middle = (low + high) / 2;
    if (valueAt(middle) > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function getDecisionSnapshot(formulation) {
  const fields = [
    ...DIAGNOSIS_FIELDS.map((field) => ['diagnosis', field]),
    ...Object.entries(REQUIRED_STUDIES).flatMap(([study, studyFields]) =>
      studyFields.map((field) => [study, field]),
    ),
  ];
  return fields.map(([study, field]) =>
    String(section(formulation, study)[field] ?? '').trim(),
  );
}

export function isDecisionCurrent(decision, formulation) {
  return Array.isArray(decision?.studySnapshot) &&
    JSON.stringify(decision.studySnapshot) ===
      JSON.stringify(getDecisionSnapshot(formulation));
}

export function hasFinancialOperationEvidence(operationRecords = []) {
  return operationRecords.some((record) => record.type === 'income') &&
    operationRecords.some((record) => record.type === 'cost');
}

export function evaluateDecision(formulation) {
  const completion = getStudyCompletion(formulation);
  const diagnosis = getDiagnosisCompletion(formulation);
  const evaluation = calculateFinancialEvaluation(formulation);
  const errors = [];
  if (!diagnosis.complete) {
    errors.push('Completa el diagnóstico empresarial antes de registrar una decisión.');
  }
  if (!completion.complete) {
    errors.push('Completa los cinco estudios requeridos y valida sus datos.');
  }
  if (!evaluation) {
    errors.push('No se puede calcular la evaluación financiera.');
  } else {
    if (evaluation.netPresentValue < 0) {
      errors.push('El VPN debe ser igual o mayor que cero.');
    }
    if (
      evaluation.internalRateOfReturn == null ||
      evaluation.internalRateOfReturn < evaluation.annualDiscountRate
    ) {
      errors.push('La TIR debe ser igual o mayor que la tasa de descuento.');
    }
    if (
      evaluation.simplePaybackYears == null ||
      evaluation.simplePaybackYears > evaluation.horizon
    ) {
      errors.push('La recuperación debe ocurrir dentro del horizonte evaluado.');
    }
  }
  return { approved: errors.length === 0, errors, evaluation };
}

export function getPhaseTransitionError({
  project,
  nextFormulation,
  hasExecutionEvidence = false,
}) {
  const currentFormulation = project.formulation || {};
  const currentPhase = currentFormulation.lifecycle?.phase || 'idea';
  const nextPhase = nextFormulation.lifecycle?.phase || currentPhase;
  const currentIndex = PROJECT_PHASES.indexOf(currentPhase);
  const nextIndex = PROJECT_PHASES.indexOf(nextPhase);

  if (nextIndex < 0) return 'La etapa seleccionada no es válida.';
  if (currentIndex < 0) return 'La etapa actual del proyecto no es válida.';
  if (nextIndex <= currentIndex) return null;
  if (nextIndex !== currentIndex + 1) {
    return 'Avanza una etapa a la vez para conservar el seguimiento del proyecto.';
  }

  if (nextPhase === 'profile' && !getDiagnosisCompletion(nextFormulation).complete) {
    return 'Completa el diagnóstico empresarial antes de iniciar la formulación.';
  }
  if (nextPhase === 'decision') {
    if (!getDiagnosisCompletion(nextFormulation).complete) {
      return 'Completa el diagnóstico empresarial antes de decidir.';
    }
    if (!getStudyCompletion(nextFormulation).complete) {
      return 'Completa los estudios de mercado, técnico, administrativo, financiero y ambiental antes de decidir.';
    }
    if (!calculateFinancialEvaluation(nextFormulation)) {
      return 'Completa los datos financieros requeridos para evaluar el proyecto.';
    }
  }
  if (nextPhase === 'investment') {
    const latestDecision = project.decisions?.at(-1);
    if (
      latestDecision?.outcome !== 'accepted' ||
      !isDecisionCurrent(latestDecision, nextFormulation)
    ) {
      return 'Se requiere una decisión de aceptación vigente para iniciar la inversión.';
    }
  }
  if (nextPhase === 'operation') {
    const latestDecision = project.decisions?.at(-1);
    if (
      latestDecision?.outcome !== 'accepted' ||
      !isDecisionCurrent(latestDecision, nextFormulation)
    ) {
      return 'La aceptación del proyecto debe seguir vigente para iniciar operaciones.';
    }
    if (!hasExecutionEvidence) {
      return 'Completa al menos una tarea o registra una compra ejecutada antes de iniciar operaciones.';
    }
  }
  if (
    ['evaluation', 'adjustments'].includes(nextPhase) &&
    !hasFinancialOperationEvidence(project.operationRecords || [])
  ) {
    return 'Registra al menos un ingreso real y un costo operativo real antes de evaluar el proyecto.';
  }
  return null;
}
