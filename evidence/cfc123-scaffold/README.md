# complete-raf-flow-contracts:12.3

Підготовлено лише тести, інваріанти та каркас; `CatalogGenerator.compile` і
`CatalogGenerator.build` кидають `NotImplemented`. Реалізації генератора,
підключення production dispatch або зміни runtime-перемикачів немає.

## Контракт і аудит

Джерела: `openspec/changes/complete-raf-flow-contracts/tasks.md:12.3`,
delta `specs/projects/raf/cli-catalog/spec.md`, `cfc122-catalog-design.md` і
`cfc122-catalog.schema.json` у тій самій зміні. Правила стадії —
`add-raf-test-run/specs/core/process/feature-test-authoring/spec.md`, вимога
«Агент тестів і каркаса»; unit-профіль — delta projects/raf/test-runs цієї
залежності та core/process/unit-test-runs.

12.3 актуальний після 12.2: наявні `src/catalog.ts` та `src/bootstrap.ts`
виконують лише частину контракту, `scripts/build.ts` виводить handlerNames із
самого commands. Відсутня незалежна перевірка фактичних bindings, повна schema
та semantic validation і спільний зріз для валідаторів. Поточний conf не
проходить цільову схему через errorCodes; це відомий обсяг 12.4, тому unit
fixtures містять повні метадані й не залежать від поточного conf.

## Поверхня для 12.4

`src/catalog-generator.ts` задає джерела constants/models/projects, незалежні
lazy bindings із path/load, GeneratedCatalog із спільними snapshots та два
методи з повними сигнатурами. Це каркас для розширення наявного механізму
компіляції. Implement має підключити його до чинних build/parser/help та
валідаторів брифів/звітів/подій; другого runtime-компілятора не потрібно.
Fixtures використовують лише затверджені шляхи agent run, runner list, help.
Fixture IDs не є доповненням робочого каталогу.

## Відбір і передумови

Стабільна група для всіх наступних етапів:
`complete-raf-flow-contracts/catalog-generator`.
Точний файл: `test/catalog-generator.test.ts`, 42 unit cases.

Автор виконав одну просту команду:

```text
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/catalog-generator --files test/catalog-generator.test.ts
```

`conf-test-runs.patch.json` містить точні доповнення unitFiles/groups;
main повідомив про застосування комітом Orchestrator `f058f771f3` перед red.
Conf лежить поза межами запису виконавця й ним не змінювався.
Профіль `node`: cwd `.`, executable `node`, argv
`./scripts/test-run-node.ts`, exactIds `node-test-name`, resultAdapter
`node-test-events`, environment.isolatedHome/stateOrigin=true. Передумови:
перевірений raf-develop/develop, Node >=25.4, наявні
node_modules/typescript/package.json, src/test-run-reporter.ts та
scripts/test-run-node.ts, окремий перевірений QA HOME/state/tmp. Без install,
мережі, tmux, provider-даних або доступу до робочого стану.

## Інваріанти й сценарії

| IDs | Перевірка |
| --- | --- |
| S01–S02 | parser/help беруть усі id та метадані з одного джерела; перебудова оновлює agent/model/project/report/event snapshots, старі id відхиляються |
| S03 | Детермінізм, порядок complexityOrder, незмінність вхідного зрізу |
| S04 | Help без runtime, еквівалентні форми, help-only runner не створює option |
| S05 | JSON Pointer ~1/~0, збереження зовнішніх атрибутів |
| S06–S08 | Missing/duplicate незалежні bindings, explicit unavailable не завантажується під час компіляції |
| S09–S12 | Дублі path/id/name/option з обома точними pointers |
| S13–S21 | Нерозв'язне/небезпечне посилання, invalid escape, порожній/неоднорідний набір, duplicate external id, довільний project object та inherited node |
| S22–S25 | Default, typo valueSources, заборона прикладних enum/values усередині parameter |
| S26–S28 | Event idKind, status event та command errorCodes references |
| S29–S36 | Структурні відмови, обов'язкові метадані, syntax examples, boolean/default/multiple та зарезервований help |
| S37 | Повний детермінований artifact, читання чинним runCli, відсутність виклику lazy bindings |
| S38.schema/reference/binding/json | Відмова не змінює попередні bytes artifact; tmp-файли прибрано |
| S39 | Зміни source не впливають на parser/help до успішної перебудови |

Позитивні сценарії вимагають успішної компіляції, негативні перевіряють
предметний pointer/reference: довільний виняток не задовольняє тест.
S08 перевіряє приймання явного unavailable binding, а не runtime-реалізацію
COMMAND_UNAVAILABLE; production dispatch і живий CLI перевірятимуться 12.4/12.5.
Unit disk fixtures приватні, локальні, видаляються через t.after.

## Результат та межі

`author-run.json` фіксує команду й окремі CLI/child exit 1/1. RunId
`ad7c370f-6897-44fc-92ad-55e3dff5a75f`: assertions-failed, 42 knownRed,
0 passed, unknown/unexecuted порожні, 749 ms, timedOut=false,
cleanup.complete=true, timeoutCount=0, nextAction=implement.
Усі видимі diagnostics — ERR_ASSERTION на відсутній compile/build або
очікувану адресну відмову замість NotImplemented. Setup/import failure немає.
Main має перевірити цільову природу red перед передачею незалежному implement.

Інструмент обрізав stdout; у брифі немає full-result-delivery root/manifest.
Повний TestRunResult запитано в main без повторного прогону чи читання SQLite
виконавцем. Main відповів: «Повного TestRunResult окремо raf не зберігає
(питання Q97 до власника ще без відповіді), тож передати файл не можу і SQLite
не дам». Його наступна вказівка: «Запиши це підсумком у evidence (без повтору
прогону) і заверши звіт; підтвердження red main робить за записом raf цього
runId». За цією явною вказівкою передано чесний підсумок, повного JSON немає.
Відсутні початкові stdout/stderr не називаються збереженими байтами.

Reflog визначає HEAD на startedAt 12:17:31 як
`3203c14e33a5c95d3a96486b441a4b7b8bad01f2`; сусідній коміт `76500147...`
створено о 12:17:35 після завершення red. Власний scaffold
`baa1d51cb797be7c5fb4f545675cce087c2b6da8` входить у цей HEAD.
Дерево було спільним і мало чужі незакомічені правки; точний status на саму
мілісекунду spawn не збережено. Відомі змінені сусідні шляхи — у
`author-run.json`; власні test/scaffold збігалися з комітом.

Статична перевірка синтаксису обох нових TypeScript файлів через
transpileModule та `node scripts/check-comments.ts` — без помилок.
Strict typecheck у репозиторії не налаштований: немає @types/node;
його проба не є unit setup failure або продуктовим red.
Галочки tasks.md лишено raf; 12.4/12.5 та інші пункти відкриті, архівація
не виконується. Чужі незакомічені зміни у спільному дереві не комітяться.
