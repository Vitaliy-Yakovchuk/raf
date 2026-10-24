export function executorAllowsTestRunPhase(assignment: { readonly type: string; readonly phase: string }, phase: string): boolean {
  if (!['implement', 'qa', 'hotfix', 'test-scaffold'].includes(assignment.phase) || assignment.type !== 'agent' && assignment.type !== assignment.phase) return false;
  if (assignment.phase === 'test-scaffold') return phase === 'red';
  return phase === assignment.phase || phase === 'integration' || phase === 'red' && ['qa', 'hotfix'].includes(assignment.phase);
}
