export function getProjectMemberIds(project) {
  if (!project) return new Set();
  return new Set([project.leadId, ...(project.memberIds || [])].map((id) => String(id)));
}

export function validateProjectDates(
  startDate,
  endDate,
  { requireFutureDates = false, now = new Date() } = {},
) {
  if (requireFutureDates) {
    const utcDay = (value) => {
      const date = new Date(value);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    };
    const today = utcDay(now);
    const startDay = startDate ? utcDay(startDate) : NaN;
    if (!Number.isFinite(startDay) || startDay <= today) {
      return 'La fecha de inicio debe ser posterior a hoy';
    }
    if (endDate) {
      const endDay = utcDay(endDate);
      if (!Number.isFinite(endDay) || endDay <= today) {
        return 'La fecha de fin debe ser posterior a hoy';
      }
    }
  }

  if (!startDate || !endDate) return null;
  if (new Date(endDate) < new Date(startDate)) {
    return 'La fecha de fin no puede ser anterior a la fecha de inicio';
  }
  return null;
}

export function validateTaskAssignee(project, assigneeId) {
  if (!assigneeId) return null;
  const memberIds = getProjectMemberIds(project);
  if (!memberIds.has(String(assigneeId))) {
    return 'El asignado debe pertenecer al proyecto';
  }
  return null;
}

export function normalizeTags(rawValue = '') {
  return String(rawValue)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, arr) => arr.indexOf(tag) === index);
}
