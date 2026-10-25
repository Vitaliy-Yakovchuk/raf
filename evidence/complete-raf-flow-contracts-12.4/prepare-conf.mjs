import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = '/srv/dev/work/orchestrator/conf/raf-constants.json';
const original = fs.readFileSync(source, 'utf8');
const constants = JSON.parse(original);
const codes = JSON.parse(fs.readFileSync(new URL('./current-error-codes.json', import.meta.url), 'utf8')).filter(entry => !['ENOTSUP', 'EXDEV'].includes(entry.id));
codes.push({ id: 'BUILD_FAILED', description: 'Не вдалося перевірити або зібрати каталог raf.', exitCode: 1 });
const descriptions = {
  UNKNOWN_COMMAND: 'Невідомий шлях команди або довідки.', UNKNOWN_ARGUMENT: 'Невідомий аргумент або зайве позиційне значення.',
  DUPLICATE_ARGUMENT: 'Одиничний параметр передано повторно.', MISSING_VALUE: 'Параметр потребує непорожнього значення.', MISSING_REQUIRED: 'Не задано обов’язковий параметр.',
  INVALID_VALUE: 'Значення або комбінація параметрів не підтримуються.', TYPE_NOT_LAUNCHABLE: 'Тип агента обліковується, але не запускається raf.',
  HANDLER_FAILED: 'Обробник завершився помилкою; причина невідома.', HANDLER_UNAVAILABLE: 'Обробник команди недоступний.', COMMAND_UNAVAILABLE: 'Команда недоступна в обраному поколінні raf.',
  CATALOG_UNAVAILABLE: 'Скомпільований каталог відсутній або пошкоджений.', CONFIGURATION_INVALID: 'Конфігурація відсутня або не відповідає контракту.',
  PRODUCTION_ENTRY_FAILED: 'Не вдалося завершити production-операцію raf.', STATE_CONTEXT_REFUSED: 'Не доведено право цього покоління на контекст стану.',
};
for (const code of codes) if (descriptions[code.id]) code.description = descriptions[code.id];
constants.errorCodes = codes.sort((a, b) => a.id.localeCompare(b.id, 'en'));
const common = ['UNKNOWN_COMMAND', 'UNKNOWN_ARGUMENT', 'DUPLICATE_ARGUMENT', 'MISSING_VALUE', 'MISSING_REQUIRED', 'INVALID_VALUE', 'HANDLER_FAILED', 'HANDLER_UNAVAILABLE', 'COMMAND_UNAVAILABLE', 'CATALOG_UNAVAILABLE', 'CONFIGURATION_INVALID', 'PRODUCTION_ENTRY_FAILED', 'STATE_CONTEXT_REFUSED', 'TIMING_FAILED'];
const metadata = {
  'agent run': ['Уповноважений викликач; точні активні пункти OpenSpec, зареєстрований project/workspace та доступний runner. --tasks містить точні change:item, а --features — зміни доручення.', 'Резервує доручення, перевіряє sandbox і процесну ідентичність, запускає runner у tmux та доставляє бриф. JSON-звіт і перевірка комітів/галочок визначають результат роботи окремо від доставки.', 'JSON результату запуску з runId та адресою; exit 0 означає успішну операцію запуску, а не виконане доручення.'],
  'agent message': ['Адресу одержувача отримано через agent ps; відправник перевірений та має право доставки.', 'Доставляє текст активному адресату через його адаптер; receipt підтверджує доставку за контрактом каналу.', 'JSON receipt; exit 0 лише для підтвердженої доставки.'],
  'agent ps': ['Доступ до ізольованого/робочого SQLite відповідно до покоління raf та перевірені OS identity.', 'Звіряє процеси й поточні сесії, обробляє прийняті результати та належні завершення; не запускає нових агентів.', 'JSON поточних сесій з адресними ID, activity, process та observation; адресою є addressId.'],
  'agent update': ['Уповноважений викликач і активна адреса --id. project/features/phase — актуальні метадані сесії.', 'Оновлює лише передані метадані сесії в SQLite, без нового запуску runner.', 'JSON оновленої активності; exit 0 після збереження.'],
  'agent interrupt': ['Уповноважений викликач і перевірений живий процес за --id.', 'Надсилає адаптерне переривання поточної роботи зі збереженням сесії; не замінює close.', 'JSON підтвердження переривання; exit 0 після виконання операції.'],
  'runner enable': ['Уповноважений викликач; --runner із статичного models.json#/runners.', 'Ідемпотентно вмикає runner у SQLite; не змінює conf/models.json, квоти чи enabled конкретної моделі.', 'JSON {runner, enabled}; exit 0 після збереження перемикача.'],
  'runner disable': ['Уповноважений викликач; --runner із статичного models.json#/runners.', 'Ідемпотентно вимикає runner у SQLite; не зупиняє вже запущені процеси й не змінює conf/models.json.', 'JSON {runner, enabled}; exit 0 після збереження перемикача.'],
  'runner list': ['Валідний каталог моделей та поточний SQLite; статичний набір runner у help не означає його поточну доступність.', 'Читає поточні перемикачі, придатність моделей і останні квоти; не запускає зовнішній probe для help.', 'JSON доступності моделей/runners із причинами та свіжістю квот.'],
  'service start': ['Зареєстроване дерево raf main, валідний state context і налаштований service host.', 'Ідемпотентно запускає одну фонову службу через singleton ownership/readiness; агентів не перезапускає.', 'JSON фактичного стану служби; exit 0 лише після перевіреної готовності.'],
  'service status': ['Валідний state context і конфігурація служби.', 'Перевіряє поточний endpoint/ownership і доступну діагностику; не запускає службу.', 'JSON поточного стану, включно з відсутністю чи невідомою діагностикою.'],
  'service stop': ['Уповноважений викликач, state context і перевірена identity служби.', 'Штатно зупиняє лише службу; зберігає агентів, нагадування й поточний стан.', 'JSON фактичного завершення служби; exit 0 після підтвердження зупинки.'],
  'reminder add': ['Адресат --to активний; --at — ISO 8601 із Z/зсувом. --event, --event-id та --event-action задаються всі разом або відсутні.', 'Створює нагадування й застосовну прив’язку події в SQLite; зберігає первинного адресата.', 'JSON створеного нагадування; exit 0 після збереження.'],
  'reminder list': ['Валідний state context; --to, якщо заданий, фільтрує поточного адресата.', 'Читає поточні нагадування з чинною обробкою доставки та строків збереження.', 'JSON відібраних нагадувань.'],
  'reminder update': ['Точний --id незакритого й ще не активованого нагадування; передано хоча б одну зміну. Трійка event/event-id/event-action повна.', 'Оновлює передані поля; --at не повертає активне нагадування у майбутнє й не змінює первинного адресата.', 'JSON оновленого нагадування; exit 0 після збереження.'],
  'reminder activate': ['Точний --id доступного нагадування та уповноважений викликач.', 'Активує нагадування і передає його поточному адресату за спільним каналом доставки.', 'JSON фактичного результату активації.'],
  'reminder close': ['Точний --id та непорожня --reason; уповноважений викликач.', 'Закриває нагадування зі збереженням причини та дозволеної історії.', 'JSON закритого нагадування; exit 0 після збереження.'],
  'reminder reassign': ['Точний --id і активний новий адресат --to; уповноважений викликач.', 'Змінює поточного адресата, зберігаючи первинного адресата й стан нагадування.', 'JSON перепризначеного нагадування.'],
  'reminder close-all': ['--created-for визначає первинного адресата; --reason непорожня; уповноважений викликач.', 'Закриває відібрані нагадування з причиною за чинними правами, без видалення чужих.', 'JSON результату масового закриття з фактичним відбором.'],
  'command stats': ['Валідний state context та налаштовані commandTiming.', 'Читає поточні EMA-агрегати команд; не створює історичного журналу.', 'JSON статистики команд із budgetMs або null, якщо бюджет для команди не визначено.'],
  'help': ['Скомпільований артефакт цього покоління. raf, raf --help і raf help показують корінь; raf help <path> та raf <path> --help еквівалентні.', 'Лише читає каталог; SQLite, служба, Git, секрети й зовнішні runners не потрібні.', 'JSON довідки: usage, parameters/defaults/values, prerequisites, sideEffects, output, errors, examples та спільні константи.'],
};
const exampleValues = {id:'worker', to:'main', text:'Приклад повідомлення', at:'2026-10-25T18:00:00Z', reason:'Роботу завершено', 'created-for':'main', group:'complete-raf-flow-contracts/catalog-generator', bug:'raf:1', attachment:'attachment-id', 'text-file':'comment.txt', 'output-file':'attachment.bin', features:'complete-raf-flow-contracts', tasks:'complete-raf-flow-contracts:12.4'};
const models = JSON.parse(fs.readFileSync('/srv/dev/work/orchestrator/conf/models.json', 'utf8'));
const projects = JSON.parse(fs.readFileSync('/srv/dev/work/orchestrator/conf/projects.json', 'utf8'));
const resolve = reference => {
  const [name, pointer] = reference.split('#');
  let value = {'raf-constants.json':constants, 'models.json':models, 'projects.json':projects}[name];
  for (const key of pointer.slice(1).split('/')) value = value[key.replaceAll('~1','/').replaceAll('~0','~')];
  return Array.isArray(value) ? value : Object.keys(value);
};
const quote = value => /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value);
for (const command of constants.commands) {
  const name = command.path.join(' ');
  if (metadata[name]) [command.prerequisites, command.sideEffects, command.output] = metadata[name];
  const category = command.path[0].toUpperCase();
  const specific = codes.filter(code => code.id.startsWith(category+'_') || category === 'AGENT' && /^(LAUNCH_|RUNNER_|TASK_|SESSION_|WORKSPACE_|REPORT_|RESOURCE_|CALLER_|NOTIFY_)/.test(code.id) || category === 'REMINDER' && /^(EVENT_|SESSION_|CALLER_)/.test(code.id) || category === 'RUNNER' && /^(QUOTA_|NO_ENABLED_|NO_SUITABLE_|CALLER_)/.test(code.id)).map(code=>code.id);
  command.errorCodes = [...new Set([...common, ...specific])];
  if (!command.examples?.length) {
    const args = ['raf', ...command.path];
    for (const parameter of command.parameters ?? []) {
      if (!parameter.required) continue;
      args.push(parameter.option);
      if (parameter.type === 'boolean') continue;
      const values = command.valueSources?.[parameter.name] ? resolve(command.valueSources[parameter.name]) : undefined;
      const first = values?.find(value=>typeof value === 'string' || value.launchableByRaf !== false);
      args.push(quote(exampleValues[parameter.name] ?? (typeof first === 'string' ? first : first?.id) ?? 'example'));
    }
    command.examples = [args.join(' ')];
  }
  if (name === 'agent run') command.examples = ['raf agent run --id worker --type implement --project raf --features complete-raf-flow-contracts --phase implement --complexity ordinary --tasks complete-raf-flow-contracts:12.4'];
  if (command.errors === 'Ненульовий код і JSON із причиною, деталями та кроком виправлення.') command.errors = `Ненульовий код із errorCodes та JSON code/message/details/remediation. За часткового виконання перевірте completed/pending і retrySafe перед повтором; довідка: raf help ${name}.`;
}
const operations = [{op:'add',path:'/errorCodes',value:constants.errorCodes}, ...constants.commands.flatMap((command,index)=>['prerequisites','sideEffects','output','errors','examples','errorCodes'].map(key=>({op:'add',path:`/commands/${index}/${key}`,value:command[key]})))];
fs.writeFileSync(new URL('./conf-raf-constants.patch.json', import.meta.url), JSON.stringify({source, sourceSha256:createHash('sha256').update(original).digest('hex'), operations},null,2)+'\n');
fs.writeFileSync(new URL('./raf-constants.target.json', import.meta.url), JSON.stringify(constants,null,2)+'\n');
