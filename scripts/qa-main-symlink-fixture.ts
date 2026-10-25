export function prepareLiveProjects(configuration: { projects: Record<string, any> }) {
  const projects = structuredClone(configuration);
  Object.assign(projects.projects.raf, {
    path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
    mainCopies: ['raf-main-a', 'raf-main-b'],
  });
  return projects;
}

export function prepareLegacyLiveProjects(configuration: { projects: Record<string, any> }) {
  const projects = prepareLiveProjects(configuration);
  delete projects.projects.raf.mainCopies;
  return projects;
}
