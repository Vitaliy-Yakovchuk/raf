import { isAbsolute, join, resolve, sep } from 'node:path';
import type { MainLayoutStartOptions } from './main-layout.ts';

const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

function refuse(message: string): never {
  throw new Error('Main layout expected safe canonical raf mainCopies and consistent Git registration; actual: ' + message);
}

export function configuredMainLayoutPaths(root: string, projects: MainLayoutStartOptions['projects']) {
  if (!isAbsolute(root) || resolve(root) !== root) refuse(`expected canonical absolute root; received ${root}`);
  for (const [id, project] of Object.entries(projects)) {
    if (id !== 'raf' && project.mainCopies !== undefined) refuse(`mainCopies is supported only for raf; received projects.${id}.mainCopies`);
  }
  const raf = projects.raf;
  if (!raf || raf.path !== 'raf-main' || raf.branchPaths?.main !== 'raf-main') refuse('projects.raf.path and branchPaths.main must both be raf-main');
  if (!Array.isArray(raf.mainCopies) || raf.mainCopies.length !== 2) refuse('projects.raf.mainCopies must contain exactly two different physical paths');
  const physical = raf.mainCopies.map(path => {
    if (typeof path !== 'string' || !path || path !== path.trim() || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => ['', '.', '..', '.git'].includes(part))) refuse(`unsafe mainCopies path: ${String(path)}; expected relative path inside ${root}`);
    return resolve(root, path);
  });
  const logical = join(root, 'raf-main');
  if (overlaps(physical[0], physical[1]) || physical.some(path => overlaps(path, logical))) refuse('mainCopies paths must be different and must not overlap raf-main or one another');
  const protectedPaths: string[] = [];
  for (const [id, project] of Object.entries(projects)) {
    for (const path of new Set([project.path, ...Object.values(project.branchPaths ?? {})])) {
      const absolute = resolve(root, path);
      if (absolute === root && id === 'orchestrator' || id === 'raf' && absolute === logical) continue;
      if (physical.some(copy => overlaps(copy, absolute))) refuse(`mainCopies overlaps protected ${id} path ${absolute}`);
      protectedPaths.push(absolute);
    }
  }
  return { logical, physical, protectedPaths };
}

