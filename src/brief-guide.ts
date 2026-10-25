import { isAbsolute, join } from 'node:path';
import type { CompiledCatalog, CompiledCommand, CompiledParameter } from './catalog.ts';
import { loadCompiledCatalog } from './compiled-catalog.ts';
import type { AssignmentBriefContext, AssignmentFilePort, AssignmentSnapshot } from './assignment.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ids = (value: unknown, source: string): string[] => {
  if (!Array.isArray(value) || value.some(row => !object(row) || typeof row.id !== 'string' || !row.id)) throw new Error(`Invalid catalog ${source}`);
  const result = value.map(row => (row as { id: string }).id);
  if (new Set(result).size !== result.length) throw new Error(`Ambiguous catalog ${source}`);
  return result;
};

function example(command: CompiledCommand, snapshot: AssignmentSnapshot, context: AssignmentBriefContext): string {
  const tasks = snapshot.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`));
  const known: Record<string, readonly string[]> = {
    id: [context.agentId], project: [context.project], features: context.features, phase: [context.phase],
    tasks, text: [`Доручення ${tasks.join(', ')}: повідомлення про результат або перетин.`],
  };
  const path = command.path.join(' ');
  if (path === 'agent run') delete known.id;
  return [context.rafCommand, path, ...command.parameters.flatMap(parameter => {
    if (!parameter.required && !(path === 'agent update' && parameter.name === 'phase')) return [];
    const values = known[parameter.name];
    if (values && parameter.values && values.some(value => !parameter.values!.some(row => row.id === value))) throw new Error(`Unknown ${parameter.name} for ${path}`);
    const chosen = values?.length ? (parameter.multiple ? values : values.slice(0, 1)) : [parameter.values?.find(row => row.launchableByRaf !== false)?.id ?? `<${parameter.name === 'to' ? 'адреса-з-agent-ps' : parameter.name}>`];
    return chosen.flatMap(value => [parameter.option, shell(value)]);
  })].join(' ');
}

function parameterLine(parameter: CompiledParameter): string {
  return `${parameter.option} (${parameter.required ? 'обов’язковий' : 'необов’язковий'}${parameter.multiple ? ', повторюваний' : ', одиничний'}): ${parameter.description ?? parameter.name}${parameter.values ? `; значення: ${parameter.values.map(row => row.id).join(', ')}` : ''}`;
}

export async function composeBriefGuide(snapshot: AssignmentSnapshot, context: AssignmentBriefContext, _fs: AssignmentFilePort, catalog: CompiledCatalog = loadCompiledCatalog()): Promise<string> {
  if (!context.cwd || !isAbsolute(context.cwd)) throw new Error('Required actual cwd must be absolute, separately from root');
  if (!context.rafCommand?.trim()) throw new Error('Required raf_command invocation prefix is missing');
  if (context.stage !== context.phase) throw new Error(`Incompatible stage ${context.stage} and phase ${context.phase}`);
  if (!context.outcome.trim() || !context.project || !context.agentId || !context.writeBoundaries.length || !snapshot.changes.length || snapshot.changes.some(change => !change.items.length)) throw new Error('Required assignment goal, identity, boundaries and selected items must be defined');
  const constants = catalog.constants;
  const models = catalog.models;
  if (!object(constants) || !object(models)) throw new Error('Invalid compiled brief catalogs');
  if (!ids(models.runners, 'compiled catalog#/models/runners').includes(context.runner)) throw new Error(`Unknown runner ${context.runner}`);
  ids(constants.agentTypes, 'compiled catalog#/constants/agentTypes');
  const phases = ids(constants.agentPhases, 'compiled catalog#/constants/agentPhases');
  if (!phases.includes(context.stage)) throw new Error(`Unknown stage ${context.stage}`);
  const paths = context.rafSubcommands ?? (context.stage === 'main' || context.stage === 'coordinator' ? ['agent ps', 'agent message', 'agent update', 'agent run'] : ['agent ps', 'agent message']);
  const selected = [...new Set(paths)].map(path => {
    const matches = catalog.commands.filter(row => row.path.join(' ') === path);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous compiled catalog command ${path}`);
    return matches[0];
  });
  const commandSections = selected.map(command => {
    const path = command.path.join(' ');
    const index = catalog.commands.indexOf(command);
    return [`- ${path}: ${command.description ?? ''}`,
      ...command.parameters.map(parameter => `  ${parameterLine(parameter)}`),
      `  Приклад форми: ${example(command, snapshot, context)}`,
      `  Help: ${context.rafCommand} help ${path} (або ${context.rafCommand} ${path} --help).`,
      ...['prerequisites', 'sideEffects', 'output', 'errors'].map(key => typeof command.metadata[key] === 'string' ? `  ${key}: ${command.metadata[key]}` : '').filter(Boolean),
      ...(path === 'test run' ? ['  Чужа unit-група доступна implement/qa/hotfix лише за кінцевою декларацією `; regressionGroups=["change/group"]` вибраного item і довіреним launch snapshot із sourceChange/sourceItem та preset profileId/files. Фаза/project/workspace/branch незмінні; без --files діє preset, явні files і файли --only — лише його піднабір, самі IDs — knownRed цільової групи. Drift preset або неактивна ціль потребує нового перевіреного запуску. Використовуй той самий агрегат/QA HOME цільової групи; дозвіл не розширює assignment.changes, звітні items, файлові права чи права test-scaffold. У доказі назви source item і цільову групу. Стару сесію без grant або недоступний канал передай main через agent message з точною командою; до готовності довіреного каналу регресію виконує main за чинною політикою red.'] : []),
      `  Деталі за потреби: ${join(snapshot.root, 'conf', 'raf-constants.json')}#/commands/${index}; параметри, valueSources й контракт ${path} при помилці або уточненні виклику.`,
    ].join('\n');
  });
  return [
    '# Пам’ятка raf',
    `Доступний префікс: ${context.rafCommand}. Використовуй адресний ID agent_id; session_name та внутрішній ID tmux не є адресою одержувача. Приклади показують форму виклику, не надають додаткових повноважень. Значення в <…> визнач перед виконанням; адресата знайди через agent ps.`,
    ...commandSections,
    'При помилці збережи ненульовий код виходу, прочитай причину, received/expected, completed/pending і remediation; звернись до адресного help. Перед повтором врахуй побічні дії. Невідоме не видавай за встановлене; failed не перетворюй на succeeded. Не друкуй секрети, сирі великі логи або весь бриф. Розбіжність help і каталогу передай main для виправлення, без локального alias. Help не запускає агентів і не збирає зовнішні квоти.',
    '# Адресний покажчик джерел',
    'Читай зараз лише явно призначені предметні вимоги з усіма сценаріями й застосовні обмеження стадії. Умовні деталі читай тільки за вказаним тригером; покажчик не вимагає читати всі адреси.',
    'Точні предметні адреси, секції/вимоги, причини й умови читання наведено один раз у sources конкретного доручення нижче. Якщо предметний контракт там не визначений, уточни його за вибраними пунктами tasks.md і proposal.md; не читай усі design/delta.',
    `- ${join(snapshot.root, 'conf', 'raf-constants.json')}#/reportStatuses — лише статуси під час запису звіту за переданою report_schema.`,
    `- ${join(snapshot.root, 'openspec/specs/projects/orchestrator/autonomous-development/spec.md')} — «Аудит та вилучення неактуальних змін», коли виявлено суперечність; «Архівація останнім виконавцем» і skip_specs, коли закрито всі пункти всієї зміни.`,
    ...(context.commitOwnWork ? [`- ${join(snapshot.root, 'openspec/specs/projects/orchestrator/parallel-development/spec.md')} — «Коміти в спільному робочому дереві» зі сценаріями; читати зараз перед власним комітом або при перетині файлів.`] : []),
    `Фактичний робочий каталог cwd: ${context.cwd}. Корінь OpenSpec root: ${snapshot.root}. Передумови й критерії перевірки/очікуваний результат визначені в outcome та вибраних пунктах нижче; відсутні конкретні передумови уточни перед залежною дією. Результат передай атомарним JSON за report_path/report_schema; повідомлення в чаті його не замінює.`,
  ].join('\n\n');
}
