export function getAvailableBudget(project) {
  return Math.max(
    0,
    project.budget - project.spent - (project.reservedBudget || 0),
  );
}
